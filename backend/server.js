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
  pvPower: 0, pv1Power: 0, pv2Power: 0,
  gridPower: 0, feedPower: 0, fromGrid: 0,
  loadPower: 0, battPower: 0, battSoc: 0,
  acVoltage: 0, acFreq: 0, acCurrent: 0,
  pv1Voltage: 0, pv2Voltage: 0,
  pv1Current: 0, pv2Current: 0,
  invTemp: 0, gridStatus: '', feedGridMode: 0,
};

let history = { feed: [], pv1: [], pv2: [], timestamps: [] };
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
  history.pv1.push(deviceState.pv1Power);
  history.pv2.push(deviceState.pv2Power);
  if (history.timestamps.length > MAX_HISTORY) {
    ['timestamps','feed','pv1','pv2'].forEach(k => history[k].shift());
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
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;

  // PV - rzeczywiste nazwy z BK01Z
  set('powGetPv',            'pv1Power',   r1);
  set('powGetPv2',           'pv2Power',   r1);
  // pvPower = suma PV1+PV2
  if (params['powGetPv'] !== undefined || params['powGetPv2'] !== undefined) {
    deviceState.pvPower = Math.round(((deviceState.pv1Power||0) + (deviceState.pv2Power||0)) * 10) / 10;
    updated = true;
  }
  set('powGetPvSum',         'pvPower',    r1); // fallback jeśli dostępne

  // Sieć
  set('gridConnectionPower', 'gridPower',  r1);
  set('gridConnectionVol',   'acVoltage',  r1);
  set('gridConnectionFreq',  'acFreq',     r2);
  set('gridConnectionAmp',   'acCurrent',  r2);

  // Feed-in = gridConnectionPower ujemny
  if (params['gridConnectionPower'] !== undefined) {
    const g = params['gridConnectionPower'];
    deviceState.feedPower  = g < 0 ? r1(Math.abs(g)) : 0;
    deviceState.fromGrid   = g > 0 ? r1(g) : 0;
    updated = true;
  }

  // Obciążenie domu
  set('powGetSysLoad',       'loadPower',  r1);

  // Bateria
  set('powGetBpCms',         'battPower',  r1);
  set('cmsBattSoc',          'battSoc',    r1);
  set('feedGridMode',        'feedGridMode', v => v);

  // PV napięcia i prądy
  set('plugInInfoPvVol',     'pv1Voltage', r1);
  set('plugInInfoPv2Vol',    'pv2Voltage', r1);
  set('plugInInfoPvAmp',     'pv1Current', r2);
  set('plugInInfoPv2Amp',    'pv2Current', r2);

  // Temperatura
  set('invNtcTemp3',         'invTemp',    v => v);

  // Status połączenia
  set('gridConnectionSta',   'gridStatus', v => v);

  if (updated) {
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
    console.log(`📊 pv1=${deviceState.pv1Power}W pv2=${deviceState.pv2Power}W grid=${deviceState.gridPower}W feed=${deviceState.feedPower}W load=${deviceState.loadPower}W`);
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
        console.log('📨 MQTT keys:', Object.keys(params).join(', '));
        console.log('📨 MQTT vals:', JSON.stringify(params).substring(0, 400));
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
