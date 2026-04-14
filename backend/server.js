const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const mqtt     = require('mqtt');
const path     = require('path');
const crypto   = require('crypto');
const axios    = require('axios');
const fs       = require('fs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function ecoflowGet(url, queryParams = {}) {
  const headers = makeSignedHeaders(ACCESS_KEY, SECRET_KEY, {});
  const qs = Object.keys(queryParams).length > 0
    ? '?' + Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const resp = await axios.get(`${API_HOST}${url}${qs}`, { headers, timeout: 10000 });
  return resp.data;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT       = process.env.PORT            || 8080;
const DEVICE_SN  = process.env.DEVICE_SN       || '';
const ACCESS_KEY = process.env.EF_ACCESS_KEY   || '';
const SECRET_KEY = process.env.EF_SECRET_KEY   || '';
const API_HOST   = 'https://api-e.ecoflow.com';
let   mainSn     = DEVICE_SN;

// ─── Lokalny licznik energii ──────────────────────────────────────────────────

const ENERGY_FILE = '/data/energy.json';

function loadEnergy() {
  try {
    if (fs.existsSync(ENERGY_FILE)) return JSON.parse(fs.readFileSync(ENERGY_FILE, 'utf8'));
  } catch(e) {}
  return { daily: {}, monthly: {} };
}

function saveEnergy() {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(ENERGY_FILE, JSON.stringify(energyData, null, 2));
  } catch(e) { console.error('Save energy error:', e.message); }
}

let energyData  = loadEnergy();
let lastEnergyTs = Date.now();

function accumulateEnergy() {
  const now  = Date.now();
  const dtH  = (now - lastEnergyTs) / 3600000; // godziny
  lastEnergyTs = now;

  if (dtH <= 0 || dtH > 0.1) return; // ignoruj przerwy > 6 minut

  const pv1Wh  = (deviceState.pv1Power  || 0) * dtH;
  const pv2Wh  = (deviceState.pv2Power  || 0) * dtH;
  const feedWh = (deviceState.feedPower || 0) * dtH;

  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  if (!energyData.daily[today])   energyData.daily[today]   = { pv1Wh:0, pv2Wh:0, pvWh:0, feedWh:0 };
  if (!energyData.monthly[month]) energyData.monthly[month] = { pv1Wh:0, pv2Wh:0, pvWh:0, feedWh:0 };

  for (const key of ['daily', 'monthly']) {
    const bucket = key === 'daily' ? energyData.daily[today] : energyData.monthly[month];
    bucket.pv1Wh  += pv1Wh;
    bucket.pv2Wh  += pv2Wh;
    bucket.pvWh   += pv1Wh + pv2Wh;
    bucket.feedWh += feedWh;
  }

  // Usuń dane starsze niż 90 dni
  const cutoff = new Date(Date.now() - 90 * 24 * 3600000).toISOString().split('T')[0];
  Object.keys(energyData.daily).forEach(k => { if (k < cutoff) delete energyData.daily[k]; });
}

// Akumuluj i zapisuj co minutę
setInterval(() => { accumulateEnergy(); saveEnergy(); }, 60000);

// ─── State ────────────────────────────────────────────────────────────────────

// Zbieraj wszystkie klucze które kiedykolwiek przyszły
let allReceivedKeys = {};

let deviceState = {
  connected: false, lastUpdate: null,
  pv1Power: 0, pv2Power: 0, pvPower: 0,
  feedPower: 0, fromGrid: 0, gridPower: 0,
  acVoltage: 0, acFreq: 0, acCurrent: 0,
  pv1Voltage: 0, pv2Voltage: 0,
  pv1Current: 0, pv2Current: 0,
  invTemp: 0, gridStatus: '',
};

let history = { feed: [], pv1: [], pv2: [], timestamps: [] };
const MAX_HISTORY = 300;

// ─── Server ───────────────────────────────────────────────────────────────────

const app     = express();
const server  = http.createServer(app);
const WSServer = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('/api/state',   (req, res) => res.json(deviceState));
app.get('/api/all-keys', (req, res) => res.json(allReceivedKeys));
app.get('/api/history', (req, res) => res.json(history));

