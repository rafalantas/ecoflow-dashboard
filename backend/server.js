const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const mqtt      = require('mqtt');
const path      = require('path');
const crypto    = require('crypto');
const axios     = require('axios');

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function flattenKeys(obj, prefix = '') {
  let res = {};
  for (const k of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      res = { ...res, ...flattenKeys(obj[k], fullKey) };
    } else { res[fullKey] = obj[k]; }
  }
  return res;
}

function makeSignedHeaders(accessKey, secretKey, bodyParams = {}) {
  const nonce = String(100000 + Math.floor(Math.random() * 100000));
  const timestamp = String(Date.now());
  let dataStr = '';
  if (Object.keys(bodyParams).length > 0) {
    const flat = flattenKeys(bodyParams);
    dataStr = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join('&') + '&';
  }
  const sigStr = `${dataStr}accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const sign = crypto.createHmac('sha256', secretKey).update(sigStr).digest('hex');
  return { 'Content-Type': 'application/json;charset=UTF-8', accessKey, nonce, timestamp, sign };
}

function makePrivateHeaders(token) {
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

async function ecoflowGet(url, queryParams = {}) {
  const headers = makeSignedHeaders(ACCESS_KEY, SECRET_KEY, {});
  const qs = Object.keys(queryParams).length > 0
    ? '?' + Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const resp = await axios.get(`${API_HOST}${url}${qs}`, { headers, timeout: 10000 });
  return resp.data;
}

const PORT        = process.env.PORT           || 8080;
const DEVICE_SN   = process.env.DEVICE_SN      || '';
const ACCESS_KEY  = process.env.EF_ACCESS_KEY   || '';
const SECRET_KEY  = process.env.EF_SECRET_KEY   || '';
const EF_EMAIL    = process.env.EF_EMAIL        || '';
const EF_PASSWORD = process.env.EF_PASSWORD     || '';
const SPACE_ID    = process.env.EF_SPACE_ID     || '2042460095875207170';
const API_HOST    = 'https://api-e.ecoflow.com';
let   mainSn      = DEVICE_SN;

let deviceState = {
  connected: false, lastUpdate: null,
  pv1Power: 0, pv2Power: 0, pvPower: 0,
  feedPower: 0, fromGrid: 0, gridPower: 0,
  acVoltage: 0, acFreq: 0, acCurrent: 0,
  pv1Voltage: 0, pv2Voltage: 0, pv1Current: 0, pv2Current: 0,
  invTemp: 0, gridStatus: '',
};
let history = { feed: [], pv1: [], pv2: [], timestamps: [] };
const MAX_HISTORY = 300;

let energyCache = {};
let privateToken = null;
let tokenExpiry = 0;

const app     = express();
const server  = http.createServer(app);
const WSServer = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('/api/state',   (req, res) => res.json(deviceState));
app.get('/api/history', (req, res) => res.json(history));

// Endpoint historii energii: /api/energy?period=day&date=2026-04-15
app.get('/api/energy', async (req, res) => {
  const { period = 'day', date } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const refDate = date || today;
  const cacheKey = `${period}:${refDate}`;
  // Cache 1h dla historycznych, 10min dla dzisiejszych
  const cacheTTL = refDate === today ? 10 * 60 * 1000 : 60 * 60 * 1000;
  if (energyCache[cacheKey] && (Date.now() - energyCache[cacheKey].fetchedAt < cacheTTL)) {
    return res.json(energyCache[cacheKey]);
  }
  try {
    const data = await fetchEnergyForPeriod(period, refDate);
    if (data) { energyCache[cacheKey] = { ...data, fetchedAt: Date.now() }; return res.json(energyCache[cacheKey]); }
    res.json({ error: 'no_data' });
  } catch(e) { res.json({ error: e.message }); }
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  WSServer.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function recordHistory() {
  history.timestamps.push(new Date().toISOString());
  history.feed.push(deviceState.feedPower);
  history.pv1.push(deviceState.pv1Power);
  history.pv2.push(deviceState.pv2Power);
  if (history.timestamps.length > MAX_HISTORY)
    ['timestamps','feed','pv1','pv2'].forEach(k => history[k].shift());
}

function applyParams(params) {
  let updated = false;
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;
  const set = (key, field, fn) => {
    if (params[key] !== undefined && params[key] !== null) {
      const val = fn(params[key]);
      if (deviceState[field] !== val) { deviceState[field] = val; updated = true; }
    }
  };
  set('powGetPv',            'pv1Power',   r1);
  set('powGetPv2',           'pv2Power',   r1);
  set('gridConnectionPower', 'gridPower',  r1);
  set('gridConnectionVol',   'acVoltage',  r1);
  set('gridConnectionFreq',  'acFreq',     r2);
  set('gridConnectionAmp',   'acCurrent',  r2);
  set('plugInInfoPvVol',     'pv1Voltage', r1);
  set('plugInInfoPv2Vol',    'pv2Voltage', r1);
  set('plugInInfoPvAmp',     'pv1Current', r2);
  set('plugInInfoPv2Amp',    'pv2Current', r2);
  set('invNtcTemp3',         'invTemp',    v => v);
  set('gridConnectionSta',   'gridStatus', v => v);
  if (params['powGetPv'] !== undefined || params['powGetPv2'] !== undefined) {
    deviceState.pvPower = r1((deviceState.pv1Power || 0) + (deviceState.pv2Power || 0));
    updated = true;
  }
  if (params['gridConnectionPower'] !== undefined) {
    const g = params['gridConnectionPower'];
    deviceState.feedPower = g > 0 ? r1(g) : 0;
    deviceState.fromGrid  = g < 0 ? r1(Math.abs(g)) : 0;
    updated = true;
  }
  if (updated) {
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
    console.log(`📊 pv1=${deviceState.pv1Power}W pv2=${deviceState.pv2Power}W feed=${deviceState.feedPower}W`);
  }
  return updated;
}

// ─── Prywatne API ─────────────────────────────────────────────────────────────

async function loginPrivateApi() {
  if (!EF_EMAIL || !EF_PASSWORD) return false;
  try {
    const pwdB64 = Buffer.from(EF_PASSWORD).toString('base64');
    const resp = await axios.post(`${API_HOST}/auth/login`,
      { email: EF_EMAIL, password: pwdB64, scene: 'IOT_APP', userType: 'ECOFLOW' },
      { headers: { 'lang': 'en_US', 'content-type': 'application/json' }, timeout: 10000 });
    if (resp.data.code === '0' && resp.data.data?.token) {
      privateToken = resp.data.data.token;
      tokenExpiry = Date.now() + 25 * 24 * 60 * 60 * 1000;
      console.log('✅ Login EcoFlow OK');
      return true;
    }
    console.error('❌ Login failed:', resp.data.message);
    return false;
  } catch(e) { console.error('❌ Login error:', e.message); return false; }
}

async function ensureToken() {
  if (!privateToken || Date.now() > tokenExpiry) return await loginPrivateApi();
  return true;
}

async function privatePost(url, body) {
  if (!await ensureToken()) return null;
  try {
    const resp = await axios.post(`${API_HOST}${url}`, body,
      { headers: makePrivateHeaders(privateToken), timeout: 10000 });
    return resp.data;
  } catch(e) { console.error(`❌ API ${url}:`, e.message); return null; }
}

// ─── Logika dat ───────────────────────────────────────────────────────────────

function dateStr(d) { return d.toISOString().slice(0, 10); }

function getPeriodRange(period, refDate) {
  const ref = refDate ? new Date(refDate + 'T12:00:00') : new Date();

  if (period === 'day') {
    const d = dateStr(ref);
    return { begin: d, end: d, label: ref.toLocaleDateString('pl-PL', {day:'numeric',month:'long',year:'numeric'}) };
  }
  if (period === 'week') {
    const dow = ref.getDay();
    const sun = new Date(ref); sun.setDate(ref.getDate() - dow);
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    const fmt = (d, opt) => d.toLocaleDateString('pl-PL', opt);
    return {
      begin: dateStr(sun), end: dateStr(sat),
      label: `${fmt(sun,{day:'numeric',month:'short'})} – ${fmt(sat,{day:'numeric',month:'short',year:'numeric'})}`
    };
  }
  if (period === 'month') {
    const y = ref.getFullYear(), m = ref.getMonth();
    const begin = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const end = dateStr(new Date(y, m+1, 0));
    return { begin, end, label: ref.toLocaleDateString('pl-PL', {month:'long',year:'numeric'}) };
  }
  if (period === 'year') {
    const y = ref.getFullYear();
    return { begin: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }
}

const VALUE_CODES = {
  day: 'SPACE-APP-SOLAR-ENERGY-VALUE-DAY',
  week: 'SPACE-APP-SOLAR-ENERGY-VALUE-WEEK',
  month: 'SPACE-APP-SOLAR-ENERGY-VALUE-MONTH',
  year: 'SPACE-APP-SOLAR-ENERGY-VALUE-YEAR',
};
const BAR_CODES = {
  day: 'SPACE-APP-SOLAR-ENERGY-BAR-DAY',
  week: 'SPACE-APP-SOLAR-ENERGY-BAR-WEEK',
  month: 'SPACE-APP-SOLAR-ENERGY-BAR-MONTH',
  year: 'SPACE-APP-SOLAR-ENERGY-BAR-YEAR',
};

async function fetchEnergyForPeriod(period, refDate) {
  if (!SPACE_ID || !EF_EMAIL) return null;
  const range = getPeriodRange(period, refDate);
  if (!range) return null;

  const callEnergy = async (code) => {
    const r = await privatePost('/app/space/data/single/index/', {
      code, spaceId: SPACE_ID,
      params: { beginTime: range.begin, endTime: range.end },
    });
    return (r?.code === '0' && Array.isArray(r.data)) ? r.data : null;
  };

  const out = { period, label: range.label, begin: range.begin, end: range.end };

  // Łączna produkcja kWh
  const vd = await callEnergy(VALUE_CODES[period]);
  if (vd) {
    const m = vd.find(d => d.indexName === 'master_data');
    const s = vd.find(d => d.indexName === 'sup_data');
    out.totalKwh = m?.indexValue != null ? Math.round(m.indexValue) / 1000 : null;
    out.changePercent = s?.indexValue != null ? Math.round(s.indexValue * 10) / 10 : null;
  }

  // Wykres słupkowy
  const bd = await callEnergy(BAR_CODES[period]);
  if (bd && bd.length > 0) {
    out.chart = bd
      .filter(d => d.indexName === 'chart_data' && d.time)
      .map(d => ({ time: d.time, wh: Math.round(d.indexValue || 0) }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  // Fallback dla dnia - BAR-DAY bywa pusty dla biezacego dnia
  // W tym przypadku pobieramy BAR-WEEK i szukamy wpisu dla danego dnia
  if (period === 'day' && (!out.chart || out.chart.length === 0)) {
    const refDt  = new Date(range.begin + 'T12:00:00');
    const dow    = refDt.getDay();
    const wStart = new Date(refDt); wStart.setDate(refDt.getDate() - dow);
    const wEnd   = new Date(wStart); wEnd.setDate(wStart.getDate() + 6);
    const wbd = await privatePost('/app/space/data/single/index/', {
      code: 'SPACE-APP-SOLAR-ENERGY-BAR-WEEK', spaceId: SPACE_ID,
      params: { beginTime: wStart.toISOString().slice(0,10), endTime: wEnd.toISOString().slice(0,10) },
    });
    if (wbd?.code === '0' && Array.isArray(wbd.data)) {
      const dayEntry = wbd.data.find(d => d.indexName === 'chart_data' && d.time === range.begin);
      if (dayEntry) out.chart = [{ time: range.begin, wh: Math.round(dayEntry.indexValue || 0) }];
    }
  }

  // Zyski
  const earningsCode = (period === 'year') ? 'SPACE-APP-EARNINGS-MONEY-VALUE-YEAR' : 'SPACE-APP-EARNINGS-MONEY-VALUE-MONTH';
  const monthBegin = range.begin.slice(0, 7) + '-01';
  const earningsBegin = (period === 'year') ? range.begin : monthBegin;
  const ed = await privatePost('/app/space/data/single/index/', {
    code: earningsCode, spaceId: SPACE_ID,
    params: { beginTime: earningsBegin, endTime: range.end },
  });
  if (ed?.code === '0' && Array.isArray(ed.data)) {
    const m = ed.data.find(d => d.indexName === 'master_data');
    if (m?.indexValue != null) {
      const monthEarnings = Math.round(m.indexValue * 100) / 100;
      out.currency = m.unit || 'zł';

      if (period === 'day' || period === 'week') {
        // Pobierz miesiezny kWh osobno zeby wyliczyc proporcje
        const mBegin = range.begin.slice(0, 7) + '-01';
        const mEnd   = range.end;
        const mResp  = await privatePost('/app/space/data/single/index/', {
          code: 'SPACE-APP-SOLAR-ENERGY-VALUE-MONTH', spaceId: SPACE_ID,
          params: { beginTime: mBegin, endTime: mEnd },
        });
        const mData   = (mResp?.code === '0' && Array.isArray(mResp.data)) ? mResp.data : [];
        const monthWh = mData.find(d => d.indexName === 'master_data')?.indexValue || 0;
        const monthKwh = monthWh / 1000;
        if (monthKwh > 0 && out.totalKwh != null && out.totalKwh > 0) {
          out.earnings = Math.round((monthEarnings * out.totalKwh / monthKwh) * 100) / 100;
        } else {
          out.earnings = null;
        }
        out.earningsMonth = monthEarnings;
      } else {
        out.earnings = monthEarnings;
      }
    }
  }

  // Efektywność produkcji (%)
  if (period !== 'year') {
    // Dla dnia uzywamy MONTH-Sup_DATA (tak jak aplikacja EcoFlow)
    // bo DAY-Sup_DATA nie ma danych dla biezacego dnia
    const supKey = period === 'day' ? 'MONTH' : period === 'week' ? 'WEEK' : 'MONTH';
    const chartKey = period === 'day' ? 'DAY' : period === 'week' ? 'WEEK' : 'MONTH';

    // Glowna wartosc efektywnosci + zmiana + pv1/pv2
    // Dla dnia: beginTime=today daje dzienna efektywnosc (26%), od poczatku miesiaca - miesieczna (68%)
    const rs = await privatePost('/iot-service/index/common/query', {
      code: `BK62x-APP-efficiency-SOLAR-ENERGY-FLOW-${supKey}-Sup_DATA`,
      params: { spaceId: SPACE_ID, sn: DEVICE_SN, beginTime: range.begin, endTime: range.end, timezone: 'Europe/Warsaw' },
    });
    if (rs?.code === '0' && Array.isArray(rs.data)) {
      const master = rs.data.find(d => d.indexName === 'master_data');
      const sup    = rs.data.find(d => d.indexName === 'sup_data');
      const pv1    = rs.data.find(d => d.indexName === 'pv1');
      const pv2    = rs.data.find(d => d.indexName === 'pv2');
      out.efficiency       = master?.indexValue != null ? Math.round(master.indexValue * 10) / 10 : null;
      out.efficiencyChange = sup?.indexValue    != null ? Math.round(sup.indexValue * 10)    / 10 : null;
      out.efficiencyPv1    = pv1?.indexValue    != null ? Math.round(pv1.indexValue * 10)    / 10 : null;
      out.efficiencyPv2    = pv2?.indexValue    != null ? Math.round(pv2.indexValue * 10)    / 10 : null;
    }

    // Wykres efektywnosci (punkty godzinowe/dzienne)
    const rc = await privatePost('/iot-service/index/common/query', {
      code: `BK62x-APP-efficiency-SOLAR-ENERGY-FLOW-${chartKey}-Chart_DATA`,
      params: { spaceId: SPACE_ID, sn: DEVICE_SN, beginTime: range.begin, endTime: range.end, timezone: 'Europe/Warsaw' },
    });
    if (rc?.code === '0' && Array.isArray(rc.data)) {
      out.efficiencyChart = rc.data
        .filter(d => d.indexName === 'chart_data' && d.time && d.indexValue != null)
        .map(d => ({ time: d.time, pct: Math.round(d.indexValue * 10) / 10 }))
        .sort((a, b) => a.time.localeCompare(b.time));
    }
  }

  return out;
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

async function getMainSn() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/system/main/sn', { sn: DEVICE_SN });
    if (data.code === '0' && data.data?.sn) { mainSn = data.data.sn; }
  } catch(e) {}
}

async function fetchAllQuotas() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/quota/all', { sn: mainSn });
    if (data.code === '0' && data.data && Object.keys(data.data).length > 0) applyParams(data.data);
  } catch(e) {}
}

async function startMqtt() {
  if (!ACCESS_KEY || !SECRET_KEY) { startDemoMode(); return; }
  await getMainSn();
  let creds;
  try {
    const data = await ecoflowGet('/iot-open/sign/certification');
    if (data.code !== '0') throw new Error(data.message);
    creds = data.data;
    console.log(`✅ MQTT OK — ${creds.certificateAccount}`);
  } catch(e) { console.error('❌ MQTT creds:', e.message); setTimeout(startMqtt, 30000); return; }

  const client = mqtt.connect(`mqtts://${creds.url}:${creds.port}`, {
    clientId: `open-${uuidv4()}`, username: creds.certificateAccount,
    password: creds.certificatePassword, rejectUnauthorized: false, reconnectPeriod: 5000,
  });
  const quotaTopic  = `/open/${creds.certificateAccount}/${mainSn}/quota`;
  const statusTopic = `/open/${creds.certificateAccount}/${mainSn}/status`;

  client.on('connect', () => {
    deviceState.connected = true;
    broadcast({ type: 'status', connected: true });
    client.subscribe(quotaTopic); client.subscribe(statusTopic);
    fetchAllQuotas();
    setInterval(fetchAllQuotas, 30000);
    console.log('✅ MQTT połączony!');
  });
  client.on('message', (topic, payload) => {
    try {
      const str = payload.toString('utf8');
      if (!str.startsWith('{')) return;
      const data = JSON.parse(str);
      if (topic.endsWith('/status')) {
        const online = data.params?.status === 1;
        deviceState.connected = online;
        broadcast({ type: 'status', connected: online });
        return;
      }
      const params = data.params || data;
      if (params && typeof params === 'object') applyParams(params);
    } catch(e) {}
  });
  client.on('error', err => console.error('MQTT error:', err.message));
  client.on('close', () => { deviceState.connected = false; broadcast({ type: 'status', connected: false }); });
}

