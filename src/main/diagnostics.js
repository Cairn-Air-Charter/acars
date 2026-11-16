// Send diagnostics (flows/acars.md ACR-17): only when the pilot presses the button, the last
// 3 days of ACARS logs and the current flight's state are packed into a zip file and
// uploaded to the pilot's account for staff to look at. Logs never hold passwords, session
// cookies or personal details (logger.js). A small zip writer, so no extra package is needed.
"use strict";

const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** files: [{ name, content (Buffer or string) }] -> a zip file (deflate) as a Buffer */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The diagnostics package: the last 3 days of logs plus the flight state, never the saved login. */
function buildDiagnostics(logger, flightView, appInfo) {
  const files = logger.recent(3).map((f) => ({ name: `logs/${f.name}`, content: f.content }));
  files.push({ name: "app.json", content: JSON.stringify(appInfo, null, 2) });
  files.push({ name: "flight.json", content: JSON.stringify(flightView || { activeFlight: null }, null, 2) });
  return zip(files);
}

module.exports = { crc32, zip, buildDiagnostics };
