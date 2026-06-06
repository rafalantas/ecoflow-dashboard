const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const mqtt      = require('mqtt');
const path      = require('path');
const crypto    = require('crypto');
const axios     = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT          || 8080;
const DEVICE_SN  = process.env.DEVICE_SN     || '';
const ACCESS_KEY = process.env.EF_ACCESS_KEY || '';
const SECRET_KEY = process.env.EF_SECRET_KEY || '';
const EF_EMAIL   = process.env.EF_EMAIL      || '';
const EF_PASSWORD= process.env.EF_PASSWORD   || '';
const SPACE_ID   = process.env.EF_SPACE_ID   || '2042460095875207170';
const METER_SN   = process.env.METER_SN      || '';
const API_HOST   = 'https://api-e.ecoflow.com';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function hmacSign(params = {}) {
  const nonce = String(100000 + Math.floor(Math.random() * 900000));
  const timestamp = String(Date.now());
  const items = Object.entries({ ...params, accessKey: ACCESS_KEY, nonce, timestamp })
    .sort(([a], [b]) => a.localeCompare(b));
  const signStr = items.map(([k, v]) => `${k}=${v}`).join('&');
  const sign = crypto.createHmac('sha256', SECRET_KEY).update(signStr).digest('hex');
  return { 'Content-Type': 'application/json', accessKey: ACCESS_KEY, nonce, timestamp, sign };
}

