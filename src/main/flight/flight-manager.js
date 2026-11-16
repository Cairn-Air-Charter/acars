// One ACARS flight from Begin flight to the filed report (flows/acars.md ACR-9 to ACR-16).
// Runs in Electron's main process. Everything it needs comes in as arguments (the API, the
// outbox, the data folder), so tests drive it with a fake simulator and a fake server.
"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const geo = require("../../shared/geo");
const { createPhaseDetector, LIGHT_CLASSES, PHASE_LABELS } = require("./phases");
const { createReportClock } = require("./reporting");
const { createIntegrityMonitor } = require("./integrity");
const { createLandingTracker } = require("./landing");
const { createRecorder } = require("./recorder");
const { atAirportNm } = require("./checks");

const RESUME_DISTANCE_NM = 2;
const RESUME_ALTITUDE_FT = 1000;
const RESUME_SPEED_KT = 60;
const OFF_AIRPORT_NM = 25;

const MESSAGES = {
  lostSim: "Lost MSFS. Your flight is saved. Reload the aircraft where you were and ACARS will pick back up.",
  resumed: (minutes) => `Resumed after a simulator disconnect (${minutes} min).`,
  crash: (departure) => `Looks like that one ended in a crash. The flight isn't credited and you're still at ${departure}. The leg's still on your mission whenever you want to try again.`,
  // Shown on Home only; no message is sent when a report is filed (ACR-16)
  filed: (arrival) => `Report sent. You're now at ${arrival}.`,
  offline: "You're offline. Your flight is safe; send the report again when you're back online.",
  notAtAirport: "You're not at an airport. What happened?",
  diverted: (actual, name, planned) => `You're at ${actual} (${name}), not ${planned}. What happened?`,
};

/** Same rule as the server (ACR-16 steps 2-5). */
function decideArrival(planned, nearest, distances) {
  if (planned && planned.distanceNm <= atAirportNm(planned.type, distances)) return { kind: "planned", airport: planned };
  const at = (nearest || []).find((a) => a.distanceNm <= atAirportNm(a.type, distances));
  if (at) return { kind: "diversion", airport: at };
  const close = (nearest || []).find((a) => a.distanceNm <= ((distances && distances.off_airport_nm) || OFF_AIRPORT_NM));
  return { kind: "off_airport", airport: close || (nearest || [])[0] || planned };
}

/**
 * deps:
 *   dataDir   the app's data folder (active-flight.json and flight data files live here)
 *   api       { startFlight, submit, nearestAirports }
 *   outbox    from outbox.js; flushOutbox() sends it
 *   flushOutbox
 *   version   the ACARS version
 */
