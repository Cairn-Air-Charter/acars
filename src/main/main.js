// Cairn ACARS: the Electron main process (flows/acars.md Part A).
// Everything that touches SimConnect, the network or files on disk runs here, never in a
// screen (ACR-1). The screens talk to it only through the named functions in preload.js.
"use strict";

const { app, BrowserWindow, ipcMain, session, safeStorage, shell, Menu } = require("electron");
const path = require("path");
const os = require("os");
const { createApi, outboxResult, trailheadUrl } = require("./api");
const { createAuth } = require("./auth");
const { createPrefs } = require("./prefs");
const { createLogger } = require("./logger");
const { buildDiagnostics } = require("./diagnostics");
const { createOutbox } = require("./flight/outbox");
const { createFlightManager } = require("./flight/flight-manager");
const { evaluateChecks, checksSnapshot } = require("./flight/checks");
const { flightFilePath, pruneFlightFiles } = require("./flight/recorder");
const { createSimConnection } = require("./sim/simconnect");
const { createUpdater } = require("./updater");
const { isAllowedExternal } = require("./links");
const releaseNotes = require("./release-notes");
const { createSayIntentionsWatch, createTelexer, checklistItem } = require("./sayintentions");
const geo = require("../shared/geo");

const SYNC_EVERY_MS = 3 * 60 * 1000; // ACR-4
const OFFLINE_RETRY_MS = 30 * 1000;
const OUTBOX_RETRY_MS = 30 * 1000;
const NEAREST_EVERY_MS = 15 * 1000;
const FLIGHT_FILE_DAYS = 30;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  const dataDir = app.getPath("userData");
  const version = app.getVersion();
  const logger = createLogger(dataDir);
  const prefs = createPrefs(dataDir);
  // What changed opens by itself the first time ACARS starts after an update (VER-3)
  let showChangesOnStart = prefs.updatedTo(version);
  let ses = null;
  let api = null;
  let auth = null;
  let outbox = null;
  let flights = null;
  let updater = null;
  const sim = createSimConnection({ log: (event, details) => logger.info(event, details) });

  let home = null; // the last Home data, for the checklist and the Flight screen
  let options = null; // mission options (the aircraft catalog with designators)
  let markers = null; // the last sync markers
  let online = true;
  let lastSyncAt = null;
  let simPaused = false;
  let lastSample = null;
  let checklist = null; // { leg, runways, nearest, nearestAt }
  // SayIntentions (flows/sayintentions.md SI-3): whether Trailhead has it switched on and the
  // pilot has a key saved. Never the key itself.
  let siInfo = { available: false, keySaved: false };
  let siWatch = null;
  let telex = null;
  let welcomed = null; // the flight a welcome telex was asked for
  let reauthing = null;

  const send = (event, payload) => {
    if (window && !window.isDestroyed()) window.webContents.send(event, payload);
  };

  // ---------------- The window (ACR-1) ----------------

  function createWindow() {
    window = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: "#0B0D0F",
      title: "Cairn ACARS",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    Menu.setApplicationMenu(null);
    window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    window.once("ready-to-show", () => window.show());
    // One window: never navigate away or open another one. Links go to the browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternal(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("focus", () => syncNow("focus"));
    window.on("closed", () => {
      window = null;
    });
  }

  // ---------------- Sessions and login (ACR-3) ----------------

  async function onUnauthorized() {
    if (reauthing) return reauthing;
    reauthing = (async () => {
      await ses.clearStorageData({ storages: ["cookies"] });
      const result = await auth.resume();
      logger.info("session_ended", { silentLogin: result.ok });
      send("auth", authState(result.ok ? null : result.message));
      if (result.ok) flushOutbox();
      return result;
    })().finally(() => {
      setTimeout(() => { reauthing = null; }, 1000);
    });
    return reauthing;
  }

  function authState(message) {
    return {
      loggedIn: Boolean(auth.pilot),
      pilot: auth.pilot ? { firstName: auth.pilot.first_name, lastName: auth.pilot.last_name, employeeId: auth.pilot.employee_id, email: auth.pilot.email } : null,
      email: auth.email,
      rememberMe: auth.rememberMe,
      message: message || null,
      flightActive: flights.active,
    };
  }

  function locale() {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return { timeZone: resolved.timeZone, language: app.getLocale() };
  }

  // ---------------- Outbox (ACR-12) ----------------

  async function sendOutboxItem(item) {
    if (!auth.pilot) return "auth";
    if (item.kind === "positions") return outboxResult(await api.postPositions(item.flightId, { reports: item.reports, events: item.events }));
    if (item.kind === "cancel") return outboxResult(await api.cancel(item.flightId));
    if (item.kind === "submit") return outboxResult(await api.submit(item.flightId, item.body));
    if (item.kind === "data") {
      const fs = require("fs");
      const file = flightFilePath(dataDir, item.flightId);
      if (!fs.existsSync(file)) return "drop";
      const result = await api.uploadData(item.flightId, fs.readFileSync(file));
      // Not filed yet (it's still on its way): keep it and try again
      if (result.status === 409 && /File the flight report first/.test(result.error || "")) return "retry";
      return outboxResult(result);
    }
    return "drop";
  }

  async function flushOutbox() {
    const result = await outbox.flush();
    send("outbox", { waiting: outbox.size, result });
    if (result === "retry") setOnline(false);
    if (result === "empty") setOnline(true);
    return result;
  }

  // ---------------- Staying in sync (ACR-4) ----------------

  function setOnline(value) {
    if (online === value) return;
    online = value;
    send("connection", { online, lastSyncAt });
  }

  async function syncNow(reason) {
    if (!auth || !auth.pilot) return;
    const result = await api.sync();
    if (!result.ok) {
      if (result.status === 0) setOnline(false);
      return;
    }
    setOnline(true);
    lastSyncAt = new Date().toISOString();
    const next = result.data.markers;
    const changed = markers ? Object.keys(next).filter((k) => next[k] !== markers[k]) : Object.keys(next);
    markers = next;
    if (changed.length || reason === "focus") send("sync", { changed, lastSyncAt });
    if (changed.includes("messages") && markers) telexNewStaffMessages().catch(() => {});
    if (outbox.size) flushOutbox();
  }

  // ---------------- SayIntentions (flows/sayintentions.md SI-3, SI-5) ----------------

  function siView() {
    return { ...siWatch.state(), available: siInfo.available, keySaved: siInfo.keySaved, telexes: prefs.get("telexes") !== false };
  }

  async function refreshSayIntentions() {
    const result = await api.siStatus();
    if (!result.ok) return;
    const key = result.data.key || {};
    siInfo = { available: result.data.available === true, keySaved: key.saved === true && key.status !== "refused" };
    send("sayintentions", siView());
  }

  /** A staff message arrived during a flight: one telex per message, never its words (SI-5). */
  async function telexNewStaffMessages() {
    if (!flights.active) return;
    const result = await api.messages("inbox", 0);
    if (!result.ok) return;
    const fresh = result.data.messages.filter((m) => !m.read && m.fromStaff).slice(0, 3);
    for (const m of fresh) await telex(flights.flightId, "staff_message", m.id);
  }

  function startLoops() {
    siWatch.start();
    setInterval(() => syncNow("timer"), SYNC_EVERY_MS);
    setInterval(() => {
      if (!online) syncNow("offline");
    }, OFFLINE_RETRY_MS);
    setInterval(() => {
      if (outbox.size && auth.pilot) flushOutbox();
    }, OUTBOX_RETRY_MS);
  }

  // ---------------- The simulator, the checklist and the flight ----------------

  function aircraftInfo() {
    const st = sim.status();
    const loaded = st.aircraft || {};
    const catalog = (options && options.aircraft) || [];
    const match = loaded.designator ? catalog.find((a) => String(a.icao_code || "").toUpperCase() === loaded.designator) : null;
    return {
      details: { title: loaded.title || null, designator: loaded.designator || null, atcType: loaded.atcType || null, category: loaded.category || null,
        floats: loaded.floats === true, engines: loaded.engines ?? null, engineType: loaded.engineType ?? null, maxGrossWeightLbs: loaded.maxGrossWeightLbs ?? null },
      check: { known: Boolean(match), loadedType: match ? match.name : loaded.title || "an unknown aircraft", missionType: home && home.mission ? home.mission.aircraft : null },
    };
  }

  async function refreshNearest(sample) {
    if (!checklist || !sample || Date.now() - (checklist.nearestAt || 0) < NEAREST_EVERY_MS) return;
    checklist.nearestAt = Date.now();
    const result = await api.nearestAirports(sample.lat, sample.lon);
    if (checklist && result.ok) checklist.nearest = result.data.airports[0] || null;
  }

  function currentChecks() {
    if (!checklist) return null;
    const st = sim.status();
    const sample = lastSample ? { ...lastSample, paused: simPaused } : null;
    const result = evaluateChecks({
      sim: st,
      sample,
      leg: { departure: { code: checklist.leg.departure_code, lat: checklist.leg.departure_lat, lon: checklist.leg.departure_lon, type: checklist.leg.departure_type } },
      nearestAirport: checklist.nearest,
      aircraft: st.inFlight ? aircraftInfo().check : null,
      distances: home && home.settings ? home.settings.distances : null,
    });
    // SayIntentions: information only, never blocks Begin flight (SI-3)
    const si = siInfo.available ? checklistItem(siWatch.state(), siInfo.keySaved) : null;
    if (si) result.items.push(si);
    return result;
  }

  sim.events.on("status", (st) => {
    flights.onSimConnection(st.connected && st.inFlight);
    send("sim", st);
  });
  sim.events.on("aircraft", (info) => flights.onAircraftLoaded(info));
  sim.events.on("paused", (paused) => {
    simPaused = paused;
  });
  sim.events.on("crashed", () => {
    if (flights.active && lastSample) flights.onCrash({ ...lastSample, crash: 1, t: Date.now() });
  });
  sim.events.on("sample", (sample) => {
    const s = { ...sample, paused: simPaused };
    lastSample = s;
    if (flights.active) flights.onSample(s, "second");
    if (checklist) {
      refreshNearest(s);
      send("checks", currentChecks());
    }
  });
  sim.events.on("frame", (sample) => {
    if (flights.active) flights.onSample({ ...sample, paused: simPaused }, "frame");
  });

  // ---------------- Starting up ----------------

  app.whenReady().then(async () => {
    ses = session.fromPartition("persist:cairn-acars");
    const fetchImpl = (url, init) => ses.fetch(url, { ...init, credentials: "include", cache: "no-store" });
    api = createApi({ fetchImpl, baseUrl: trailheadUrl(), version, osVersion: os.release(), onUnauthorized: () => onUnauthorized() });
    auth = createAuth({ api, secrets: safeStorage, prefs, locale, clearSession: () => ses.clearStorageData({ storages: ["cookies"] }) });
    outbox = createOutbox(dataDir, sendOutboxItem);
    flights = createFlightManager({ dataDir, api, outbox, flushOutbox, version });
    for (const event of ["live", "feed", "landing", "warning", "crashed"]) flights.events.on(event, (payload) => send(event, payload));
    flights.events.on("changed", (view) => send("flight", view));
    flights.events.on("arrivalBriefing", (payload) => send("briefing", { ...payload, notes: (home && home.foqaNotes) || [] }));
    siWatch = createSayIntentionsWatch({ onChange: () => send("sayintentions", siView()) });
    telex = createTelexer({
      api,
      prefs,
      watch: siWatch,
      keySaved: () => siInfo.available && siInfo.keySaved,
      log: (e, d) => logger.info(e, d),
      onSent: (text) => flights.uplink(`Cairn dispatch telex: ${text}`),
    });
    // Within 50 nm of the destination: a FOQA note telex, when Trailhead has notes for it
    flights.events.on("arrivalBriefing", () => telex(flights.flightId, "foqa_note").catch(() => {}));
    // Engines off at the destination (not a diversion): the welcome telex
    flights.events.on("changed", (view) => {
      if (!view || view.phase !== "engines_off" || welcomed === view.id || !lastSample || !view.leg || !view.leg.arrival) return;
      if (geo.distanceNm(lastSample.lat, lastSample.lon, view.leg.arrival.lat, view.leg.arrival.lon) > 5) return;
      welcomed = view.id;
      telex(view.id, "welcome").catch(() => {});
    });

    logger.prune();
    pruneFlightFiles(dataDir, FLIGHT_FILE_DAYS, Date.now());
    logger.info("app_started", { version, os: os.release() });
    app.setLoginItemSettings({ openAtLogin: prefs.get("startWithWindows") === true });
    registerIpc();
    createWindow();
    sim.start();
    updater = createUpdater({ log: (e, d) => logger.info(e, d), flightActive: () => flights.active, notify: (state) => send("update", state) });
    updater.start();
    startLoops();
  });

  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (updater) updater.beforeQuit();
    sim.stop();
  });

  // ---------------- What the screens can ask for (preload.js) ----------------

  function registerIpc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (_event, ...args) => {
        try {
          return await fn(...args);
        } catch (error) {
          logger.error("ipc_failed", { channel, message: error.message });
          return { ok: false, error: "Something went wrong on our end. Try again in a minute. If it keeps happening, email chief.pilot@cairncharter.org." };
        }
      });

    handle("auth:state", async () => {
      const result = await auth.resume();
      if (result.ok) {
        const active = await api.activeFlight();
        if (active.ok) flights.restore(active.data.flight);
        options = (await api.missionOptions()).data || null;
        syncNow("login");
      }
      return authState(result.ok ? null : result.message);
    });
    handle("auth:login", async ({ email, password, remember }) => {
      const result = await auth.login(email, password, remember);
      if (!result.ok) return { ...authState(result.message), type: result.type, applyUrl: result.applyUrl, retryAfterSeconds: result.retryAfterSeconds };
      const active = await api.activeFlight();
      if (active.ok) flights.restore(active.data.flight);
      options = (await api.missionOptions()).data || null;
      flushOutbox();
      syncNow("login");
      return authState();
    });
    handle("auth:logout", async () => {
      await auth.logout();
      return authState();
    });
    handle("auth:setRemember", (on) => {
      auth.setRememberMe(on === true);
      return authState();
    });

    handle("home:get", async () => {
      const result = await api.home();
      if (result.ok) {
        home = result.data;
        refreshSayIntentions().catch(() => {});
      }
      else if (result.status === 0) setOnline(false);
      return { ...result, lastSyncAt };
    });
    handle("missions:options", async () => {
      const result = await api.missionOptions();
      if (result.ok) options = result.data;
      return result;
    });
    handle("missions:list", (query) => api.missions(query || {}));
    handle("missions:get", (id) => api.mission(id));
    handle("missions:preview", (id) => api.takePreview(id));
    handle("missions:take", async (id) => {
      const result = await api.takeMission(id);
      syncNow("took");
      return result;
    });
    handle("missions:drop", async (id) => {
      if (flights.active) return { ok: false, error: "Finish or cancel your flight first." };
      const result = await api.dropMission(id);
      syncNow("dropped");
      return result;
    });
    handle("logbook:get", ({ limit, offset }) => api.logbook(limit, offset));
    handle("report:get", (id) => api.report(id));
    handle("notices:dismiss", (id) => api.dismissNotice(id));

    // Messages: the same inbox as Trailhead's Messages page (flows/messages.md MSG-5)
    handle("messages:list", ({ box, offset } = {}) => api.messages(["inbox", "sent", "archived"].includes(box) ? box : "inbox", offset));
    handle("messages:get", (id) => api.message(id));
    handle("messages:send", (message) => api.sendMessage(message || {}));
    handle("messages:reply", ({ id, body } = {}) => api.reply(id, body));
    handle("messages:archive", ({ id, archived } = {}) => api.archive(id, archived === true));
    handle("messages:recipients", () => api.recipients());
    // Optional notices: the same setting as the Trailhead profile (MSG-2)
    handle("notices:get", () => api.subscriptions());
    handle("notices:save", (subscriptions) => api.saveSubscriptions(subscriptions || {}));

    handle("sim:status", () => sim.status());
    handle("sim:test", () => sim.retryNow());

    handle("flight:checklist", async (legId) => {
      const leg = home && home.mission ? home.mission.legs.find((l) => l.id === legId && l.state === "next") : null;
      if (!leg) return { ok: false, error: "That leg isn't the next one on your mission. Legs are flown in order." };
      checklist = { leg, runways: { departure: [], arrival: [] }, nearest: null, nearestAt: 0 };
      // Runway data straight from MSFS, so it matches the scenery (ACR-8)
      Promise.all([sim.requestRunways(leg.departure_code), sim.requestRunways(leg.arrival_code)]).then(([departure, arrival]) => {
        if (checklist && checklist.leg.id === legId) checklist.runways = { departure, arrival };
      });
      return { ok: true, checks: currentChecks() };
    });
    handle("flight:closeChecklist", () => {
      checklist = null;
      return { ok: true };
    });
    handle("flight:begin", async () => {
      const checks = currentChecks();
      if (!checklist || !checks || !checks.ready) return { ok: false, error: "Every required check needs to be green first." };
      const st = sim.status();
      const leg = checklist.leg;
      const result = await flights.begin({
        leg: {
          id: leg.id,
          passengers: leg.passengers,
          departure: { code: leg.departure_code, name: leg.departure_name, lat: leg.departure_lat, lon: leg.departure_lon, elevationFt: leg.departure_elevation_ft, type: leg.departure_type },
          arrival: { code: leg.arrival_code, name: leg.arrival_name, lat: leg.arrival_lat, lon: leg.arrival_lon, elevationFt: leg.arrival_elevation_ft, type: leg.arrival_type },
        },
        mission: home.mission,
        simulator: st.simulator,
        sample: lastSample,
        aircraft: aircraftInfo().details,
        checks: checksSnapshot(checks),
        runways: checklist.runways,
        intervals: home.settings.intervals,
        distances: home.settings.distances,
        crashDetectionOff: lastSample.crashOn === false,
      });
      if (result.ok) {
        checklist = null;
        // Cairn dispatch: the leg, load and due time on the cockpit printer (SI-5)
        telex(flights.flightId, "start").catch(() => {});
      }
      logger.info("flight_begin", { ok: result.ok, status: result.status });
      return result.ok ? { ok: true, flight: flights.view() } : { ok: false, error: result.message, status: result.status };
    });
    handle("flight:view", () => flights.view());
    handle("flight:cancel", async () => {
      const result = await flights.cancel();
      syncNow("cancelled");
      return result;
    });
    handle("flight:arrival", () => flights.arrivalCheck());
    handle("flight:file", async (diversion) => {
      const result = await flights.file(diversion || null);
      logger.info("flight_file", { ok: result.ok, needsReason: Boolean(result.needsReason) });
      if (result.ok) syncNow("filed");
      return result;
    });

    handle("settings:get", () => ({ ...prefs.visible(), hasSavedPassword: auth.hasSavedPassword() }));
    handle("settings:set", ({ key, value }) => {
      if (key === "chime") prefs.set("chime", value === true);
      if (key === "telexes") {
        prefs.set("telexes", value === true);
        send("sayintentions", siView());
      }
      if (key === "startWithWindows") {
        prefs.set("startWithWindows", value === true);
        app.setLoginItemSettings({ openAtLogin: value === true });
      }
      return prefs.visible();
    });
    // SayIntentions: the pill, Settings and the ATIS box (SI-3, SI-6). Only airport codes go out.
    handle("sayintentions:status", () => siView());
    handle("sayintentions:atis", async (codes) => {
      const clean = (Array.isArray(codes) ? codes : []).map((c) => String(c).toUpperCase()).filter((c) => /^[A-Z0-9]{3,4}$/.test(c)).slice(0, 4);
      if (!clean.length || !siInfo.keySaved) return { ok: true, airports: {} };
      const result = await api.atis(clean);
      return result.ok ? { ok: true, airports: result.data.airports || {} } : { ok: false, airports: {} };
    });
    handle("app:info", () => ({ version, commit: releaseNotes.commit(), logsFolder: logger.folder, trailhead: api.baseUrl, update: updater ? updater.state() : null }));
    // What changed (flows/versions.md VER-3): the notes that shipped with this version
    handle("app:changes", () => ({ ok: true, version, commit: releaseNotes.commit(), entries: releaseNotes.load() }));
    // Answers true once per start after an update, so the panel opens only the first time
    handle("app:justUpdated", () => {
      const updated = showChangesOnStart;
      showChangesOnStart = false;
      return { updated };
    });
    handle("app:checkUpdates", () => updater.checkNow());
    handle("app:openExternal", (url) => {
      if (!isAllowedExternal(url)) return { ok: false };
      shell.openExternal(url);
      return { ok: true };
    });
    handle("app:diagnostics", async (note) => {
      const zip = buildDiagnostics(logger, flights.view(), { version, os: os.release(), sim: sim.status(), outboxWaiting: outbox.size });
      const result = await api.diagnostics(zip, typeof note === "string" ? note.trim() : "");
      logger.info("diagnostics_sent", { ok: result.ok });
      return result.ok ? { ok: true, message: result.data.message } : { ok: false, error: result.error };
    });
  }
}