function startDemoMode() {
  console.log('🎭 Demo mode');
  let t = 0;
  setInterval(() => {
    t += 0.1;
    deviceState.pv1Power  = Math.round(300 + 200 * Math.sin(t) + Math.random() * 10);
    deviceState.pv2Power  = Math.round(300 + 200 * Math.sin(t + 0.1) + Math.random() * 10);
    deviceState.pvPower   = deviceState.pv1Power + deviceState.pv2Power;
    deviceState.feedPower = deviceState.pvPower;
    deviceState.acVoltage = 230; deviceState.acFreq = 50;
    deviceState.pv1Voltage = 38.5; deviceState.pv2Voltage = 38.3;
    deviceState.invTemp = 35; deviceState.connected = true;
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory(); broadcast({ type: 'state', data: deviceState });
  }, 2000);
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`🚀 http://localhost:${PORT}  SN:${DEVICE_SN||'?'}  Email:${EF_EMAIL||'brak'}  SpaceID:${SPACE_ID}`);
  startMqtt();
  if (EF_EMAIL && EF_PASSWORD) {
    await loginPrivateApi();
    const today = new Date().toISOString().slice(0, 10);
    // Pre-cache dzisiejszych danych
    for (const period of ['day', 'week', 'month']) {
      try {
        const data = await fetchEnergyForPeriod(period, today);
        if (data) energyCache[`${period}:${today}`] = { ...data, fetchedAt: Date.now() };
      } catch(e) {}
    }
    console.log('✅ Cache energii gotowy');
    // Odświeżaj co godzinę
    setInterval(async () => {
      const t = new Date().toISOString().slice(0, 10);
      for (const period of ['day', 'week', 'month']) {
        try {
          const data = await fetchEnergyForPeriod(period, t);
          if (data) energyCache[`${period}:${t}`] = { ...data, fetchedAt: Date.now() };
        } catch(e) {}
      }
    }, 60 * 60 * 1000);
  }
});
