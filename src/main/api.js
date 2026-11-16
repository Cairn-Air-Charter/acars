// Talking to Trailhead (flows/acars.md ACR-3, SRV-1, SRV-6). ACARS uses the same routes as
// the website. The session cookie lives in ACARS's own private, persistent cookie store
// (an Electron session partition), like a browser. The Cloudflare edge key is never in ACARS.
// Every request says who it is: User-Agent "CairnACARS/<version> (Windows <version>)" and
// the X-Cairn-ACARS-Version header (ACR-2).
"use strict";

const TRAILHEAD_URL = "https://trailhead.cairncharter.org";

/**
 * Where Trailhead is. Normally the real address. For testing on a developer's PC, the
 * CAIRN_TRAILHEAD_URL setting can point ACARS at another https address or at this PC.
 */
function trailheadUrl(env = process.env) {
  const custom = String(env.CAIRN_TRAILHEAD_URL || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(custom) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(custom)) return custom;
  return TRAILHEAD_URL;
}
const TIMEOUT_MS = 20000;
const GENERIC_ERROR = "Something went wrong on our end. Try again in a minute. If it keeps happening, email chief.pilot@cairncharter.org.";

/**
 * fetchImpl: the session's fetch (session.fromPartition(...).fetch) or a fake in tests.
 * onUnauthorized: called whenever Trailhead answers 401 (the session ended, TH-3).
 */
/**
 * The diagnostics note, cut to 500 whole characters (never half an emoji) and URL-encoded.
 * Anything that still can't be encoded is replaced, so the upload never fails over a note.
 */
function encodeNote(note) {
  const text = Array.from(String(note)).slice(0, 500).join("");
  return encodeURIComponent(text.toWellFormed ? text.toWellFormed() : text.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
}

/** A message's public ID, or a placeholder the server answers 404 to. */
function messageId(id) {
  const text = String(id || "");
  return /^[a-z0-9]{9}$/.test(text) ? text : "not-found";
}

function createApi({ fetchImpl, baseUrl = TRAILHEAD_URL, version, osVersion, onUnauthorized = () => {} }) {
  const userAgent = `CairnACARS/${version} (Windows ${osVersion})`;

  async function request(method, path, { json, body, contentType, extraHeaders } = {}) {
    const headers = { ...(extraHeaders || {}), "User-Agent": userAgent, "X-Cairn-ACARS-Version": version, Accept: "application/json" };
    let payload;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      headers["Content-Type"] = contentType || "application/octet-stream";
      payload = body;
    }
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      return { ok: false, status: 0, offline: true, error: "You're offline. ACARS will keep trying.", data: {} };
    }
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (response.status === 401 && path !== "/api/auth/login") onUnauthorized();
    const ok = response.ok && data.success !== false;
    return { ok, status: response.status, data, error: ok ? null : data.error || GENERIC_ERROR };
  }

  const get = (path) => request("GET", path);
  const post = (path, json) => request("POST", path, { json: json === undefined ? {} : json });

  return {
    userAgent,
    baseUrl,
    login: (email, password, timeZone, language) => post("/api/auth/login", { email, password, timeZone, language }),
    logout: () => post("/api/auth/logout"),
    me: () => get("/api/auth/me"),
    home: () => get("/api/acars/home"),
    sync: () => get("/api/acars/sync"),
    missionOptions: () => get("/api/missions/options"),
    missions: (query) => get(`/api/missions?${new URLSearchParams(query)}`),
    mission: (id) => get(`/api/missions/${Number(id)}`),
    takePreview: (id) => get(`/api/missions/${Number(id)}/take-preview`),
    takeMission: (id) => post(`/api/missions/${Number(id)}/take`),
    dropMission: (id) => post(`/api/my/mission/${Number(id)}/drop`),
    logbook: (limit, offset) => get(`/api/my/logbook?limit=${Number(limit)}&offset=${Number(offset)}`),
    // Flight reports use a random 9-character public ID (FR-6)
    report: (id) => get(`/api/flights/${encodeURIComponent(String(id))}`),
    dismissNotice: (id) => post(`/api/my/notices/${Number(id)}/dismiss`),
    nearestAirports: (lat, lon) => get(`/api/acars/airports/nearest?lat=${Number(lat)}&lon=${Number(lon)}`),
    startFlight: (body) => post("/api/acars/flights", body),
    activeFlight: () => get("/api/acars/flights/active"),
    postPositions: (id, body) => post(`/api/acars/flights/${Number(id)}/positions`, body),
    submit: (id, body) => post(`/api/acars/flights/${Number(id)}/submit`, body),
    uploadData: (id, buffer) => request("PUT", `/api/acars/flights/${Number(id)}/data`, { body: buffer, contentType: "application/gzip" }),
    cancel: (id) => post(`/api/acars/flights/${Number(id)}/cancel`),
    // The pilot's optional note goes in a header, URL-encoded (flows/messages.md MSG-7)
    diagnostics: (zip, note) =>
      request("POST", "/api/acars/diagnostics", {
        body: zip,
        contentType: "application/zip",
        extraHeaders: note ? { "X-Cairn-Diagnostics-Note": encodeNote(note) } : undefined,
      }),
    // Messages: the same routes as Trailhead's Messages page (flows/messages.md MSG-9).
    // Message IDs are random 9-character public IDs.
    messages: (box, offset) => get(`/api/messages?box=${encodeURIComponent(box)}&offset=${Number(offset) || 0}`),
    message: (id) => get(`/api/messages/${messageId(id)}`),
    sendMessage: ({ to, subject, body }) => post("/api/messages", { to, subject, body }),
    reply: (id, body) => post(`/api/messages/${messageId(id)}/reply`, { body }),
    archive: (id, archived) => post(`/api/messages/${messageId(id)}/${archived ? "archive" : "unarchive"}`),
    recipients: () => get("/api/messages/recipients"),
    subscriptions: () => get("/api/my/subscriptions"),
    saveSubscriptions: (subscriptions) => request("PUT", "/api/my/subscriptions", { json: { subscriptions } }),
  };
}

/**
 * How the outbox reads a server answer: sent, drop (the server will never take it),
 * retry (offline or busy) or auth (log in again).
 */
function outboxResult(response) {
  if (response.ok) return "sent";
  if (response.status === 0 || response.status >= 500 || response.status === 429) return "retry";
  if (response.status === 401) return "auth";
  return "drop";
}

module.exports = { TRAILHEAD_URL, GENERIC_ERROR, trailheadUrl, createApi, outboxResult };