function md5Sign(token) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const timestamp = String(Date.now());
  const sign = crypto.createHash('md5').update(`nonce=${nonce}&timestamp=${timestamp}`).digest('hex');
  return {
    'Authorization': `Bearer ${token}`, 'lang': 'en_US',
    'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sign': sign,
    'X-Appid': '9', 'platform': 'android', 'version': '6.10.5',
    'content-type': 'application/json',
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
let deviceState = {
  connected: false, lastUpdate: null, lastMqttData: null,
  // PV
  pv1Power: 0, pv2Power: 0, pv3Power: 0, pv4Power: 0, pvTotal: 0,
  pv1Vol: 0, pv2Vol: 0, pv3Vol: 0, pv4Vol: 0,
  pv1Amp: 0, pv2Amp: 0, pv3Amp: 0, pv4Amp: 0,
  pv1Active: false, pv2Active: false, pv3Active: false, pv4Active: false,
  // Bateria
  soc: 0, socExact: 0, battPower: 0,
  chgRemTime: 0, dsgRemTime: 0,
  chgDsgState: 0, // 0=idle 1=dsg 2=chg
  cellTemp: [], cellVol: [], maxCellTemp: 0, minCellTemp: 0,
  // Sieć
  gridPower: 0, gridVol: 0, gridFreq: 0,
  feedPower: 0, fromGrid: 0, gridStatus: '',
  // Zużycie
  sysLoad: 0, loadFromPv: 0, loadFromGrid: 0, loadFromBat: 0,
  // Bateria - zdrowie
  battSoh: 100, battCycles: 0, accuChgEnergy: 0, accuDsgEnergy: 0,
  // Inne
  invTemp: 0, maxChgSoc: 95, minDsgSoc: 20,
  // Licznik
  meterL1: 0, meterL2: 0, meterL3: 0, meterTotal: 0,
  meterTodayImport: 0, meterTodayExport: 0,
  meterTotalImport: 0, meterTotalExport: 0,
};

// Historia real-time sesji
let history = { pv: [], feed: [], soc: [], ts: [] };
const MAX_HIST = 300;

// Snapshoty godzinowe do wykresu dziennego
let dailySnapshots = {};

// Cache energii
let energyCache = {};

// Token prywatnego API
let privateToken = null;
let tokenExpiry = 0;

// ─── Server ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('/api/state',   (_, res) => res.json(deviceState));
app.get('/api/history', (_, res) => res.json(history));

app.get('/api/energy', async (req, res) => {
  const period  = req.query.period || 'day';
  const today   = new Date().toISOString().slice(0, 10);
  const refDate = req.query.date || today;
  const cacheKey = `${period}:${refDate}`;
  if (refDate !== today && energyCache[cacheKey] && Date.now() - energyCache[cacheKey].fetchedAt < 3600000) {
    return res.json(energyCache[cacheKey]);
  }
  try {
    const data = await fetchEnergyForPeriod(period, refDate);
    if (data) {
      energyCache[cacheKey] = { ...data, fetchedAt: Date.now() };
      return res.json(energyCache[cacheKey]);
    }
    res.json({ error: 'no_data' });
  } catch(e) { res.json({ error: e.message }); }
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── MQTT timeout ─────────────────────────────────────────────────────────────
const MQTT_TIMEOUT = 5 * 60 * 1000;
setInterval(() => {
  if (deviceState.connected && deviceState.lastMqttData) {
    if (Date.now() - deviceState.lastMqttData > MQTT_TIMEOUT) {
      deviceState.connected = false;
      broadcast({ type: 'status', connected: false });
      console.log('⚠️  MQTT timeout — offline');
    }
  }
}, 60000);

// ─── History ──────────────────────────────────────────────────────────────────
function recordHistory() {
  history.ts.push(new Date().toISOString());
  history.pv.push(deviceState.pvTotal);
  history.feed.push(deviceState.feedPower);
  history.soc.push(deviceState.soc);
  if (history.ts.length > MAX_HIST) {
    ['ts','pv','feed','soc'].forEach(k => history[k].shift());
  }
}

// ─── Daily snapshots ──────────────────────────────────────────────────────────
function recordSnapshot(date, totalWh) {
  if (!dailySnapshots[date]) dailySnapshots[date] = [];
  const snaps = dailySnapshots[date];
  const last = snaps[snaps.length - 1];
  if (!last || last.wh !== totalWh) snaps.push({ ts: Date.now(), wh: totalWh });
}

function buildHourlyChart(date) {
  const snaps = dailySnapshots[date];
  if (!snaps || snaps.length < 2) return [];
  const byHour = {};
  snaps.forEach(s => { byHour[new Date(s.ts).getHours()] = s.wh; });
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  if (hours.length < 2) return [];
  return hours.slice(1).map((h, i) => {
    const diff = byHour[h] - byHour[hours[i]];
    return diff > 0 ? { time: `${date} ${String(hours[i]).padStart(2,'0')}:00:00`, wh: Math.round(diff) } : null;
  }).filter(Boolean);
}

// ─── Apply Meter params ──────────────────────────────────────────────────────
function applyMeterParams(params) {
  let updated = false;
  const r1 = v => Math.round(v * 10) / 10;

  if (params.gridConnectionPowerL1 !== undefined) { deviceState.meterL1 = r1(params.gridConnectionPowerL1); updated = true; }
  if (params.gridConnectionPowerL2 !== undefined) { deviceState.meterL2 = r1(params.gridConnectionPowerL2); updated = true; }
  if (params.gridConnectionPowerL3 !== undefined) { deviceState.meterL3 = r1(params.gridConnectionPowerL3); updated = true; }
  if (params.powGetSysGrid !== undefined)         { deviceState.meterTotal = r1(params.powGetSysGrid); updated = true; }

  if (params.gridConnectionDataRecord) {
    const rec = params.gridConnectionDataRecord;
    // todayActive = net import (moze byc ujemny eksport)
    if (rec.todayActive != null) {
      deviceState.meterTodayImport = Math.max(0, Math.round(rec.todayActive));
    }
    if (rec.totalActiveEnergy != null) {
      deviceState.meterTotalImport = Math.max(0, Math.round(rec.totalActiveEnergy));
    }
    // Eksport = suma ujemnych wartosci faz
    const l1 = rec.todayActiveL1 || 0;
    const l2 = rec.todayActiveL2 || 0;
    const l3 = rec.todayActiveL3 || 0;
    const exportWh = Math.abs(Math.min(0, l1)) + Math.abs(Math.min(0, l2)) + Math.abs(Math.min(0, l3));
    if (exportWh > 0) deviceState.meterTodayExport = Math.round(exportWh);
    // totalReactiveEnergy moze byc eksport
    if (rec.totalReactiveEnergy != null && rec.totalReactiveEnergy > 0) {
      deviceState.meterTotalExport = Math.round(rec.totalReactiveEnergy);
    }
    updated = true;
  }

  if (updated) {
    deviceState.fromGrid  = deviceState.meterTotal;
    deviceState.lastMqttData = Date.now();
    broadcast({ type: 'state', data: deviceState });
  }
}

// ─── Apply MQTT params ────────────────────────────────────────────────────────
function applyParams(params) {
  let updated = false;
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;

  const set = (key, field, fn = r1) => {
    if (params[key] !== undefined && params[key] !== null) {
      const val = fn(params[key]);
      if (deviceState[field] !== val) { deviceState[field] = val; updated = true; }
    }
  };

  // PV
  set('powGetPv',   'pv1Power'); set('powGetPv2',  'pv2Power');
  set('powGetPv3',  'pv3Power'); set('powGetPv4',  'pv4Power');
  set('powGetPvSum','pvTotal');
  set('plugInInfoPvVol',  'pv1Vol'); set('plugInInfoPv2Vol', 'pv2Vol');
  set('plugInInfoPv3Vol', 'pv3Vol'); set('plugInInfoPv4Vol', 'pv4Vol');
  set('plugInInfoPvAmp',  'pv1Amp', r2); set('plugInInfoPv2Amp', 'pv2Amp', r2);
  set('plugInInfoPv3Amp', 'pv3Amp', r2); set('plugInInfoPv4Amp', 'pv4Amp', r2);
  if (params.plugInInfoPvFlag  !== undefined) { deviceState.pv1Active = !!params.plugInInfoPvFlag;  updated = true; }
  if (params.plugInInfoPv2Flag !== undefined) { deviceState.pv2Active = !!params.plugInInfoPv2Flag; updated = true; }
  if (params.plugInInfoPv3Flag !== undefined) { deviceState.pv3Active = !!params.plugInInfoPv3Flag; updated = true; }
  if (params.plugInInfoPv4Flag !== undefined) { deviceState.pv4Active = !!params.plugInInfoPv4Flag; updated = true; }

  // Bateria
  set('bmsBattSoc',   'soc',      v => Math.round(v));
  set('f32ShowSoc',   'socExact', r1);
  set('powGetBpCms',  'battPower', r1);
  set('cmsChgRemTime','chgRemTime', v => v);
  set('cmsDsgRemTime','dsgRemTime', v => v);
  set('bmsChgDsgState','chgDsgState', v => v);
  set('bmsMaxCellTemp','maxCellTemp', v => v);
  set('bmsMinCellTemp','minCellTemp', v => v);
  if (params.cellTemp) { deviceState.cellTemp = params.cellTemp; updated = true; }
  if (params.cellVol)  { deviceState.cellVol  = params.cellVol;  updated = true; }

  // Sieć
  set('gridConnectionVol',  'gridVol',  r1);
  set('gridConnectionFreq', 'gridFreq', r2);
  if (params.gridConnectionSta !== undefined) { deviceState.gridStatus = params.gridConnectionSta; updated = true; }
  if (params.gridConnectionPower !== undefined) {
    const g = params.gridConnectionPower;
    deviceState.feedPower = g > 0 ? r1(g) : 0;
    deviceState.fromGrid  = g < 0 ? r1(Math.abs(g)) : 0;
    deviceState.gridPower = r1(g);
    updated = true;
  }
  // Fallback - sysGridConnectionPower lub powGetSysGrid
  if (params.sysGridConnectionPower !== undefined && params.gridConnectionPower === undefined) {
    const g = params.sysGridConnectionPower;
    deviceState.feedPower = g > 0 ? r1(g) : 0;
    deviceState.fromGrid  = g < 0 ? r1(Math.abs(g)) : 0;
    deviceState.gridPower = r1(g);
    updated = true;
  }
  if (params.powGetSysGrid !== undefined && params.gridConnectionPower === undefined) {
    // powGetSysGrid = pobor z sieci (zawsze dodatni)
    deviceState.fromGrid  = r1(params.powGetSysGrid);
    deviceState.gridPower = -r1(params.powGetSysGrid);
    updated = true;
  }

  // Zużycie
  set('powGetSysLoad',         'sysLoad',     r1);
  set('powGetSysLoadFromPv',   'loadFromPv',  r1);
  set('powGetSysLoadFromGrid', 'loadFromGrid',r1);
  set('powGetSysLoadFromBp',   'loadFromBat', r1);
  set('sysGridConnectionPower','feedPower',   r1);

  // Aktualizuj fromGrid z loadFromGrid gdy gridConnectionPower nie przychodzi
  if (params.powGetSysLoadFromGrid !== undefined && params.gridConnectionPower === undefined) {
    deviceState.fromGrid = r1(params.powGetSysLoadFromGrid);
    updated = true;
  }

  // Bateria - zdrowie i statystyki
  set('bmsBattSoh',    'battSoh',       v => Math.round(v * 10) / 10);
  set('cycles',        'battCycles',    v => v);
  set('accuChgEnergy', 'accuChgEnergy', v => v);
  set('accuDsgEnergy', 'accuDsgEnergy', v => v);
  // Inne
  set('invTempNtc',   'invTemp', v => v);
  set('cmsMaxChgSoc', 'maxChgSoc', v => v);
  set('cmsMinDsgSoc', 'minDsgSoc', v => v);

  if (updated) {
    deviceState.lastUpdate   = new Date().toISOString();
    deviceState.lastMqttData = Date.now();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
    console.log(`☀️  PV=${deviceState.pvTotal}W | BAT=${deviceState.soc}% ${deviceState.chgDsgState===2?'↑':'↓'} ${Math.round(Math.abs(deviceState.battPower))}W | GRID=${deviceState.feedPower>0?'+':''}${deviceState.gridPower.toFixed(0)}W`);
  }
}

// ─── Private API ──────────────────────────────────────────────────────────────
async function loginPrivateApi() {
  if (!EF_EMAIL || !EF_PASSWORD) return false;
  try {
    const pwdB64 = Buffer.from(EF_PASSWORD).toString('base64');
    const resp = await axios.post(`${API_HOST}/auth/login`, {
      email: EF_EMAIL, password: pwdB64, scene: 'IOT_APP', userType: 'ECOFLOW',
    }, { headers: { 'lang': 'en_US', 'content-type': 'application/json' }, timeout: 10000 });
    if (resp.data.code === '0' && resp.data.data?.token) {
      privateToken = resp.data.data.token;
      tokenExpiry  = Date.now() + 25 * 24 * 3600 * 1000;
      console.log('✅ Login EcoFlow OK');
      return true;
    }
    return false;
  } catch(e) { console.error('❌ Login:', e.message); return false; }
}

async function ensureToken() {
  if (!privateToken || Date.now() > tokenExpiry) return loginPrivateApi();
  return true;
}

async function privatePost(url, body) {
  if (!await ensureToken()) return null;
  try {
    const resp = await axios.post(`${API_HOST}${url}`, body,
      { headers: md5Sign(privateToken), timeout: 10000 });
    return resp.data;
  } catch(e) { console.error(`❌ API ${url}:`, e.message); return null; }
}

// ─── Energy API ───────────────────────────────────────────────────────────────
const VALUE_CODES = {
  day:   'SPACE-APP-SOLAR-ENERGY-VALUE-DAY',
  week:  'SPACE-APP-SOLAR-ENERGY-VALUE-WEEK',
  month: 'SPACE-APP-SOLAR-ENERGY-VALUE-MONTH',
  year:  'SPACE-APP-SOLAR-ENERGY-VALUE-YEAR',
};
const BAR_CODES = {
  day:   'SPACE-APP-SOLAR-ENERGY-BAR-DAY',
  week:  'SPACE-APP-SOLAR-ENERGY-BAR-WEEK',
  month: 'SPACE-APP-SOLAR-ENERGY-BAR-MONTH',
  year:  'SPACE-APP-SOLAR-ENERGY-BAR-YEAR',
};

function getDateRange(period, refDate) {
  const d = new Date(refDate + 'T12:00:00');
  const fmt = d => d.toISOString().slice(0,10);
  if (period === 'day')   return { begin: refDate, end: refDate, label: d.toLocaleDateString('pl-PL', {day:'numeric',month:'long',year:'numeric'}) };
  if (period === 'week')  {
    const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    return { begin: fmt(sun), end: fmt(sat), label: `${fmt(sun).slice(5).replace('-','.')} – ${fmt(sat).slice(5).replace('-','.')} ${sat.getFullYear()}` };
  }
  if (period === 'month') {
    const begin = refDate.slice(0,7) + '-01';
    const end   = new Date(d.getFullYear(), d.getMonth()+1, 0).toISOString().slice(0,10);
    return { begin, end, label: d.toLocaleDateString('pl-PL', {month:'long', year:'numeric'}) };
  }
  const begin = `${d.getFullYear()}-01-01`, end = `${d.getFullYear()}-12-31`;
  return { begin, end, label: String(d.getFullYear()) };
}

async function fetchEnergyForPeriod(period, refDate) {
  if (!SPACE_ID || !privateToken) return null;
  const range = getDateRange(period, refDate);
  const out   = { period, label: range.label, begin: range.begin, end: range.end };

  const callEnergy = async (code) => {
    const r = await privatePost('/app/space/data/single/index/', {
      code, spaceId: SPACE_ID, params: { beginTime: range.begin, endTime: range.end },
    });
    return (r?.code === '0' && Array.isArray(r.data)) ? r.data : null;
  };

  // Zużycie domu kWh
  const loadCode = VALUE_CODES[period].replace('SOLAR-ENERGY', 'LOAD-ENERGY');
  const ld = await callEnergy(loadCode);
  if (ld) {
    const m = ld.find(d => d.indexName === 'master_data');
    out.loadKwh = m?.indexValue != null ? Math.round(m.indexValue) / 1000 : null;
  }

  // Łączna produkcja kWh
  const vd = await callEnergy(VALUE_CODES[period]);
  if (vd) {
    const m = vd.find(d => d.indexName === 'master_data');
    const s = vd.find(d => d.indexName === 'sup_data');
    out.totalKwh     = m?.indexValue != null ? Math.round(m.indexValue) / 1000 : null;
    out.changePercent= s?.indexValue != null ? Math.round(s.indexValue * 10) / 10 : null;
    if (period === 'day' && m?.indexValue != null) recordSnapshot(range.begin, Math.round(m.indexValue));
  }

  // Wykres słupkowy
  const bd = await callEnergy(BAR_CODES[period]);
  if (bd && bd.length > 0) {
    out.chart = bd.filter(d => d.indexName === 'chart_data' && d.time)
      .map(d => ({ time: d.time, wh: Math.round(d.indexValue || 0) }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  // Fallback dzienny z snapshots
  if (period === 'day' && (!out.chart || out.chart.length <= 1)) {
    const hc = buildHourlyChart(range.begin);
    if (hc.length > 0) out.chart = hc;
  }

  // Zyski
  const earningsCode = period === 'year' ? 'SPACE-APP-EARNINGS-MONEY-VALUE-YEAR' : 'SPACE-APP-EARNINGS-MONEY-VALUE-MONTH';
  const mBegin = range.begin.slice(0,7) + '-01';
  const ed = await privatePost('/app/space/data/single/index/', {
    code: earningsCode, spaceId: SPACE_ID,
    params: { beginTime: period === 'year' ? range.begin : mBegin, endTime: range.end },
  });
  if (ed?.code === '0' && Array.isArray(ed.data)) {
    const m = ed.data.find(d => d.indexName === 'master_data');
    if (m?.indexValue != null) {
      const monthEarnings = Math.round(m.indexValue * 100) / 100;
      out.currency = (m.unit && m.unit !== '$' && m.unit !== '€') ? m.unit : 'zł';
      if (period === 'day' || period === 'week') {
        const mResp = await privatePost('/app/space/data/single/index/', {
          code: 'SPACE-APP-SOLAR-ENERGY-VALUE-MONTH', spaceId: SPACE_ID,
          params: { beginTime: mBegin, endTime: range.end },
        });
        const mWh = (mResp?.code === '0' && Array.isArray(mResp.data))
          ? (mResp.data.find(d => d.indexName === 'master_data')?.indexValue || 0) : 0;
        out.earnings = (mWh > 0 && out.totalKwh > 0)
          ? Math.round(monthEarnings * out.totalKwh / (mWh/1000) * 100) / 100 : null;
        out.earningsMonth = monthEarnings;
      } else { out.earnings = monthEarnings; }
    }
  }

  // Efektywność
  if (period !== 'year') {
    if (period === 'day') {
      const rs = await privatePost('/iot-service/index/common/query', {
        code: 'BK62x-APP-efficiency-SOLAR-ENERGY-FLOW-MONTH-Sup_DATA',
        params: { spaceId: SPACE_ID, sn: DEVICE_SN, beginTime: range.begin, endTime: range.end, timezone: 'Europe/Warsaw' },
      });
      if (rs?.code === '0' && Array.isArray(rs.data)) {
        const master = rs.data.find(d => d.indexName === 'master_data');
        out.efficiency = master?.indexValue != null ? Math.round(master.indexValue * 10) / 10 : null;
      }
    } else {
      const periodKey = period === 'week' ? 'WEEK' : 'MONTH';
      const rs = await privatePost('/iot-service/index/common/query', {
        code: `BK62x-APP-efficiency-SOLAR-ENERGY-FLOW-${periodKey}-Sup_DATA`,
        params: { spaceId: SPACE_ID, sn: DEVICE_SN, beginTime: range.begin, endTime: range.end, timezone: 'Europe/Warsaw' },
      });
      if (rs?.code === '0' && Array.isArray(rs.data)) {
        const master = rs.data.find(d => d.indexName === 'master_data');
        const sup    = rs.data.find(d => d.indexName === 'sup_data');
        out.efficiency       = master?.indexValue != null ? Math.round(master.indexValue * 10) / 10 : null;
        out.efficiencyChange = sup?.indexValue    != null ? Math.round(sup.indexValue * 10)    / 10 : null;
      }
      const rc = await privatePost('/iot-service/index/common/query', {
        code: `BK62x-APP-efficiency-SOLAR-ENERGY-FLOW-${periodKey}-Chart_DATA`,
        params: { spaceId: SPACE_ID, sn: DEVICE_SN, beginTime: range.begin, endTime: range.end, timezone: 'Europe/Warsaw' },
      });
      if (rc?.code === '0' && Array.isArray(rc.data)) {
        out.efficiencyChart = rc.data
          .filter(d => d.indexName === 'chart_data' && d.time && d.indexValue != null)
          .map(d => ({ time: d.time, pct: Math.round(d.indexValue * 10) / 10 }))
          .sort((a, b) => a.time.localeCompare(b.time));
      }
    }
  }

  return out;
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
async function startMqtt() {
  if (!ACCESS_KEY || !SECRET_KEY) { startDemo(); return; }

  let creds;
  try {
    const resp = await axios.get(`${API_HOST}/iot-open/sign/certification`,
      { headers: hmacSign(), timeout: 10000 });
    if (resp.data.code !== '0') throw new Error(resp.data.message);
    creds = resp.data.data;
    console.log(`✅ MQTT OK — ${creds.certificateAccount}`);
  } catch(e) { console.error('❌ Creds:', e.message); setTimeout(startMqtt, 30000); return; }

  const client = mqtt.connect(`mqtts://${creds.url}:${creds.port}`, {
    clientId: `open-${uuidv4()}`,
    username: creds.certificateAccount,
    password: creds.certificatePassword,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
  });

  const quotaTopic  = `/open/${creds.certificateAccount}/${DEVICE_SN}/quota`;
  const statusTopic = `/open/${creds.certificateAccount}/${DEVICE_SN}/status`;
  const meterTopic  = METER_SN ? `/open/${creds.certificateAccount}/${METER_SN}/quota` : null;

  client.on('connect', () => {
    console.log('✅ MQTT połączony!');
    deviceState.connected = true;
    broadcast({ type: 'status', connected: true });
    client.subscribe(quotaTopic);
    client.subscribe(statusTopic);
    if (meterTopic) { client.subscribe(meterTopic); console.log('📊 Licznik: ' + METER_SN); }
    // Pobierz wszystkie quota natychmiast i ponow po 3s
    const fetchQuota = async () => {
      try {
        // Sprobuj quota/all
        const r = await axios.get(`${API_HOST}/iot-open/sign/device/quota/all`,
          { headers: hmacSign({ sn: DEVICE_SN }), params: { sn: DEVICE_SN }, timeout: 10000 });
        if (r.data.data && Object.keys(r.data.data).length > 0) {
          applyParams(r.data.data);
          console.log('Quota zaladowane: ' + Object.keys(r.data.data).length + ' parametrow');
          return true;
        }
        // Fallback: zapytaj o konkretne pola
        const fields = ['bmsBattSoc','f32ShowSoc','powGetPvSum','powGetPv3','powGetPv4',
          'gridConnectionPower','sysGridConnectionPower','powGetSysLoadFromGrid',
          'powGetSysLoad','bmsChgDsgState','powGetBpCms','cmsChgRemTime','cmsDsgRemTime',
          'gridConnectionVol','gridConnectionFreq','bmsMaxCellTemp','bmsMinCellTemp',
          'bmsBattSoh','cycles','accuChgEnergy','accuDsgEnergy','plugInInfoPv3Flag',
          'plugInInfoPv4Flag','plugInInfoPv3Vol','plugInInfoPv4Vol','cmsMaxChgSoc','cmsMinDsgSoc'];
        const r2 = await axios.post(`${API_HOST}/iot-open/sign/device/quota`,
          { sn: DEVICE_SN, params: fields },
          { headers: hmacSign(), timeout: 10000 });
        if (r2.data.data && Object.keys(r2.data.data).length > 0) {
          applyParams(r2.data.data);
          console.log('Quota (fields) zaladowane: ' + Object.keys(r2.data.data).length + ' parametrow');
          return true;
        }
      } catch(e) { console.error('Quota error:', e.message); }
      return false;
    };
    fetchQuota().then(ok => { if (!ok) setTimeout(fetchQuota, 3000); });
    // Odswiezaj quota co 30s
    setInterval(fetchQuota, 30000);
  });

  client.on('message', (topic, payload) => {
    try {
      const str = payload.toString('utf8');
      if (!str.startsWith('{')) return;
      const data = JSON.parse(str);
      if (topic.endsWith('/status')) {
        deviceState.connected = data.params?.status === 1;
        broadcast({ type: 'status', connected: deviceState.connected });
        return;
      }
      const params = data.params || data;
      if (!params || typeof params !== 'object') return;
      // Rozrozniaj licznik od Stream X
      if (meterTopic && topic === meterTopic) {
        applyMeterParams(params);
      } else {
        applyParams(params);
      }
    } catch(e) {}
  });

  client.on('error', e => console.error('MQTT error:', e.message));
  client.on('close', () => {
    deviceState.connected = false;
    broadcast({ type: 'status', connected: false });
  });
}

function startDemo() {
  console.log('🎭 Demo mode');
  let t = 0, soc = 45;
  setInterval(() => {
    t += 0.05;
    const pv = Math.max(0, 800 + 400*Math.sin(t) + Math.random()*20);
    soc = Math.min(95, soc + 0.01);
    applyParams({
      powGetPvSum: pv, powGetPv3: pv*0.52, powGetPv4: pv*0.48,
      plugInInfoPv3Flag: true, plugInInfoPv4Flag: true,
      gridConnectionPower: pv > 200 ? 100 : -50,
      bmsBattSoc: soc, f32ShowSoc: soc,
      powGetBpCms: pv > 200 ? 200 : -100,
      bmsChgDsgState: pv > 200 ? 2 : 1,
      cmsChgRemTime: 120, cmsDsgRemTime: 300,
      gridConnectionVol: 230, gridConnectionFreq: 50,
      powGetSysLoad: 300, powGetSysLoadFromPv: Math.min(pv, 300),
      powGetSysLoadFromGrid: Math.max(0, 300-pv),
      invTempNtc: 35, bmsMaxCellTemp: 25,
    });
  }, 2000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`🚀 http://localhost:${PORT}  SN:${DEVICE_SN}  Email:${EF_EMAIL||'brak'}  SpaceID:${SPACE_ID}`);

  startMqtt();

  if (EF_EMAIL && EF_PASSWORD) {
    await loginPrivateApi();
    const today = new Date().toISOString().slice(0,10);
    const autoRefresh = async () => {
      try {
        const data = await fetchEnergyForPeriod('day', today);
        if (data) {
          energyCache[`day:${today}`] = { ...data, fetchedAt: Date.now() };
          console.log(`Auto-refresh: ${data.totalKwh||0} kWh, snapshots: ${dailySnapshots[today]?.length||0}`);
          broadcast({ type: 'energy', data });
        }
      } catch(e) {}
    };
    setTimeout(async () => { await autoRefresh(); setInterval(autoRefresh, 5*60*1000); }, 10000);
  }
});
