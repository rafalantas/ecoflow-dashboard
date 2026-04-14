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

function makeSignedHeaders(accessKey, secretKey, params = {}) {
  const nonce = String(100000 + Math.floor(Math.random() * 100000));
  const timestamp = String(Date.now());
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
  let dataStr = '';
  if (Object.keys(params).length > 0) {
    const flat = flattenKeys(params);
    const sortedKeys = Object.keys(flat).sort();
    dataStr = sortedKeys.map(k => `${k}=${flat[k]}`).join('&') + '&';
  }
  const sigStr = `${dataStr}accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const sign = crypto.createHmac('sha256', secretKey).update(sigStr).digest('hex');
  return { 'Content-Type': 'application/json;charset=UTF-8', accessKey, nonce, timestamp, sign };
}

async function ecoflowGet(url, accessKey, secretKey, params = {}) {
  const headers = makeSignedHeaders(accessKey, secretKey, params);
  // For GET: params in query string (already included in signature via makeSignedHeaders)
  const qs = Object.keys(params).length > 0
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&') : '';
  console.log(`🌐 GET ${API_HOST}${url}${qs}`);
  const resp = await axios.get(`${API_HOST}${url}${qs}`, { headers, timeout: 10000 });
  return resp.data;
}

const PORT       = process.env.PORT          || 8080;
const DEVICE_SN  = process.env.DEVICE_SN     || '';
const ACCESS_KEY = process.env.EF_ACCESS_KEY || '';
const SECRET_KEY = process.env.EF_SECRET_KEY || '';
const API_HOST   = 'https://api-e.ecoflow.com';

let deviceState = {
  connected: false, lastUpdate: null,
  feedPower: 0, pv1Power: 0, pv2Power: 0, pvTotal: 0,
  acVoltage: 0, pv1Voltage: 0, pv2Voltage: 0,
  pv1Temp: 0, pv2Temp: 0, pv1Current: 0, pv2Current: 0,
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
  const set = (key, field, factor) => {
    if (params[key] !== undefined && params[key] !== null) {
      const val = Math.round(params[key] * factor * 10) / 10;
      if (Math.abs((deviceState[field] || 0) - val) > 0.05) {
        deviceState[field] = val; updated = true;
      }
    }
  };
  set('20_1.invOutputWatts', 'feedPower',   0.1);
  set('invOutputWatts',      'feedPower',   0.1);
  set('20_1.pv1InputWatts',  'pv1Power',    0.1);
  set('pv1InputWatts',       'pv1Power',    0.1);
  set('20_1.pv2InputWatts',  'pv2Power',    0.1);
  set('pv2InputWatts',       'pv2Power',    0.1);
  set('20_1.pvInputWatts',   'pvTotal',     0.1);
  set('pvInputWatts',        'pvTotal',     0.1);
  set('20_1.invOutputVol',   'acVoltage',   0.1);
  set('invOutputVol',        'acVoltage',   0.1);
  set('20_1.pv1OpVolt',      'pv1Voltage',  0.01);
  set('pv1OpVolt',           'pv1Voltage',  0.01);
  set('20_1.pv2OpVolt',      'pv2Voltage',  0.01);
  set('pv2OpVolt',           'pv2Voltage',  0.01);
  set('20_1.pv1Temp',        'pv1Temp',     0.1);
  set('pv1Temp',             'pv1Temp',     0.1);
  set('20_1.pv2Temp',        'pv2Temp',     0.1);
  set('pv2Temp',             'pv2Temp',     0.1);
  set('20_1.pv1InputCur',    'pv1Current',  0.1);
  set('pv1InputCur',         'pv1Current',  0.1);
  set('20_1.pv2InputCur',    'pv2Current',  0.1);
  set('pv2InputCur',         'pv2Current',  0.1);

  if (updated && deviceState.pvTotal === 0 && (deviceState.pv1Power > 0 || deviceState.pv2Power > 0)) {
    deviceState.pvTotal = Math.round((deviceState.pv1Power + deviceState.pv2Power) * 10) / 10;
  }
  if (updated) {
    deviceState.lastUpdate = new Date().toISOString();
    recordHistory();
    broadcast({ type: 'state', data: deviceState });
  }
  return updated;
}

async function getMqttCredentials() {
  console.log('🔑 Pobieranie MQTT credentials z Open API...');
  const data = await ecoflowGet('/iot-open/sign/certification', ACCESS_KEY, SECRET_KEY);
  if (data.code !== '0') throw new Error(`API error ${data.code}: ${data.message}`);
  console.log(`✅ Credentials OK — account: ${data.data.certificateAccount}`);
  return data.data;
}

async function fetchAllQuotas() {
  try {
    const data = await ecoflowGet('/iot-open/sign/device/quota/all', ACCESS_KEY, SECRET_KEY, { sn: DEVICE_SN });
    if (data.code === '0' && data.data) {
      const updated = applyParams(data.data);
      if (updated) {
        const pv1 = deviceState.pv1Power, pv2 = deviceState.pv2Power, feed = deviceState.feedPower;
        console.log(`📊 REST: feed=${feed}W pv1=${pv1}W pv2=${pv2}W`);
      } else {
        console.log('📊 REST quota: OK (brak zmian)');
      }
    } else {
      console.warn(`⚠️  REST quota: ${data.message} (code: ${data.code})`);
    }
  } catch (e) {
    console.error('❌ REST quota failed:', e.message);
  }
}

async function startMqtt() {
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('❌ Brak EF_ACCESS_KEY lub EF_SECRET_KEY!');
    startDemoMode(); return;
  }
  if (!DEVICE_SN) { console.error('❌ Brak DEVICE_SN!'); return; }

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

  const quotaTopic = `/open/${creds.certificateAccount}/${DEVICE_SN}/quota`;

  client.on('connect', () => {
    console.log('✅ MQTT połączony (Open API)!');
    deviceState.connected = true;
    broadcast({ type: 'status', connected: true });
    client.subscribe(quotaTopic, err => {
      if (err) console.error('❌ Subscribe error:', err.message);
      else console.log(`📡 Subskrybuję: ${quotaTopic}`);
    });
    // Pobierz dane przez REST natychmiast
    fetchAllQuotas();
    // REST co 30s jako backup
    setInterval(fetchAllQuotas, 30000);
    // Poproś urządzenie o dane przez MQTT (get_reply)
    setTimeout(() => {
      const setTopic = `/open/${creds.certificateAccount}/${DEVICE_SN}/set_reply`;
      const getMsg = JSON.stringify({
        id: String(Date.now()),
        version: '1.0',
        sn: DEVICE_SN,
        params: { quotas: ['20_1.invOutputWatts','20_1.pv1InputWatts','20_1.pv2InputWatts','20_1.pvInputWatts','20_1.invOutputVol','20_1.pv1OpVolt','20_1.pv2OpVolt','20_1.pv1Temp','20_1.pv2Temp'] }
      });
      client.publish(`/open/${creds.certificateAccount}/${DEVICE_SN}/quota`, getMsg);
      console.log('📤 Wysłano żądanie danych przez MQTT');
    }, 2000);
  });

  client.on('message', (topic, payload) => {
    try {
      const str = payload.toString('utf8');
      if (!str.startsWith('{')) return;
      const data = JSON.parse(str);
      const params = data.params || data;
      if (params && typeof params === 'object') {
        const updated = applyParams(params);
        if (updated) {
          console.log(`📨 MQTT: feed=${deviceState.feedPower}W pv1=${deviceState.pv1Power}W pv2=${deviceState.pv2Power}W`);
        }
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
    deviceState.feedPower  = Math.round(400 + 200 * Math.sin(t) + Math.random() * 20);
    deviceState.pv1Power   = Math.round(deviceState.feedPower / 2 + (Math.random() - 0.5) * 10);
    deviceState.pv2Power   = Math.round(deviceState.feedPower - deviceState.pv1Power);
    deviceState.pvTotal    = deviceState.pv1Power + deviceState.pv2Power;
    deviceState.acVoltage  = 230 + Math.round(Math.random() * 4 - 2);
    deviceState.pv1Voltage = Math.round((38 + Math.random() * 2) * 10) / 10;
    deviceState.pv2Voltage = Math.round((38 + Math.random() * 2) * 10) / 10;
    deviceState.pv1Temp    = Math.round((35 + Math.random() * 5) * 10) / 10;
    deviceState.pv2Temp    = Math.round((35 + Math.random() * 5) * 10) / 10;
    deviceState.connected  = true;
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
