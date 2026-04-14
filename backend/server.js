const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

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
    const sortedKeys = Object.keys(flat).sort();
    dataStr = sortedKeys.map(k => `${k}=${flat[k]}`).join('&') + '&';
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

async function ecoflowPost(url, body = {}) {
  const headers = makeSignedHeaders(ACCESS_KEY, SECRET_KEY, body);
  const resp = await axios.post(`${API_HOST}${url}`, body, { headers, timeout: 10000 });
  return resp.data;
}

const PORT       = process.env.PORT            || 8080;
const DEVICE_SN  = process.env.DEVICE_SN       || '';
const ACCESS_KEY = process.env.EF_ACCESS_KEY   || '';
const SECRET_KEY = process.env.EF_SECRET_KEY   || '';
const API_HOST   = 'https://api-e.ecoflow.com';

let mainSn = DEVICE_SN; // będzie zaktualizowany po pobraniu głównego SN

let deviceState = {
  connected: false, lastUpdate: null,
  // Z dokumentacji STREAM API
  pvPower: 0,            // powGetPvSum — moc PV (W)
  gridPower: 0,          // gridConnectionPower — moc sieci (+ pobieranie, - oddawanie)
  feedPower: 0,          // gridConnectionPower ujemny = feed-in
  loadPower: 0,          // powGetSysLoad — obciążenie domu (W)
  battPower: 0,          // powGetBpCms — moc baterii (W)
  battSoc: 0,            // cmsBattSoc — poziom baterii (%)
  feedGridMode: 0,       // 1=off, 2=on
  // PV per panel — jeśli dostępne
  pv1Power: 0,
  pv2Power: 0,
};

let history = { feed: [], pv: [], load: [], timestamps: [] };
const MAX_HISTORY = 300;

const app = express();
const server = http.createServer(app);
const WSServer = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('/api/state', (req, res) => res.json(deviceState));
app.get('/api/history', (req, res) => res.json(history));

function broadcast(data) {
  const msg = JSON.stringify(data);
  WSServer.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function recordHistory() {
  history.timestamps.push(new Date().toISOString());
  history.feed.push(deviceState.feedPower);
  history.pv.push(deviceState.pvPower);
  history.load.push(deviceState.loadPower);
  if (history.timestamps.length > MAX_HISTORY) {
    ['timestamps','feed','pv','load'].forEach(k => history[k].shift());
  }
}

function applyParams(params) {
  let updated = false;
  const set = (key, field, transform) => {
    if (params[key] !== undefined && params[key] !== null) {
      const val = transform ? transform(params[key]) : params[key];
      if (val !== deviceState[field]) {
        deviceState[field] = val;
        updated = true;
      }
    }
  };

  // Oficjalne parametry STREAM z dokumentacji
  set('powGetPvSum',       'pvPower',   v => Math.round(v * 10) / 10);
  set('gridConnectionPower', 'gridPower', v => Math.round(v * 10) / 10);
  set('powGetSysLoad',     'loadPower', v => Math.round(v * 10) / 10);
  set('powGetBpCms',       'battPower', v => Math.round(v * 10) / 10);
  set('cmsBattSoc',        'battSoc',   v => Math.round(v * 10) / 10);
  set('feedGridMode',      'feedGridMode', v => v);

  // Feed-in = gridConnectionPower ujemny (oddawanie do sieci)
  if (params['gridConnectionPower'] !== undefined) {
    const g = params['gridConnectionPower'];
    deviceState.feedPower = g < 0 ? Math.round(Math.abs(g) * 10) / 10 : 0;
    updated = true;
  }

  if (updated) {
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
    console.log(`📊 pv=${deviceState.pvPower}W grid=${deviceState.gridPower}W feed=${deviceState.feedPower}W load=${deviceState.loadPower}W batt=${deviceState.battSoc}%`);
  }
  return updated;
}

async function getMainSn() {
  try {
    console.log(`🔍 Pobieranie głównego SN dla ${DEVICE_SN}...`);
    const data = await ecoflowGet('/iot-open/sign/device/system/main/sn', { sn: DEVICE_SN });
    if (data.code === '0' && data.data && data.data.sn) {
      mainSn = data.data.sn;
      console.log(`✅ Główny SN: ${mainSn}`);
    } else {
      console.log(`⚠️  Nie udało się pobrać głównego SN, używam ${DEVICE_SN}`);
    }
  } catch (e) {
    console.log(`⚠️  getMainSn error: ${e.message}, używam ${DEVICE_SN}`);
  }
}

async function fetchAllQuotas() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/quota/all', { sn: mainSn });
    if (data.code === '0' && data.data && Object.keys(data.data).length > 0) {
      applyParams(data.data);
    } else {
      console.log('📊 REST quota: brak danych (code:', data.code, ')');
    }
  } catch (e) {
    console.error('❌ REST quota failed:', e.message);
  }
}

