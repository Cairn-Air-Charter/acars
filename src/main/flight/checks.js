// The pre-flight checklist (flows/acars.md ACR-9). Each item turns green or red live, every
// second. Begin flight stays disabled until every required item is green. Pure functions.
"use strict";

const geo = require("../../shared/geo");

const WATER = 2;
const DEFAULT_DISTANCES = { normal_nm: 3, large_nm: 5 };

function atAirportNm(type, distances) {
  const d = { ...DEFAULT_DISTANCES, ...(distances || {}) };
  return type === "large_airport" ? d.large_nm : d.normal_nm;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * input:
 *   sim: { connected, inFlight } (inFlight: an aircraft is loaded in a flight, not in the menus)
 *   sample: the latest reading (sample fields), or null
 *   leg: { departure: { code, lat, lon, type } }
 *   nearestAirport: { code, distanceNm } where the aircraft actually is, or null
 *   aircraft: { loadedType, missionType, known } (FR-9, information only)
 *   distances: the acars_airport_distances setting
 * Returns { items: [{ key, label, required, pass, detail }], ready }.
 */
function evaluateChecks({ sim, sample, leg, nearestAirport, aircraft, distances }) {
  const items = [];
  const add = (key, label, required, pass, detail) => items.push({ key, label, required, pass, detail: detail || null });
  const s = sample || {};
  const connected = Boolean(sim && sim.connected && sim.inFlight && sample);

  add("simConnected", "MSFS connected", true, connected, connected ? null : sim && sim.connected ? "Load an aircraft into a flight in MSFS." : "Start MSFS and load your aircraft.");

  const dep = leg && leg.departure;
  if (connected && dep) {
    const distance = geo.distanceNm(s.lat, s.lon, dep.lat, dep.lon);
    const allowed = atAirportNm(dep.type, distances);
    const pass = distance <= allowed;
    let detail = `${round1(distance)} nm from ${dep.code}.`;
    if (!pass) {
      detail = nearestAirport && nearestAirport.code && nearestAirport.code !== dep.code
        ? `You're at ${nearestAirport.code}, ${round1(distance)} nm from ${dep.code}. Move to ${dep.code} to start.`
        : `You're ${round1(distance)} nm from ${dep.code}. Move to ${dep.code} to start.`;
    }
    add("atDeparture", `At ${dep.code}`, true, pass, detail);
  } else {
    add("atDeparture", dep ? `At ${dep.code}` : "At the departure airport", true, false, "Waiting for MSFS.");
  }

  const onWater = s.surf === WATER || (s.floats === true && s.gnd === true && s.surf === WATER);
  add("onGround", "On the ground", true, connected && s.gnd === true, connected && s.gnd !== true ? "Land, or load the aircraft on the ground." : null);

  if (onWater) {
    // On water the parking brake can't hold anything, so being stopped is enough
    const stopped = connected && (s.gs || 0) < 1;
    add("parkingBrake", "Stopped on the water", true, stopped, stopped ? null : "Come to a stop.");
  } else {
    add("parkingBrake", "Parking brake set", true, connected && s.pbrk === true, connected && s.pbrk !== true ? "Set the parking brake." : null);
  }

  add("notMoving", "Not moving", true, connected && (s.gs || 0) < 1, connected && (s.gs || 0) >= 1 ? "Come to a full stop." : null);

  const crashOn = s.crashOn !== false;
  add("crashDetection", "Crash detection on", false, connected && crashOn,
    connected && !crashOn ? "Crash detection is off in MSFS. You can still fly; ACARS just can't tell if the flight ends in a crash." : null);

  const normalRate = connected && (s.simRate === undefined || s.simRate === 1) && s.slew !== true;
  add("simRate", "Normal simulation rate", true, normalRate,
    connected && !normalRate ? (s.slew === true ? "Turn off slew mode." : "Set the sim rate back to 1×.") : null);

  if (aircraft) {
    let detail;
    if (!aircraft.known) detail = "We don't recognize this aircraft yet. You can still fly it; staff will look at the report.";
    else if (aircraft.missionType && aircraft.loadedType !== aircraft.missionType) {
      detail = `The mission calls for a ${aircraft.missionType}, but you're flying a ${aircraft.loadedType}. That's fine; your report and FOQA will use the ${aircraft.loadedType}.`;
    } else detail = `Aircraft: ${aircraft.loadedType}.`;
    add("aircraft", "Aircraft type", false, true, detail);
  }

  const ready = items.filter((i) => i.required).every((i) => i.pass);
  return { items, ready };
}

/** The checklist as the snapshot sent with Begin flight. */
function checksSnapshot(result) {
  const snapshot = {};
  for (const item of result.items) snapshot[item.key] = { pass: item.pass, detail: item.detail };
  return snapshot;
}

module.exports = { evaluateChecks, checksSnapshot, atAirportNm };