function createFlightManager(deps) {
  const events = new EventEmitter();
  const stateFile = path.join(deps.dataDir, "active-flight.json");
  let flight = null; // the active flight's saved state
  let detector = null;
  let clock = null;
  let integrity = null;
  let landing = null;
  let recorder = null;
  let lastSample = null;
  let lastFull = null; // the latest full (once-a-second) reading
  let lastSecond = 0;
  let simConnected = false;
  let waitingToResume = false;
  let crashing = false;

  function save() {
    if (!flight) return;
    flight.detector = detector.snapshot();
    flight.integrity = integrity.snapshot();
    fs.mkdirSync(deps.dataDir, { recursive: true });
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(flight));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  }

  function clear() {
    flight = null;
    detector = clock = integrity = landing = recorder = null;
    waitingToResume = false;
    crashing = false;
    try {
      fs.unlinkSync(stateFile);
    } catch {
      /* already gone */
    }
    events.emit("changed", view());
  }

  function setUp(saved) {
    flight = saved;
    detector = createPhaseDetector({
      destination: flight.leg.arrival,
      light: flight.light,
      runways: { departure: flight.runways.departure || [], arrival: flight.runways.arrival || [] },
    });
    if (saved.detector) detector.restore(saved.detector);
    clock = createReportClock(flight.intervals);
    integrity = createIntegrityMonitor();
    if (saved.integrity) integrity.restore(saved.integrity);
    landing = createLandingTracker({ ends: flight.runways.arrival || [], light: flight.light });
    recorder = createRecorder(deps.dataDir, flight.id, { version: 1, flightId: flight.id, acarsVersion: deps.version, simulator: flight.simulator });
  }

  // ---------------- Feed for the Flight screen ----------------

  function feed(message, t, kind = "status") {
    flight.feed.unshift({ t, message, kind });
    flight.feed = flight.feed.slice(0, 200);
    events.emit("feed", { t, message, kind });
  }

  function addEvent(e) {
    const event = { seq: flight.eventSeq++, t: e.t, type: e.type, phase: e.phase || detector.phase, message: e.message || null, details: e.details || {} };
    flight.pendingEvents.push(event);
    recorder.write({ type: "event", ...event }, e.t);
    if (event.message) feed(event.message, event.t, event.type);
    return event;
  }

  function queueReport(sample) {
    const report = { seq: flight.reportSeq++, sample: { ...sample, ph: detector.phase } };
    deps.outbox.addPositions(flight.id, [report], flight.pendingEvents.splice(0));
    deps.flushOutbox();
  }

  // ---------------- Starting (ACR-9) ----------------

  /**
   * input: { leg, mission, simulator, sample, aircraft, checks, runways: { departure, arrival },
   *          intervals, distances, crashDetectionOff }
   * Returns { ok: true } or { ok: false, message }.
   */
  async function begin(input) {
    if (flight) return { ok: false, message: "You already have a flight in progress." };
    const response = await deps.api.startFlight({
      missionLegId: input.leg.id,
      simulator: input.simulator,
      position: { lat: input.sample.lat, lon: input.sample.lon, gs: input.sample.gs || 0, onGround: input.sample.gnd === true },
      checks: input.checks,
      aircraft: input.aircraft,
    });
    if (!response.ok) return { ok: false, status: response.status, message: response.error };
    const light = LIGHT_CLASSES.has(input.mission.aircraft_class) || input.aircraft.engineType === 0;
    setUp({
      id: response.data.flight.id,
      startedAt: response.data.flight.startedAt,
      leg: input.leg,
      mission: { id: input.mission.id, title: input.mission.title, type: input.mission.mission_type, aircraft: input.mission.aircraft, passengers: input.leg.passengers },
      simulator: input.simulator,
      aircraft: input.aircraft,
      light,
      intervals: input.intervals,
      distances: input.distances,
      runways: input.runways || {},
      crashDetectionOff: Boolean(input.crashDetectionOff),
      reportSeq: 0,
      eventSeq: 0,
      pendingEvents: [],
      feed: [],
      fuelStart: input.sample.fuel ?? null,
      flownNm: 0,
      resumes: [],
      landing: null,
      lastPosition: null,
    });
    addEvent({ t: input.sample.t, type: "phase", phase: "preflight", message: "Flight started. Preflight." });
    queueReport(input.sample);
    save();
    events.emit("changed", view());
    return { ok: true };
  }

  /** After ACARS or Windows restarts mid-flight: pick the saved flight back up (ACR-14). */
  function restore(activeOnServer) {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      saved = null;
    }
    if (!activeOnServer) {
      if (saved) clear();
      return false;
    }
    if (!saved || saved.id !== activeOnServer.id) return false;
    setUp(saved);
    waitingToResume = true;
    feed("Welcome back. Reload the aircraft where you were and ACARS will pick back up.", Date.now());
    events.emit("changed", view());
    return true;
  }

  // ---------------- Samples ----------------

  /** Every reading from the simulator. kind: "second" (once a second) or "frame". */
  function onSample(raw, kind = "second") {
    if (!flight || crashing) return;
    // Quick readings carry only the fast-changing values; the rest comes from the latest
    // full reading, so the phase logic never sees, for example, missing engine state.
    // The file keeps the quick reading as it came (the server fills it in the same way).
    const sample = kind === "frame" && lastFull ? { ...lastFull, ...raw } : raw;
    if (kind === "second") lastFull = raw;
    if (waitingToResume && !tryResume(sample)) return;
    recorder.write(kind === "frame" ? { ...raw, hz: "f" } : raw, raw.t);
    landing.update(sample);

    const changes = detector.update(sample);
    let changed = false;
    for (const c of changes) {
      if (c.type === "phase") {
        changed = true;
        const message = c.phase === "landed" ? null : c.message;
        addEvent({ t: sample.t, type: "phase", phase: c.phase, message: message || PHASE_LABELS[c.phase] });
      } else if (c.type === "oooi") {
        changed = true;
        addEvent({ t: sample.t, type: "oooi", details: { which: c.which } });
      } else if (c.type === "status") {
        addEvent({ t: sample.t, type: "status", message: c.message });
      } else if (c.type === "touchdown") {
        if (c.bounce) landing.onBounce();
        else if (!c.touchAndGo) {
          landing.onTouchdown(sample);
          // Peak G needs the 2 seconds after touchdown, so the card waits 3 seconds
          flight.landingDueAt = sample.t + 3000;
        }
      }
    }
    if (flight.landingDueAt && sample.t >= flight.landingDueAt) {
      flight.landingDueAt = null;
      flight.landing = landing.result();
      feed(landing.statusText(), sample.t, "landing");
      events.emit("landing", flight.landing);
    }

    if (kind === "second") {
      if (lastSample && sample.t - lastSecond >= 900) {
        if (detector.oooi.out && sample.paused !== true) flight.flownNm += geo.distanceNm(lastSample.lat, lastSample.lon, sample.lat, sample.lon);
      }
      lastSecond = sample.t;
      for (const message of integrity.update(sample)) {
        feed(message, sample.t, "warning");
        events.emit("warning", message);
      }
      if (sample.paused === true && !(lastSample && lastSample.paused)) addEvent({ t: sample.t, type: "pause", message: "Paused." });
      if (sample.paused !== true && lastSample && lastSample.paused === true) addEvent({ t: sample.t, type: "resume", message: "Unpaused." });
    }

    const reason = clock.due(sample, changed);
    if (reason) {
      queueReport(sample);
      save();
    }
    flight.lastPosition = { t: sample.t, lat: sample.lat, lon: sample.lon, alt: sample.alt, gs: sample.gs, gnd: sample.gnd };
    lastSample = sample;
    events.emit("live", liveData(sample));

    // A crash ends the flight on the spot (ACR-16)
    if ((sample.crash || 0) > 0 || (sample.crashSeq || 0) > 0) onCrash(sample);
  }

  function liveData(s) {
    const dest = flight.leg.arrival;
    const distanceNm = dest ? geo.distanceNm(s.lat, s.lon, dest.lat, dest.lon) : null;
    const eteMinutes = distanceNm !== null && s.gs > 30 ? Math.round((distanceNm / s.gs) * 60) : null;
    if (distanceNm !== null && distanceNm <= 50 && !flight.briefed && s.gnd === false) {
      flight.briefed = true;
      events.emit("arrivalBriefing", { code: dest.code });
    }
    return {
      phase: detector.phase,
      phaseLabel: PHASE_LABELS[detector.phase],
      oooi: detector.oooi,
      altitudeFt: s.alt, ias: s.ias, gs: s.gs, vs: s.vs, heading: s.hdgM ?? s.hdgT, fuelLbs: s.fuel, fuelFlowPph: s.fuelFlow,
      distanceNm, eteMinutes, paused: s.paused === true,
      waitingToSend: deps.outbox.size,
    };
  }

  // ---------------- Disconnects and resuming (ACR-14) ----------------

  function onSimConnection(connected) {
    const was = simConnected;
    simConnected = connected;
    if (flight && was && !connected) {
      waitingToResume = true;
      flight.disconnectedAt = Date.now();
      feed(MESSAGES.lostSim, Date.now(), "warning");
      addEvent({ t: Date.now(), type: "disconnect", message: null });
      save();
      events.emit("changed", view());
    }
  }

  /** Resume when the aircraft is back within 2 nm and 1,000 ft (on the ground: the same airport) with a similar speed. */
  function tryResume(s) {
    const last = flight.lastPosition;
    if (!last) {
      waitingToResume = false;
      return true;
    }
    const distance = geo.distanceNm(last.lat, last.lon, s.lat, s.lon);
    const close = last.gnd ? distance <= 3 && s.gnd === true : distance <= RESUME_DISTANCE_NM && Math.abs((s.alt || 0) - (last.alt || 0)) <= RESUME_ALTITUDE_FT;
    const speedOk = Math.abs((s.gs || 0) - (last.gs || 0)) <= RESUME_SPEED_KT;
    if (!close || !speedOk) return false;
    waitingToResume = false;
    integrity.allowResume(s.t);
    const gapS = Math.max(0, Math.round((s.t - last.t) / 1000));
    flight.resumes.push({ at: new Date(s.t).toISOString(), seconds: gapS });
    addEvent({ t: s.t, type: "resume", message: MESSAGES.resumed(Math.round(gapS / 60)), details: { at: new Date(s.t).toISOString(), seconds: gapS } });
    lastSample = null;
    save();
    events.emit("changed", view());
    return true;
  }

  function onAircraftLoaded(info) {
    if (!flight || !info) return;
    const before = flight.aircraft || {};
    if ((before.title && info.title && before.title !== info.title) || (before.designator && info.designator && before.designator !== info.designator)) {
      integrity.markAircraftChanged();
      addEvent({ t: Date.now(), type: "aircraft", message: "A different aircraft was loaded.", details: { changed: true, title: info.title } });
      save();
    }
  }

  // ---------------- Cancelling (ACR-14) ----------------

  async function cancel() {
    if (!flight) return { ok: true };
    deps.outbox.add({ kind: "cancel", flightId: flight.id });
    deps.flushOutbox();
    const departure = flight.leg.departure.code;
    clear();
    return { ok: true, message: `Flight cancelled. You're still at ${departure}.` };
  }

  // ---------------- Filing (ACR-16) ----------------

  function submitBody(extra) {
    const s = lastSample || {};
    return {
      final: { ...s },
      oooi: Object.fromEntries(Object.entries(detector.oooi).map(([k, v]) => [k, v ? new Date(v).toISOString() : null])),
      fuelStartLbs: flight.fuelStart,
      fuelEndLbs: typeof s.fuel === "number" ? s.fuel : null,
      flownDistanceNm: Math.round(flight.flownNm * 10) / 10,
      pausedSeconds: integrity.pausedSeconds,
      timeAcceleration: integrity.timeAcceleration,
      integrity: integrity.notes(),
      resumes: flight.resumes,
      landing: flight.landing,
      crashDetectionOff: flight.crashDetectionOff,
      aircraft: flight.aircraft,
      runways: flight.runways.arrival || [],
      ...extra,
    };
  }

  /** Where are we parked? (ACR-16 steps 2-5) Returns { kind, airport } using the server's airport list. */
  async function arrivalCheck() {
    const s = lastSample;
    const dest = flight.leg.arrival;
    const planned = { ...dest, distanceNm: geo.distanceNm(s.lat, s.lon, dest.lat, dest.lon) };
    const nearest = await deps.api.nearestAirports(s.lat, s.lon);
    const list = nearest.ok ? nearest.data.airports : [];
    const result = decideArrival(planned, list, flight.distances);
    let question = null;
    if (result.kind === "diversion") question = MESSAGES.diverted(result.airport.code, result.airport.name, dest.code);
    if (result.kind === "off_airport") question = MESSAGES.notAtAirport;
    return { ...result, question, summary: summary() };
  }

  function summary() {
    const o = detector.oooi;
    const blockMinutes = o.out && o.in ? Math.round((o.in - o.out) / 60000) : null;
    return {
      route: `${flight.leg.departure.code}–${flight.leg.arrival.code}`,
      blockMinutes,
      fuelUsedLbs: flight.fuelStart !== null && lastSample && typeof lastSample.fuel === "number" ? Math.round(flight.fuelStart - lastSample.fuel) : null,
      landing: flight.landing,
    };
  }

  /**
   * Sends the report: the outbox first, then the report, then the flight data file.
   * diversion: { code, text } when the aircraft isn't at the planned destination.
   * Returns { ok, message } or { ok: false, needsReason, arrival } or { ok: false, message }.
   */
  async function file(diversion) {
    if (!flight || !lastSample) return { ok: false, message: "There's no flight to file." };
    if (detector.phase !== "engines_off") return { ok: false, message: "Shut down the engines first, then file." };
    const flushed = await deps.flushOutbox();
    if (flushed === "retry") return { ok: false, message: MESSAGES.offline };
    if (flushed === "auth") return { ok: false, message: "Log in again to send your report. Your flight is safe." };
    const response = await deps.api.submit(flight.id, submitBody(diversion ? { diversion } : {}));
    if (!response.ok) {
      if (response.data && response.data.code === "reason_needed") {
        const a = response.data.arrival;
        return { ok: false, needsReason: true, arrival: a, question: a.offAirport ? MESSAGES.notAtAirport : MESSAGES.diverted(a.code, a.name, flight.leg.arrival.code) };
      }
      if (response.status === 0) return { ok: false, message: MESSAGES.offline };
      return { ok: false, message: response.error };
    }
    deps.outbox.add({ kind: "data", flightId: flight.id });
    deps.flushOutbox();
    const arrival = response.data.arrival.code;
    clear();
    return { ok: true, message: MESSAGES.filed(arrival), arrival };
  }

  /** A crash files itself, denied, on the spot (ACR-16). It waits in the outbox if offline. */
  function onCrash(sample) {
    if (!flight || crashing) return;
    crashing = true;
    addEvent({ t: sample.t, type: "crash", message: "Crashed." });
    queueReport(sample);
    lastSample = sample;
    const departure = flight.leg.departure.code;
    deps.outbox.add({ kind: "submit", flightId: flight.id, body: submitBody({ crashed: true }) });
    deps.outbox.add({ kind: "data", flightId: flight.id });
    deps.flushOutbox();
    clear();
    events.emit("crashed", MESSAGES.crash(departure));
  }

  function view() {
    if (!flight) return null;
    return {
      id: flight.id,
      leg: flight.leg,
      mission: flight.mission,
      phase: detector.phase,
      phaseLabel: PHASE_LABELS[detector.phase],
      oooi: detector.oooi,
      feed: flight.feed,
      landing: flight.landing,
      waitingToResume,
      canFile: detector.phase === "engines_off",
    };
  }

  return {
    events,
    begin,
    restore,
    onSample,
    onSimConnection,
    onAircraftLoaded,
    onCrash,
    cancel,
    arrivalCheck,
    file,
    view,
    get active() {
      return Boolean(flight);
    },
    get flightId() {
      return flight ? flight.id : null;
    },
  };
}

module.exports = { createFlightManager, decideArrival, MESSAGES };