async function getMqttCredentials() {
  const data = await ecoflowGet('/iot-open/sign/certification');
  if (data.code !== '0') throw new Error(`API error ${data.code}: ${data.message}`);
  console.log(`✅ MQTT credentials OK — account: ${data.data.certificateAccount}`);
  return data.data;
}

async function startMqtt() {
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('❌ Brak EF_ACCESS_KEY lub EF_SECRET_KEY!');
    startDemoMode(); return;
  }
  if (!DEVICE_SN) { console.error('❌ Brak DEVICE_SN!'); return; }

  // Pobierz główny SN systemu
  await getMainSn();

  let creds;
  try { creds = await getMqttCredentials(); }
  catch (e) {
    console.error('❌ Błąd credentials:', e.message);
    setTimeout(startMqtt, 30000); return;
  }

  const clientId = `open-${uuidv4()}`;
  const mqttUrl = `mqtts://${creds.url}:${creds.port}`;
  console.log(`📡 MQTT łączę: ${mqttUrl}`);

  const client = mqtt.connect(mqttUrl, {
    clientId,
    username: creds.certificateAccount,
    password: creds.certificatePassword,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
  });

  // Temat quota — urządzenie wysyła dane automatycznie
  const quotaTopic  = `/open/${creds.certificateAccount}/${mainSn}/quota`;
  const statusTopic = `/open/${creds.certificateAccount}/${mainSn}/status`;

  client.on('connect', () => {
    console.log('✅ MQTT połączony!');
    deviceState.connected = true;
    broadcast({ type: 'status', connected: true });

    client.subscribe(quotaTopic,  err => { if (!err) console.log(`📡 Sub: ${quotaTopic}`); });
    client.subscribe(statusTopic, err => { if (!err) console.log(`📡 Sub: ${statusTopic}`); });

    // REST natychmiast + co 30s jako backup
    fetchAllQuotas();
    setInterval(fetchAllQuotas, 30000);
  });

  client.on('message', (topic, payload) => {
    try {
      const str = payload.toString('utf8');
      if (!str.startsWith('{')) return;
      const data = JSON.parse(str);

      if (topic.endsWith('/status')) {
        const online = data.params && data.params.status === 1;
        deviceState.connected = online;
        broadcast({ type: 'status', connected: online });
        console.log(`📡 Status: ${online ? 'online' : 'offline'}`);
        return;
      }

      // Quota — dane urządzenia
      const params = data.params || data;
      if (params && typeof params === 'object' && Object.keys(params).length > 0) {
        applyParams(params);
      }
    } catch (e) { /* ignoruj */ }
  });

  client.on('error', err => console.error('MQTT error:', err.message));
  client.on('close', () => {
    deviceState.connected = false;
    broadcast({ type: 'status', connected: false });
    console.log('⚠️  MQTT rozłączony');
  });
}

function startDemoMode() {
  console.log('🎭 Demo mode');
  let t = 0;
  setInterval(() => {
    t += 0.1;
    deviceState.pvPower   = Math.round(600 + 200 * Math.sin(t) + Math.random() * 20);
    deviceState.loadPower = Math.round(300 + 100 * Math.sin(t * 0.7));
    deviceState.feedPower = Math.max(0, Math.round(deviceState.pvPower - deviceState.loadPower));
    deviceState.gridPower = -(deviceState.feedPower);
    deviceState.battSoc   = Math.round(50 + 30 * Math.sin(t * 0.1));
    deviceState.connected = true;
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
  }, 2000);
}

server.listen(PORT, () => {
  console.log(`🚀 Dashboard: http://localhost:${PORT}`);
  console.log(`📟 Device SN: ${DEVICE_SN || '(brak!)'}`);
  console.log(`🔑 Access Key: ${ACCESS_KEY ? ACCESS_KEY.substring(0, 8) + '...' : '(brak!)'}`);
  startMqtt();
});