// Historia lokalna
app.get('/api/historical', (req, res) => {
  const { period, date } = req.query;
  accumulateEnergy();
  if (period === 'month') {
    const data = energyData.monthly[date] || { pv1Wh:0, pv2Wh:0, pvWh:0, feedWh:0 };
    const days = Object.keys(energyData.daily).filter(d => d.startsWith(date)).length;
    res.json({ period, date, ...roundEnergy(data), days });
  } else {
    const data = energyData.daily[date] || { pv1Wh:0, pv2Wh:0, pvWh:0, feedWh:0 };
    res.json({ period, date, ...roundEnergy(data) });
  }
});

// Wszystkie dostępne dni — do kalendarza
app.get('/api/energy-days', (req, res) => {
  accumulateEnergy();
  const days = {};
  Object.entries(energyData.daily).forEach(([d, v]) => {
    days[d] = { pvKwh: +(v.pvWh/1000).toFixed(3), feedKwh: +(v.feedWh/1000).toFixed(3) };
  });
  res.json(days);
});

function roundEnergy(e) {
  return {
    pv1Wh:  Math.round(e.pv1Wh),
    pv2Wh:  Math.round(e.pv2Wh),
    pvWh:   Math.round(e.pvWh),
    feedWh: Math.round(e.feedWh),
  };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  WSServer.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function recordHistory() {
  history.timestamps.push(new Date().toISOString());
  history.feed.push(deviceState.feedPower);
  history.pv1.push(deviceState.pv1Power);
  history.pv2.push(deviceState.pv2Power);
  if (history.timestamps.length > MAX_HISTORY) {
    ['timestamps','feed','pv1','pv2'].forEach(k => history[k].shift());
  }
}

// ─── Parse MQTT params ────────────────────────────────────────────────────────

function applyParams(params) {
  let updated = false;
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;

  const set = (key, field, fn) => {
    if (params[key] !== undefined && params[key] !== null) {
      const val = fn(params[key]);
      if (Math.abs((deviceState[field] || 0) - val) > 0.05 || deviceState[field] !== val) {
        deviceState[field] = val; updated = true;
      }
    }
  };

  set('powGetPv',          'pv1Power',   r1);
  set('powGetPv2',         'pv2Power',   r1);
  set('gridConnectionPower','gridPower',  r1);
  set('gridConnectionVol', 'acVoltage',  r1);
  set('gridConnectionFreq','acFreq',     r2);
  set('gridConnectionAmp', 'acCurrent',  r2);
  set('plugInInfoPvVol',   'pv1Voltage', r1);
  set('plugInInfoPv2Vol',  'pv2Voltage', r1);
  set('plugInInfoPvAmp',   'pv1Current', r2);
  set('plugInInfoPv2Amp',  'pv2Current', r2);
  set('invNtcTemp3',       'invTemp',    v => v);
  set('gridConnectionSta', 'gridStatus', v => v);

  if (params['powGetPv'] !== undefined || params['powGetPv2'] !== undefined) {
    deviceState.pvPower = r1((deviceState.pv1Power || 0) + (deviceState.pv2Power || 0));
    updated = true;
  }

  // gridConnectionPower dodatnie = feed-in (dla STREAM Easy)
  if (params['gridConnectionPower'] !== undefined) {
    const g = params['gridConnectionPower'];
    deviceState.feedPower = g > 0 ? r1(g) : 0;
    deviceState.fromGrid  = g < 0 ? r1(Math.abs(g)) : 0;
    updated = true;
  }

  // Zapisz wszystkie otrzymane klucze z wartościami
  Object.entries(params).forEach(([k, v]) => {
    allReceivedKeys[k] = v;
  });

  if (updated) {
    deviceState.lastUpdate = new Date().toISOString();
    accumulateEnergy();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
    console.log(`📊 pv1=${deviceState.pv1Power}W pv2=${deviceState.pv2Power}W feed=${deviceState.feedPower}W`);
  }
  return updated;
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

async function getMainSn() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/system/main/sn', { sn: DEVICE_SN });
    if (data.code === '0' && data.data?.sn) {
      mainSn = data.data.sn;
      console.log(`✅ Główny SN: ${mainSn}`);
    }
  } catch(e) { console.log(`⚠️  getMainSn: ${e.message}`); }
}

