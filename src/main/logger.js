// ACARS's own log files (flows/acars.md ACR-17): one file a day in the app's data folder,
// kept 14 days. They never contain passwords, session cookies, or anyone's personal
// details: every line is passed through redact() before it's written.
"use strict";

const fs = require("fs");
const path = require("path");

const KEEP_DAYS = 14;
const SECRET_KEYS = /pass(word)?|cookie|token|secret|session|authorization|email|name/i;

/** Removes anything that could be private from a value before logging it. */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/connect\.sid=[^;\s]+/gi, "connect.sid=[removed]");
  }
  if (typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) out[key] = SECRET_KEYS.test(key) ? "[removed]" : redact(v, depth + 1);
  return out;
}

function dayStamp(date) {
  return date.toISOString().slice(0, 10);
}

function createLogger(dir, now = () => new Date()) {
  const folder = path.join(dir, "logs");
  fs.mkdirSync(folder, { recursive: true });

  function write(level, event, details) {
    const time = now();
    const line = JSON.stringify({ time: time.toISOString(), level, event, ...(details ? { details: redact(details) } : {}) });
    try {
      fs.appendFileSync(path.join(folder, `acars-${dayStamp(time)}.log`), `${line}\n`);
    } catch {
      /* logging must never break the app */
    }
  }

  function prune() {
    const cutoff = now().getTime() - KEEP_DAYS * 86400000;
    for (const name of fs.readdirSync(folder)) {
      const match = /^acars-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(folder, name));
    }
  }

  /** The last `days` days of log files: [{ name, content }] */
  function recent(days) {
    const cutoff = now().getTime() - days * 86400000;
    return fs.readdirSync(folder)
      .filter((name) => {
        const match = /^acars-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
        return match && Date.parse(`${match[1]}T23:59:59Z`) >= cutoff;
      })
      .sort()
      .map((name) => ({ name, content: fs.readFileSync(path.join(folder, name)) }));
  }

  return {
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details),
    prune,
    recent,
    folder,
  };
}

module.exports = { createLogger, redact, KEEP_DAYS };
