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
const PSTRYK_KEY = process.env.PSTRYK_API_KEY || '';

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
  vBat: 0,
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
let pricesCache = { data: null, fetchedAt: 0 };
let scheduleCache = { data: null, fetchedAt: 0 };

// ─── EcoFlow Official API ───
const EF_OFFICIAL_HOST = 'https://api.ecoflow.com';

function efSign(params) {
  const nonce = String(Math.floor(Math.random() * 900000) + 100000);
  const timestamp = String(Date.now());
  const flat = {};
  function flatten(obj, prefix) {
    for (const k of Object.keys(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const v = obj[k];
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (v !== null && typeof item === 'object') flatten(item, `${key}[${i}]`);
          else flat[`${key}[${i}]`] = item;
        });
      } else if (v !== null && typeof v === 'object') {
        flatten(v, key);
      } else {
        flat[key] = v;
      }
    }
  }
  flatten(params, '');
  const parts = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`);
  parts.push(`accessKey=${ACCESS_KEY}`, `nonce=${nonce}`, `timestamp=${timestamp}`);
  const sign = crypto.createHmac('sha256', SECRET_KEY).update(parts.join('&')).digest('hex');
  return { nonce, timestamp, sign };
}

async function efGet(path, params = {}) {
  const { nonce, timestamp, sign } = efSign(params);
  const qs = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const url = `${EF_OFFICIAL_HOST}${path}${qs ? '?' + qs : ''}`;
  const r = await axios.get(url, {
    headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign },
    timeout: 8000
  });
  return r.data;
}

async function efPost(path, body) {
  const { nonce, timestamp, sign } = efSign(body);
  const r = await axios.post(`${EF_OFFICIAL_HOST}${path}`, body, {
    headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign,
      'Content-Type': 'application/json;charset=UTF-8' },
    timeout: 8000
  });
  return r.data;
}

async function efHistorical(code, beginTime, endTime) {
  const r = await efPost('/iot-open/sign/device/quota/data', {
    sn: DEVICE_SN, params: { beginTime, endTime, code }
  });
  return r?.data?.data || [];
}

// Token prywatnego API
let privateToken = null;

// Cache pogody dziennej
let weatherCache = { date: null, weather: [], peakSunHours: 0 };

async function refreshWeatherCache() {
  if (!privateToken) return;
  const effMap = {'Clear Sky':1.0,'Few Clouds':0.85,'Scattered Clouds':0.65,
    'Broken Clouds':0.45,'Overcast Clouds':0.3,'Rain':0.1,'Light Rain':0.15};
  try {
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    const localDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const nonce = crypto.randomBytes(8).toString('hex');
    const timestamp = String(Date.now());
    const sign = crypto.createHash('md5').update(`nonce=${nonce}&timestamp=${timestamp}`).digest('hex');
    const wh = {'Authorization': `Bearer ${privateToken}`, 'lang': 'en_US',
      'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sign': sign,
      'X-Appid': '9', 'platform': 'android', 'version': '6.10.5'};
    const wr = await axios.get('https://api-e.ecoflow.com/app/solarEnergy/weatherBySpaceId',
      { headers: wh, params: { beginTime: `${localDate} 07:00:00`, endTime: `${localDate} 20:00:00`,
        spaceId: SPACE_ID, timeType: 1 }, timeout: 8000 });
    if (wr.data.code === '0' && wr.data.data?.length) {
      const newWeather = wr.data.data.map(w => ({
        hour: parseInt(w.dt.slice(11,13)), weather: w.weather })); // dt = czas lokalny
      // Merge z istniejącym cache (zachowaj godziny które juz minęły)
      const nowH = now.getHours();
      const existing = weatherCache.weather.filter(w => w.hour < nowH);
      const merged = [...existing, ...newWeather.filter(w => !existing.find(e => e.hour === w.hour))];
      merged.sort((a,b) => a.hour - b.hour);
      const sunHours = merged.filter(w => w.hour >= 6 && w.hour <= 20); // CEST lokalny
      const peakSunHours = Math.round(sunHours.reduce((s,w) => s+(effMap[w.weather]||0.5), 0)*10)/10;
      weatherCache = { date: localDate, weather: merged, peakSunHours };
      console.log(`☀️  Weather cache: ${peakSunHours}h peak sun (${merged.length} godzin)`);
    }
  } catch(e) { console.error('Weather cache error:', e.message); }
}
let tokenExpiry = 0;

// ─── Server ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('/api/state',   (_, res) => res.json(deviceState));
app.get('/api/history', (_, res) => res.json(history));

app.get('/api/efficiency', async (req, res) => {
  try {
    const now = new Date();
    // Uzyj lokalnego czasu kontenera (TZ=Europe/Warsaw) dla zakresu dat
    const pad = n => String(n).padStart(2,'0');
    const localDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const todayUTC = now.toISOString().slice(0, 10);
    const beginTime = `${localDate} 00:00:00`;
    const endTime   = `${localDate} 23:59:59`;
    const PANEL_MAX_W = 2030;

    const CODES = {
      independence: 'BK621-App-HOME-INDEPENDENCE-PERCENT-FLOW-indep-progress_bar-NOTDISTINGUISH-MASTER_DATA',
      solar:        'BK621-App-HOME-SOLAR-ENERGY-FLOW-solor-line-NOTDISTINGUISH-MASTER_DATA',
      consumption:  'BK621-App-HOME-LOAD-ENERGY-FLOW-consumption-prop_arc-NOTDISTINGUISH-MASTER_DATA',
      grid:         'BK621-App-HOME-GRID-ENERGY-FLOW-grid_prop_bar-NOTDISTINGUISH-MASTER_DATA',
      battery:      'BK621-App-HOME-SOC-ENERGY-FLOW-battery-prop_bar-NOTDISTINGUISH-MASTER_DATA',
      co2:          'BK621-App-HOME-CO2-WEIGHT-FLOW-impact-progress_arc-NOTDISTINGUISH-MASTER_DATA',
    };

    const results = {};
    await Promise.all(Object.entries(CODES).map(async ([key, code]) => {
      try {
        const data = await efHistorical(code, beginTime, endTime);
        results[key] = data;
      } catch(e) { results[key] = []; }
    }));

    const getVal = (arr, extra) => {
      const item = extra !== undefined
        ? arr.find(d => String(d.extra) === String(extra))
        : arr[0];
      return item ? parseFloat(item.indexValue) : 0;
    };

    const solarWh      = getVal(results.solar, undefined);
    const consumptionWh= getVal(results.consumption, undefined);
    const fromGridWh   = getVal(results.grid, '1');
    const toGridWh     = getVal(results.grid, '2');
    const batChgWh     = getVal(results.battery, '2');
    const batDsgWh     = getVal(results.battery, '1');
    const independence = getVal(results.independence, undefined);
    const co2g         = getVal(results.co2, undefined);

    // Efektywnosc chwilowa
    const instantEff = deviceState.pvTotal > 0
      ? Math.round(deviceState.pvTotal / PANEL_MAX_W * 1000) / 10 : 0;

    // Efektywnosc dzienna = solar / consumption
    const dailyEff = consumptionWh > 0
      ? Math.round(solarWh / consumptionWh * 1000) / 10 : 0;

    // Prognoza: historia * korekta pogodowa
    let forecastKwh = 0, peakSunHours = 0, weather = [];
    try {
      const effMap = {'Clear Sky':1.0,'Few Clouds':0.85,'Scattered Clouds':0.65,
        'Broken Clouds':0.45,'Overcast Clouds':0.3,'Rain':0.1,'Light Rain':0.15};

      // Krok 1: historia ostatnich 7 dni
      const histDays = [];
      for (let i = 1; i <= 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        const hd = await efHistorical(
          'BK621-App-HOME-SOLAR-ENERGY-FLOW-solor-line-NOTDISTINGUISH-MASTER_DATA',
          `${ds} 00:00:00`, `${ds} 23:59:59`
        );
        if (hd?.length) histDays.push(parseFloat(hd[0].indexValue) / 1000);
      }

      if (histDays.length >= 3) {
        // Srednia wazona
        let sumW = 0, sumV = 0;
        histDays.forEach((v, i) => { const w = histDays.length - i; sumW += w; sumV += v * w; });
        const histAvg = sumV / sumW;

        // Krok 2: pogoda dzisiaj przez prywatne API
        let weatherFactor = 1.0;
        if (privateToken) {
          try {
            const nonce = crypto.randomBytes(8).toString('hex');
            const timestamp = String(Date.now());
            const sign = crypto.createHash('md5').update(`nonce=${nonce}&timestamp=${timestamp}`).digest('hex');
            const wh = {'Authorization': `Bearer ${privateToken}`, 'lang': 'en_US',
              'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sign': sign,
              'X-Appid': '9', 'platform': 'android', 'version': '6.10.5'};
            const wr = await axios.get('https://api-e.ecoflow.com/app/solarEnergy/weatherBySpaceId',
              { headers: wh, params: { beginTime: `${localDate} 07:00:00`, endTime: `${localDate} 20:00:00`,
                spaceId: SPACE_ID, timeType: 1 }, timeout: 8000 });
            if (wr.data.code === '0' && wr.data.data?.length) {
              weather = wr.data.data.map(w => ({
                hour: parseInt(w.dt.slice(11,13)), weather: w.weather })); // dt = lokalny
              const sunHours = weather.filter(w => w.hour >= 6 && w.hour <= 20); // CEST lokalny
              peakSunHours = Math.round(sunHours.reduce((s,w) => s+(effMap[w.weather]||0.5), 0)*10)/10;
              // Srednia pogodowa dla typowego dnia (zakl. 8h przy 1.0)
              // Srednia liczba godzin slonecznych dla Hajnówki wg miesiaca
          const avgSunByMonth = [2.0,3.0,4.5,5.5,6.5,7.0,6.5,6.0,4.5,3.0,2.0,1.5];
          const typicalSunHours = avgSunByMonth[new Date().getMonth()];
              weatherFactor = Math.min(1.3, Math.max(0.4, peakSunHours / typicalSunHours));
            }
          } catch(e) {}
        }

        forecastKwh = Math.round(histAvg * weatherFactor * 10) / 10;
      }
    } catch(e) { console.error('Forecast error:', e.message); }

    if (privateToken) {
      try {
        const nonce = crypto.randomBytes(8).toString('hex');
        const timestamp = String(Date.now());
        const sign = crypto.createHash('md5').update(`nonce=${nonce}&timestamp=${timestamp}`).digest('hex');
        const wh = {'Authorization': `Bearer ${privateToken}`, 'lang': 'en_US',
          'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sign': sign,
          'X-Appid': '9', 'platform': 'android', 'version': '6.10.5'};
        const wr = await axios.get('https://api-e.ecoflow.com/app/solarEnergy/weatherBySpaceId',
          { headers: wh, params: { beginTime: `${todayUTC} 00:00:00`, endTime: `${todayUTC} 23:59:59`,
            spaceId: SPACE_ID, timeType: 1 }, timeout: 8000 });
        if (wr.data.code === '0') {
          const effMap = {'Clear Sky':1.0,'Few Clouds':0.85,'Scattered Clouds':0.65,
            'Broken Clouds':0.45,'Overcast Clouds':0.3,'Rain':0.1,'Light Rain':0.15};
          weather = (wr.data.data || []).map(w => ({
            hour: new Date(w.timestamp*1000).getHours(), weather: w.weather }));
          // Peak sun hours = suma efektywnosci tylko dla godzin 7-19 (faktyczne nasłonecznienie)
          const sunHours = weather.filter(w => w.hour >= 6 && w.hour <= 20); // CEST lokalny
          peakSunHours = Math.round(sunHours.reduce((s,w) => s+(effMap[w.weather]||0.5), 0)*10)/10;
          // Wspolczynnik 0.75 uwzglednia straty (temperatura, inverter, kable, kat padania)
          // forecastKwh z historii - nie nadpisuj, uzywamy tylko peakSunHours i weather do opisu
        }
      } catch(e) {}
    }

    res.json({
      instantEff, dailyEff,
      solarKwh: Math.round(solarWh/100)/10,
      consumptionKwh: Math.round(consumptionWh/100)/10,
      fromGridKwh: Math.round(fromGridWh/100)/10,
      toGridKwh: Math.round(toGridWh/100)/10,
      batChgKwh: Math.round(batChgWh/100)/10,
      batDsgKwh: Math.round(batDsgWh/100)/10,
      independence: Math.round(independence*10)/10,
      co2g: Math.round(co2g),
      forecastKwh, peakSunHours, weather,
      pvNow: deviceState.pvTotal, panelMax: PANEL_MAX_W
    });
  } catch(e) {
    console.error('Efficiency error:', e.message);
    res.json({ error: e.message });
  }
});


app.get('/api/schedule', async (req, res) => {
  const now = Date.now();
  if (scheduleCache.data && now - scheduleCache.fetchedAt < 15 * 60 * 1000) {
    return res.json(scheduleCache.data);
  }
  if (!privateToken) return res.json({ error: 'no_token' });
  try {
    const nonce = crypto.randomBytes(8).toString('hex');
    const timestamp = String(Date.now());
    const sign = crypto.createHash('md5').update(`nonce=${nonce}&timestamp=${timestamp}`).digest('hex');
    const headers = {
      'Authorization': `Bearer ${privateToken}`, 'lang': 'en_US',
      'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sign': sign,
      'X-Appid': '9', 'platform': 'android', 'version': '6.10.5'
    };
    const r = await axios.get('https://api-e.ecoflow.com/tou-service/intelligent/data',
      { headers, params: { sn: DEVICE_SN, timezone: 'Europe/Warsaw', full: 1 }, timeout: 10000 });
    if (r.data.code === '0') {
      const data = { schedule: r.data.data?.intelligentDataList || [] };
      scheduleCache = { data, fetchedAt: now };
      return res.json(data);
    }
    res.json({ error: r.data.message, schedule: [] });
  } catch(e) {
    console.error('Schedule error:', e.message);
    res.json({ error: e.message, schedule: [] });
  }
});

app.get('/api/prices', async (req, res) => {
  const now = Date.now();
  if (pricesCache.data && now - pricesCache.fetchedAt < 15 * 60 * 1000) {
    return res.json(pricesCache.data);
  }
  if (!PSTRYK_KEY) return res.json({ error: 'no_key' });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const url = `https://api.pstryk.pl/integrations/meter-data/unified-metrics/?metrics=pricing&resolution=hour&window_start=${today}T00:00:00Z&window_end=${tomorrow}T23:59:59Z`;
    const r = await axios.get(url, {
      headers: { 'Authorization': PSTRYK_KEY },
      timeout: 10000
    });
    const frames = r.data.frames || [];
    const prices = frames.map(f => ({
      start: f.start,
      end: f.end,
      price: f.metrics?.pricing?.full_price,
      priceNet: f.metrics?.pricing?.price_net,
      priceProsumer: f.metrics?.pricing?.price_prosumer_gross,
      isCheap: f.metrics?.pricing?.is_cheap,
      isExpensive: f.metrics?.pricing?.is_expensive,
    }));
    pricesCache = { data: { prices }, fetchedAt: now };
    res.json({ prices });
  } catch(e) {
    console.error('Pstryk prices error:', e.message);
    res.json({ error: e.message });
  }
});