async function fetchAllQuotas() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/quota/all', { sn: mainSn });
    if (data.code === '0' && data.data && Object.keys(data.data).length > 0) {
      applyParams(data.data);
    }
  } catch(e) { console.error('REST quota error:', e.message); }
}

async function startMqtt() {
  if (!ACCESS_KEY || !SECRET_KEY) { startDemoMode(); return; }

  await getMainSn();

  let creds;
  try {
    const data = await ecoflowGet('/iot-open/sign/certification');
    if (data.code !== '0') throw new Error(data.message);
    creds = data.data;
    console.log(`✅ MQTT credentials — account: ${creds.certificateAccount}`);
  } catch(e) {
    console.error('❌ Credentials error:', e.message);
    setTimeout(startMqtt, 30000); return;
  }

  const client = mqtt.connect(`mqtts://${creds.url}:${creds.port}`, {
    clientId: `open-${uuidv4()}`,
    username: creds.certificateAccount,
    password: creds.certificatePassword,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
  });

  const quotaTopic    = `/open/${creds.certificateAccount}/${mainSn}/quota`;
  const statusTopic   = `/open/${creds.certificateAccount}/${mainSn}/status`;
  const getReplyTopic = `/open/${creds.certificateAccount}/${mainSn}/get_reply`;
  const getTopic      = `/open/${creds.certificateAccount}/${mainSn}/get`;

  client.on('connect', () => {
    console.log('✅ MQTT połączony!');
    deviceState.connected = true;
    broadcast({ type: 'status', connected: true });
    client.subscribe(quotaTopic);
    client.subscribe(statusTopic);
    client.subscribe(getReplyTopic);
    console.log(`📡 Sub: ${quotaTopic}`);
    fetchAllQuotas();
    setInterval(fetchAllQuotas, 30000);

    // Zapytaj urządzenie przez MQTT get o dostępne parametry
    setTimeout(() => {
      // Próbuj pobrać historię dzienną przez MQTT get
      const msg = JSON.stringify({
        id: String(Date.now()),
        version: '1.0',
        params: { quotas: [
          'quota_cloud_ts',
          'powGetPvSum',
          'gridConnectionPower',
        ]}
      });
      client.publish(getTopic, msg);
      console.log(`📤 MQTT get -> ${getTopic}`);
    }, 3000);
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
      if (topic.endsWith('/get_reply')) {
        console.log('📥 get_reply:', JSON.stringify(data).substring(0, 500));
        return;
      }
      const params = data.params || data;
      if (params && typeof params === 'object') applyParams(params);
    } catch(e) {}
  });

  client.on('error', err => console.error('MQTT error:', err.message));
  client.on('close', () => {
    deviceState.connected = false;
    broadcast({ type: 'status', connected: false });
  });
}

// ─── Demo mode ────────────────────────────────────────────────────────────────

function startDemoMode() {
  console.log('🎭 Demo mode (brak kluczy API)');
  let t = 0;
  setInterval(() => {
    t += 0.1;
    deviceState.pv1Power   = Math.round(300 + 200 * Math.sin(t) + Math.random() * 10);
    deviceState.pv2Power   = Math.round(300 + 200 * Math.sin(t + 0.1) + Math.random() * 10);
    deviceState.pvPower    = deviceState.pv1Power + deviceState.pv2Power;
    deviceState.feedPower  = deviceState.pvPower;
    deviceState.acVoltage  = 230;
    deviceState.acFreq     = 50;
    deviceState.pv1Voltage = 38.5;
    deviceState.pv2Voltage = 38.3;
    deviceState.invTemp    = 35;
    deviceState.connected  = true;
    deviceState.lastUpdate = new Date().toISOString();
    accumulateEnergy();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
  }, 2000);
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🚀 Dashboard: http://localhost:${PORT}`);
  console.log(`📟 Device SN: ${DEVICE_SN || '(brak!)'}`);
  console.log(`🔑 Access Key: ${ACCESS_KEY ? ACCESS_KEY.substring(0, 8) + '...' : '(brak!)'}`);
  startMqtt();
});
