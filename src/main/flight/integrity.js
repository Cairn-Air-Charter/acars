// Integrity checks on the PC (flows/acars.md ACR-13). They never stop a flight; they're
// noted on the report, and the ones marked Review send it to Flight Operations. The server
// repeats them on the flight data file. Pure.
"use strict";

const geo = require("../../shared/geo");

const ACCIDENTAL_ACCELERATION_S = 30;
const RESUME_GRACE_MS = 120000;
const TIME_ACCELERATION_MESSAGE = "Time acceleration isn't used on Cairn flights. Set the sim rate back to 1×.";

function createIntegrityMonitor() {
  const state = {
    slew: false,
    jumps: 0,
    fuelUp: 0,
    aircraftChanged: false,
    fastMs: 0,
    maxRate: 1,
    pausedMs: 0,
    last: null,
    resumeUntil: 0,
    warnedRate: false,
  };

  /** Called after a simulator reconnect: slew and teleport don't count for 2 minutes (ACR-14). */
  function allowResume(t) {
    state.resumeUntil = t + RESUME_GRACE_MS;
    state.last = null;
  }

  /** Returns messages to show the pilot right away (time acceleration). */
  function update(s) {
    const messages = [];
    const last = state.last;
    const inResume = s.t <= state.resumeUntil;
    if (last) {
      const dt = s.t - last.t;
      if (last.paused === true && dt > 0) state.pausedMs += Math.min(dt, 60 * 60 * 1000);
      if (s.slew === true && !inResume) state.slew = true;
      if (dt > 0 && !inResume && last.paused !== true) {
        const allowed = Math.max(last.gs || 0, s.gs || 0) * (dt / 3600000) * 1.5 + 1;
        if (geo.distanceNm(last.lat, last.lon, s.lat, s.lon) > allowed) state.jumps += 1;
        if (last.gnd === false && s.gnd === false && typeof s.fuel === "number" && typeof last.fuel === "number" &&
          s.fuel - last.fuel > Math.max(5, last.fuel * 0.005)) state.fuelUp += 1;
      }
      if (typeof last.simRate === "number" && last.simRate > 1 && last.paused !== true) {
        state.fastMs += Math.min(dt, 10000);
        state.maxRate = Math.max(state.maxRate, last.simRate);
      }
    }
    if (typeof s.simRate === "number" && s.simRate > 1) {
      if (!state.warnedRate) messages.push(TIME_ACCELERATION_MESSAGE);
      state.warnedRate = true;
    } else {
      state.warnedRate = false;
    }
    state.last = { t: s.t, lat: s.lat, lon: s.lon, gs: s.gs, gnd: s.gnd, fuel: s.fuel, simRate: s.simRate, paused: s.paused };
    return messages;
  }

  function markAircraftChanged() {
    state.aircraftChanged = true;
  }

  /** The notes sent with the report: [{ code, text, review }] */
  function notes() {
    const list = [];
    if (state.slew) list.push({ code: "slew", text: "Slew mode was used during the flight", review: true });
    if (state.jumps) list.push({ code: "jump", text: "The aircraft's position jumped farther than it could have flown", review: true });
    if (state.fuelUp) list.push({ code: "fuel_up", text: "Fuel went up while airborne", review: true });
    if (state.aircraftChanged) list.push({ code: "aircraft_changed", text: "A different aircraft was loaded during the flight", review: true });
    const seconds = Math.round(state.fastMs / 1000);
    if (seconds > 0) {
      list.push({ code: "time_acceleration", text: `Time acceleration was used (${seconds} s, up to ${state.maxRate}×)`, review: seconds > ACCIDENTAL_ACCELERATION_S });
    }
    return list;
  }

  return {
    update,
    allowResume,
    markAircraftChanged,
    notes,
    get pausedSeconds() {
      return Math.round(state.pausedMs / 1000);
    },
    get timeAcceleration() {
      return { seconds: Math.round(state.fastMs / 1000), maxRate: state.maxRate };
    },
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: (saved) => Object.assign(state, saved, { last: null }),
  };
}

module.exports = { createIntegrityMonitor, ACCIDENTAL_ACCELERATION_S, TIME_ACCELERATION_MESSAGE };
