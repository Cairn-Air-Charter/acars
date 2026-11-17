// SayIntentions.AI in ACARS (flows/sayintentions.md SI-3, SI-5).
//
// - Whether SayIntentions is running comes from its local flight data on this PC
//   (http://localhost:43117/flightJSON), read every 15 seconds. That data also holds the
//   pilot's SayIntentions key and email: ACARS reads only whether a flight is active and
//   throws the rest away straight away. Nothing from it is saved, logged or sent anywhere.
// - ACARS never holds a SayIntentions key. Telexes are asked of Trailhead by type only;
//   Trailhead writes the words and calls SayIntentions itself.
"use strict";

const LOCAL_URL = "http://localhost:43117/flightJSON";
const POLL_MS = 15 * 1000;
const TIMEOUT_MS = 2000;

/** Only these two facts ever leave the parse: is it running, and is a flight active. */
function readLocal(data) {
  const details = data && typeof data === "object" ? data.flight_details : null;
  return { running: true, flight: Boolean(details && typeof details === "object" && details.flight_id) };
}

function createSayIntentionsWatch({ fetchImpl = fetch, onChange = () => {}, url = LOCAL_URL } = {}) {
  let state = { running: false, flight: false };
  let timer = null;

  async function poll() {
    let next = { running: false, flight: false };
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) next = readLocal(await response.json().catch(() => ({})));
    } catch {
      /* SayIntentions isn't running */
    }
    const changed = next.running !== state.running || next.flight !== state.flight;
    state = next;
    if (changed) onChange({ ...state });
    return state;
  }

  return {
    poll,
    start() {
      if (timer) return;
      poll();
      timer = setInterval(poll, POLL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    state: () => ({ ...state }),
  };
}

/**
 * Asks Trailhead for Cairn dispatch telexes (SI-5), only while the pilot has a key saved,
 * telexes are on in Settings, and SayIntentions is running with a flight. Trailhead applies
 * the limits (8 per flight, 60 seconds apart, each one once).
 */
const RETRY_MS = 65 * 1000;
const MAX_TRIES = 3;

function createTelexer({ api, prefs, watch, keySaved, log = () => {}, onSent = () => {}, later = (fn, ms) => setTimeout(fn, ms) }) {
  const asked = new Set();
  const tries = new Map();
  async function telex(flightId, type, messageId) {
    if (!flightId || prefs.get("telexes") === false || !keySaved() || !watch.state().flight) return { sent: false };
    const tag = `${flightId}:${type}:${messageId || ""}`;
    if (asked.has(tag)) return { sent: false };
    asked.add(tag);
    const result = await api.telex(flightId, type, messageId);
    const sent = Boolean(result.ok && result.data && result.data.sent);
    const reason = result.data ? result.data.reason : null;
    log("telex", { type, sent, reason });
    if (sent && typeof result.data.text === "string") onSent(result.data.text.slice(0, 128));
    // Held back by the 60-second gap: try again a little later, a few times at most
    const count = (tries.get(tag) || 0) + 1;
    tries.set(tag, count);
    if (!sent && reason === "limit" && count < MAX_TRIES) {
      asked.delete(tag);
      later(() => telex(flightId, type, messageId).catch(() => {}), RETRY_MS * count);
    }
    return { sent };
  }
  return telex;
}

/** The pre-flight checklist item (ACR-9): information only, never blocks. Not shown without a key. */
function checklistItem(state, keySaved) {
  if (!keySaved) return null;
  if (state.running && state.flight) {
    return { key: "sayIntentions", label: "SayIntentions", required: false, pass: true, detail: "SayIntentions is running. Cairn dispatch will reach you by ACARS telex." };
  }
  return { key: "sayIntentions", label: "SayIntentions", required: false, pass: false, detail: "SayIntentions isn't running. Start it if you want ATC and Cairn dispatch telexes." };
}

module.exports = { LOCAL_URL, POLL_MS, readLocal, createSayIntentionsWatch, createTelexer, checklistItem };
