// The flight data file (flows/acars.md ACR-12): every once-a-second sample, plus the
// every-frame samples around takeoff and landing, written to a compressed file on the PC as
// it happens. Every few seconds the waiting lines are written as their own gzip member and
// appended; gzip readers read joined members as one file. So an ACARS or MSFS crash loses
// at most the last few seconds, and the file is still readable.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const FLUSH_EVERY_MS = 5000;

function flightFilePath(dir, flightId) {
  return path.join(dir, "flights", `${Number(flightId)}.jsonl.gz`);
}

function createRecorder(dir, flightId, header) {
  const file = flightFilePath(dir, flightId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let waiting = [];
  let lastFlush = 0;
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!exists && header) waiting.push(JSON.stringify({ type: "header", ...header }));

  function flush() {
    if (!waiting.length) return;
    fs.appendFileSync(file, zlib.gzipSync(`${waiting.join("\n")}\n`));
    waiting = [];
  }

  return {
    file,
    /** Adds one sample (or event with type "event"). nowMs decides when to write to disk. */
    write(row, nowMs) {
      waiting.push(JSON.stringify(row));
      if (nowMs - lastFlush >= FLUSH_EVERY_MS) {
        flush();
        lastFlush = nowMs;
      }
    },
    flush,
    read() {
      flush();
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
  };
}

/** Deletes flight data files older than the given days (they're uploaded by then). */
function pruneFlightFiles(dir, days, nowMs) {
  const folder = path.join(dir, "flights");
  if (!fs.existsSync(folder)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(folder)) {
    const full = path.join(folder, name);
    if (nowMs - fs.statSync(full).mtimeMs > days * 86400000) {
      fs.unlinkSync(full);
      removed += 1;
    }
  }
  return removed;
}

module.exports = { createRecorder, flightFilePath, pruneFlightFiles, FLUSH_EVERY_MS };
