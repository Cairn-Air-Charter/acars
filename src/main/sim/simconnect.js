// The connection to MSFS 2020 or MSFS 2024 through SimConnect (flows/acars.md ACR-8), with
// the open-source node-simconnect package, which needs no extra Microsoft files. Runs in
// Electron's main process. ACARS only reads the simulator; it never writes to it (ACR-8).
//
// Emits: "status" ({ connected, inFlight, simulator, aircraft }), "sample" (once a second),
// "frame" (every frame near the ground at speed), "aircraft" (a new aircraft loaded),
// "crashed", "paused" (true/false).
"use strict";

const { EventEmitter } = require("events");
const vars = require("./variables");

const RETRY_MS = 5000;
const DEF = { second: 1, frame: 2, identity: 3, facility: 4 };
const REQ = { second: 1, frame: 2, identity: 3 };
const EVENTS = { simStart: 1, simStop: 2, pause: 3, pauseEx: 4, crashed: 5, crashReset: 6, aircraftLoaded: 7, flightLoaded: 8, positionChanged: 9, sim: 10 };
const FACILITY_REQUEST_BASE = 1000;

const READERS = { f: "readFloat64", i: "readInt32", s8: "readString8", s32: "readString32", s64: "readString64", s256: "readString256" };

function createSimConnection({ appName = "Cairn ACARS", log = () => {}, simconnect = require("node-simconnect") } = {}) {
  const events = new EventEmitter();
  const SC = simconnect;
  let handle = null;
  let simulator = null;
  let inFlight = false;
  let aircraft = null;
  let frameMode = false;
  let retryTimer = null;
  let stopped = false;
  const missing = new Set();
  let sendIds = new Map(); // SimConnect send id -> variable name, to drop unknown variables
  let lists = { second: [], frame: [], identity: [] };
  let facilityRequests = new Map();
  let nextFacilityRequest = FACILITY_REQUEST_BASE;

  function status() {
    return { connected: Boolean(handle), inFlight, simulator, aircraft, missing: [...missing] };
  }

  function publish() {
    events.emit("status", status());
  }

  const dataType = (type) => ({ f: SC.SimConnectDataType.FLOAT64, i: SC.SimConnectDataType.INT32, s8: SC.SimConnectDataType.STRING8, s32: SC.SimConnectDataType.STRING32, s64: SC.SimConnectDataType.STRING64, s256: SC.SimConnectDataType.STRING256 })[type];

  function define(defId, list) {
    handle.clearDataDefinition(defId);
    const kept = list.filter((v) => !missing.has(v.name));
    for (const v of kept) {
      const sendId = handle.addToDataDefinition(defId, v.name, v.units, dataType(v.type));
      sendIds.set(sendId, v.name);
    }
    return kept;
  }

  function defineAll() {
    sendIds = new Map();
    lists.second = define(DEF.second, vars.sampleVariables());
    lists.frame = define(DEF.frame, vars.frameVariables());
    lists.identity = define(DEF.identity, vars.identityVariables(simulator));
    handle.requestDataOnSimObject(REQ.second, DEF.second, SC.SimConnectConstants.OBJECT_ID_USER, SC.SimConnectPeriod.SECOND);
    handle.requestDataOnSimObject(REQ.identity, DEF.identity, SC.SimConnectConstants.OBJECT_ID_USER, SC.SimConnectPeriod.SECOND, SC.DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);
    setFrameMode(frameMode, true);
  }

  function setFrameMode(on, force) {
    if (!handle || (on === frameMode && !force)) return;
    frameMode = on;
    handle.requestDataOnSimObject(REQ.frame, DEF.frame, SC.SimConnectConstants.OBJECT_ID_USER, on ? SC.SimConnectPeriod.SIM_FRAME : SC.SimConnectPeriod.NEVER);
  }

  function read(data, list) {
    return list.map((v) => {
      try {
        return data[READERS[v.type]]();
      } catch {
        return null;
      }
    });
  }

  function onData(recv) {
    const now = Date.now();
    if (recv.requestID === REQ.identity) {
      const raw = read(recv.data, lists.identity);
      const info = {};
      lists.identity.forEach((v, i) => { info[v.field] = typeof raw[i] === "string" ? raw[i].trim() : raw[i]; });
      const next = {
        title: info.title || info.livery || null,
        designator: vars.designatorFrom(info.model),
        atcType: info.atcType || null,
        category: info.category || null,
      };
      const changed = !aircraft || aircraft.title !== next.title || aircraft.designator !== next.designator;
      aircraft = { ...(aircraft || {}), ...next };
      inFlight = Boolean(next.title);
      if (changed) events.emit("aircraft", aircraft);
      publish();
      return;
    }
    const list = recv.requestID === REQ.frame ? lists.frame : lists.second;
    const sample = vars.buildSample(list, read(recv.data, list), now);
    if (recv.requestID === REQ.second) {
      if (aircraft) {
        aircraft.floats = sample.floats === true;
        aircraft.engines = sample.nEng;
        aircraft.engineType = sample.engType;
        aircraft.maxGrossWeightLbs = sample.mgw;
      }
      // Every frame from the takeoff roll to 200 ft, and from 200 ft on approach to 30 kt
      setFrameMode((sample.gs || 0) > 30 && (sample.gnd === true || (sample.agl || 0) < 200));
      events.emit("sample", sample);
    } else {
      events.emit("frame", sample);
    }
  }

  function onException(recv) {
    const name = sendIds.get(recv.sendId);
    if (name && !missing.has(name)) {
      missing.add(name);
      log("simvar_missing", { name, simulator });
      // Rebuild without it, so one missing variable never breaks the rest
      setTimeout(() => handle && defineAll(), 0);
    }
  }

  // ---------------- Runways from the simulator (ACR-8) ----------------

  function defineFacility() {
    const fields = ["OPEN AIRPORT", "LATITUDE", "LONGITUDE", "ALTITUDE", "N_RUNWAYS",
      "OPEN RUNWAY", "LATITUDE", "LONGITUDE", "ALTITUDE", "HEADING", "LENGTH", "WIDTH",
      "PRIMARY_NUMBER", "PRIMARY_DESIGNATOR", "SECONDARY_NUMBER", "SECONDARY_DESIGNATOR", "SURFACE",
      "CLOSE RUNWAY", "CLOSE AIRPORT"];
    for (const field of fields) handle.addToFacilityDefinition(DEF.facility, field);
  }

  /** The runways at an airport, as landing ends (lat, lon, heading, length, width, surface). Empty if MSFS has none. */
  function requestRunways(icao) {
    if (!handle || !/^[A-Z0-9]{3,4}$/.test(String(icao || ""))) return Promise.resolve([]);
    const id = nextFacilityRequest++;
    return new Promise((resolve) => {
      const entry = { airport: null, runways: [], resolve };
      facilityRequests.set(id, entry);
      try {
        handle.requestFacilityData(DEF.facility, id, icao);
      } catch (error) {
        facilityRequests.delete(id);
        resolve([]);
        return;
      }
      setTimeout(() => finishFacility(id), 10000);
    });
  }

  function onFacilityData(recv) {
    const entry = facilityRequests.get(recv.userRequestId);
    if (!entry) return;
    const d = recv.data;
    if (recv.type === SC.FacilityDataType.AIRPORT) {
      entry.airport = { lat: d.readFloat64(), lon: d.readFloat64(), altitudeM: d.readFloat64(), runways: d.readInt32() };
    } else if (recv.type === SC.FacilityDataType.RUNWAY) {
      entry.runways.push({
        lat: d.readFloat64(), lon: d.readFloat64(), altitudeM: d.readFloat64(), heading: d.readFloat32(),
        lengthM: d.readFloat32(), widthM: d.readFloat32(), primaryNumber: d.readInt32(), primaryDesignator: d.readInt32(),
        secondaryNumber: d.readInt32(), secondaryDesignator: d.readInt32(), surface: d.readInt32(),
      });
    }
  }

  function finishFacility(id) {
    const entry = facilityRequests.get(id);
    if (!entry) return;
    facilityRequests.delete(id);
    const elevation = entry.airport ? entry.airport.altitudeM : null;
    entry.resolve(entry.runways.filter((r) => r.lengthM > 30).flatMap((r) => vars.runwayEnds(r, elevation)));
  }

  // ---------------- Connecting (retries every 5 seconds) ----------------

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RETRY_MS);
  }

  async function connect() {
    if (stopped || handle) return;
    try {
      const { recvOpen, handle: h } = await SC.open(appName, SC.Protocol.KittyHawk);
      handle = h;
      // MSFS 2024 reports application version 12 or later; MSFS 2020 reports 11
      simulator = recvOpen.applicationVersionMajor >= 12 || /sunrise|2024/i.test(recvOpen.applicationName) ? "msfs2024" : "msfs2020";
      log("sim_connected", { simulator, version: `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}` });
      handle.on("simObjectData", onData);
      handle.on("exception", onException);
      handle.on("facilityData", onFacilityData);
      handle.on("facilityDataEnd", (recv) => finishFacility(recv.userRequestId));
      handle.on("event", (recv) => {
        if (recv.clientEventId === EVENTS.crashed) events.emit("crashed");
        if (recv.clientEventId === EVENTS.pause) events.emit("paused", recv.data !== 0);
        if (recv.clientEventId === EVENTS.simStop) {
          inFlight = false;
          publish();
        }
      });
      handle.on("eventFilename", (recv) => {
        if (recv.clientEventId === EVENTS.aircraftLoaded) events.emit("aircraftLoaded", recv.fileName);
      });
      handle.on("quit", onClosed);
      handle.on("close", onClosed);
      handle.on("error", (error) => {
        log("sim_error", { message: error.message });
        onClosed();
      });
      const subscribe = [["SimStart", EVENTS.simStart], ["SimStop", EVENTS.simStop], ["Pause", EVENTS.pause], ["Pause_EX1", EVENTS.pauseEx],
        ["Crashed", EVENTS.crashed], ["CrashReset", EVENTS.crashReset], ["AircraftLoaded", EVENTS.aircraftLoaded],
        ["FlightLoaded", EVENTS.flightLoaded], ["PositionChanged", EVENTS.positionChanged], ["Sim", EVENTS.sim]];
      for (const [name, id] of subscribe) handle.subscribeToSystemEvent(id, name);
      defineAll();
      defineFacility();
      publish();
    } catch (error) {
      handle = null;
      scheduleRetry();
    }
  }

  function onClosed() {
    if (!handle) return;
    try {
      handle.close();
    } catch {
      /* already closed */
    }
    handle = null;
    inFlight = false;
    aircraft = null;
    frameMode = false;
    for (const id of [...facilityRequests.keys()]) finishFacility(id);
    log("sim_disconnected");
    publish();
    scheduleRetry();
  }

  return {
    events,
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      onClosed();
    },
    /** "Test connection" in Settings: try right away. */
    retryNow() {
      if (!handle) connect();
      return status();
    },
    requestRunways,
    status,
  };
}

module.exports = { createSimConnection, RETRY_MS };
