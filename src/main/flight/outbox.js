// The outbox (flows/acars.md ACR-12): reports, events and uploads that couldn't be sent wait
// here, saved on disk in the app's data folder, in order. When the connection comes back
// they go out in order with their original times. Nothing is lost if ACARS or Windows
// restarts. Re-sending is safe: the server ignores repeated sequence numbers.
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_REPORTS_PER_BATCH = 150;

/**
 * dir: folder for outbox.json. send(item) must resolve to one of:
 *   "sent"     the server has it; remove it
 *   "drop"     the server will never take it (for example the flight was cancelled); remove it
 *   "retry"    offline or the server is busy; stop and try again later
 *   "auth"     the session ended; stop until the pilot logs in again
 */
function createOutbox(dir, send) {
  const file = path.join(dir, "outbox.json");
  let items = [];
  let flushing = null;
  let sending = null; // the item on its way to the server: never add to it
  try {
    items = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(items));
    fs.renameSync(temp, file);
  }

  /** Adds position reports and events for a flight, merging into the last batch when possible. */
  function addPositions(flightId, reports, events) {
    const last = items[items.length - 1];
    if (last && last !== sending && last.kind === "positions" && last.flightId === flightId && last.reports.length + reports.length <= MAX_REPORTS_PER_BATCH) {
      last.reports.push(...reports);
      last.events.push(...events);
    } else {
      items.push({ kind: "positions", flightId, reports: [...reports], events: [...events] });
    }
    save();
  }

  function add(item) {
    items.push(item);
    save();
  }

  async function runFlush() {
    while (items.length) {
      sending = items[0];
      let result;
      try {
        result = await send(JSON.parse(JSON.stringify(sending)));
      } catch {
        result = "retry";
      } finally {
        sending = null;
      }
      if (result === "sent" || result === "drop") {
        items.shift();
        save();
        continue;
      }
      return result;
    }
    return "empty";
  }

  /**
   * Sends everything waiting, in order. Returns "empty", "retry" or "auth".
   * Only one flush runs at a time. It's marked finished in the same step that finds the
   * outbox empty, so anything added a moment later always starts a new flush.
   */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await null; // let the caller finish adding before the first send
      try {
        return await runFlush();
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  return {
    addPositions,
    add,
    flush,
    get size() {
      return items.reduce((n, item) => n + (item.kind === "positions" ? item.reports.length + item.events.length : 1), 0);
    },
    pendingFor(flightId) {
      return items.some((item) => item.flightId === flightId);
    },
    items: () => JSON.parse(JSON.stringify(items)),
  };
}

module.exports = { createOutbox, MAX_REPORTS_PER_BATCH };