app.get('/api/energy', async (req, res) => {
  const period  = req.query.period || 'day';
  const today   = new Date().toISOString().slice(0, 10);
  const refDate = req.query.date || today;
  const cacheKey = `${period}:${refDate}`;
  const ttl = refDate === today ? 60000 : 3600000;
  if (energyCache[cacheKey] && Date.now() - energyCache[cacheKey].fetchedAt < ttl) {
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
    // todayActive = calkowite zuzycie domu
    if (rec.todayActive != null) {
      deviceState.meterTodayConsumption = Math.max(0, Math.round(rec.todayActive));
    }
    // totalActiveEnergy = laczne zuzycie
    if (rec.totalActiveEnergy != null) {
      deviceState.meterTotalConsumption = Math.max(0, Math.round(rec.totalActiveEnergy));
    }
    // totalReactiveEnergy = eksport do sieci (feed-in)
    if (rec.totalReactiveEnergy != null && rec.totalReactiveEnergy > 0) {
      deviceState.meterTodayExport = Math.round(rec.totalReactiveEnergy);
    }
    updated = true;
  }

  if (updated) {
    if (deviceState.feedPower === 0 && deviceState.meterTotal > 0) {
      deviceState.fromGrid = deviceState.meterTotal;
    }
    deviceState.connected = true;
    deviceState.lastMqttData = Date.now();
    broadcast({ type: 'state', data: deviceState });
  }
}

// ─── Grid balance calculator ─────────────────────────────────────────────────
function calcGridBalance() {
  const pv   = deviceState.pvTotal      || 0;
  const load = deviceState.sysLoad      || 0;
  const bat  = deviceState.battPower    || 0;
  const chg  = deviceState.chgDsgState  || 0;
  const meter = deviceState.meterTotal  || 0;

  // Jesli licznik daje dane - uzyj go jako zrodla prawdy dla poboru z sieci
  if (meter > 20) {
    deviceState.fromGrid  = meter;
    deviceState.feedPower = 0;
    return;
  }

  // Fallback: bilans energetyczny
  const batCharging    = chg === 2 ? Math.max(0, bat)           : (bat > 20  ? bat : 0);
  const batDischarging = chg === 1 ? Math.max(0, Math.abs(bat)) : (bat < -20 ? Math.abs(bat) : 0);
  const net = pv + batDischarging - load - batCharging;
  if (net > 20) {
    deviceState.feedPower = Math.round(net);
    deviceState.fromGrid  = 0;
  } else if (net < -20) {
    deviceState.feedPower = 0;
    deviceState.fromGrid  = Math.round(-net);
  } else {
    deviceState.feedPower = 0;
    deviceState.fromGrid  = 0;
  }
}

// Timer - przeliczaj co 3s i broadcastuj jesli zmiana
setInterval(() => {
  const prevFeed = deviceState.feedPower;
  const prevFrom = deviceState.fromGrid;
  calcGridBalance();
  if (deviceState.feedPower !== prevFeed || deviceState.fromGrid !== prevFrom) {
    broadcast({ type: 'state', data: deviceState });
  }
}, 3000);

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
  // battPower z filtrem skokow
  if (params.powGetBpCms !== undefined) {
    const newVal = r1(params.powGetBpCms);
    const prev   = deviceState.battPower || 0;
    if (prev === 0 || Math.abs(newVal) <= Math.abs(prev) * 5 + 300) {
      deviceState.battPower = newVal;
    } else {
      console.log(`battPower spike: ${newVal}W -> ignorowany (prev ${prev}W)`);
    }
    updated = true;
  }
  set('cmsChgRemTime','chgRemTime', v => v);
  set('cmsDsgRemTime','dsgRemTime', v => v);
  set('bmsChgDsgState','chgDsgState', v => v);
  set('bmsMaxCellTemp','maxCellTemp', v => v);
  set('vBat','vBat', v => v);
  set('bmsMinCellTemp','minCellTemp', v => v);
  if (params.cellTemp) { deviceState.cellTemp = params.cellTemp; updated = true; }
  if (params.cellVol)  { deviceState.cellVol  = params.cellVol;  updated = true; }

  // Sieć
  set('gridConnectionVol',  'gridVol',  r1);
  set('gridConnectionFreq', 'gridFreq', r2);
  if (params.gridConnectionSta !== undefined) { deviceState.gridStatus = params.gridConnectionSta; updated = true; }
  if (params.gridConnectionPower !== undefined) {
    deviceState.gridPower = r1(params.gridConnectionPower);
    updated = true;
  }




  // Zużycie
  set('powGetSysLoad',         'sysLoad',     r1);
  set('powGetSysLoadFromPv',   'loadFromPv',  r1);
  set('powGetSysLoadFromGrid', 'loadFromGrid',r1);
  set('powGetSysLoadFromBp',   'loadFromBat', r1);
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
    // Przelicz bilans sieci ze swiezych wartosci
    calcGridBalance();

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
    refreshWeatherCache().catch(()=>{});
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
      if (period === 'month' || period === 'year') {
        out.earnings = monthEarnings;
      } else {
        out.earnings = null; // zbyt niedokladne dla day/week
      }
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
