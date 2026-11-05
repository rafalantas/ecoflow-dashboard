'use strict';
const protobuf = require('protobufjs');
const path     = require('path');

// Mapowanie cmdFunc -> cmdId -> nazwa wiadomosci
const STREAM_MAP = {
  '32':  { '2': 'CMSHeartBeatReport', '50': 'BMSHeartBeatReport' },
  '254': { '17': 'ConfigWrite', '18': 'ConfigWriteAck', '21': 'DisplayPropertyUpload', '22': 'RuntimePropertyUpload' }
};
const METER_MAP = {
  '254': { '21': 'DisplayPropertyUpload', '22': 'RuntimePropertyUpload' }
};

// Header proto - wspolny dla wszystkich urzadzen
const HEADER_PROTO = `
syntax = "proto3";
message Header {
  bytes pdata    = 1;
  int32 src      = 2;
  int32 dest     = 3;
  int32 d_src    = 4;
  int32 d_dest   = 5;
  int32 enc_type = 6;
  int32 check_type = 7;
  int32 cmd_func = 8;
  int32 cmd_id   = 9;
  int32 data_len = 10;
  int32 need_ack = 11;
  int32 is_ack   = 12;
  int32 seq      = 14;
  int32 product_id = 15;
  int32 version  = 16;
  int32 payload_ver = 17;
  int32 time_snap = 18;
  int32 is_rw_cmd = 19;
  int32 is_queue  = 20;
  int32 ack_type  = 21;
  string code     = 22;
  string from     = 23;
  string module_sn = 24;
  string device_sn = 25;
}
message HeaderMessage { repeated Header header = 1; }
`;

let headerRoot   = null;
let streamRoot   = null;
let meterRoot    = null;

async function init() {
  headerRoot = await protobuf.parse(HEADER_PROTO).root;
  streamRoot = await protobuf.load(path.join(__dirname, 'stream.proto'));
  meterRoot  = await protobuf.load(path.join(__dirname, 'meter.proto'));
  console.log('✅ ef_decoder: protobuf zaladowany');
}

function decode(payload, isMeter) {
  if (!headerRoot) return [];
  const results = [];
  try {
    const HeaderMessage = headerRoot.lookupType('HeaderMessage');
    const msg = HeaderMessage.decode(payload);
    if (!msg.header) return [];

    const root   = isMeter ? meterRoot   : streamRoot;
    const msgMap = isMeter ? METER_MAP   : STREAM_MAP;

    for (const hdr of msg.header) {
      const cf = String(hdr.cmdFunc);
      const ci = String(hdr.cmdId);
      const msgName = msgMap[cf]?.[ci];
      if (!msgName || !hdr.pdata?.length) continue;

      try {
        const MsgType = root.lookupType(msgName);
        const decoded = MsgType.toObject(MsgType.decode(hdr.pdata), {
          longs: Number, enums: Number, defaults: false, arrays: true, objects: true
        });
        results.push({ [msgName]: decoded });
      } catch(e) {
        // nieznany typ lub blad dekodowania pdata
      }
    }
  } catch(e) {
    // blad dekodowania headera
  }
  return results;
}

module.exports = { init, decode };
