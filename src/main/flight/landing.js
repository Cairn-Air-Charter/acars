// The preliminary landing card (flows/acars.md ACR-10): worked out on the PC right after
// touchdown. "Preliminary. Your final numbers come with your flight report." The final
// numbers are always the server's (FOQA-2). Pure.
"use strict";

const geo = require("../../shared/geo");

/**
 * Keeps the samples around a landing and works out the numbers.
 * ends: runway ends at the destination from MSFS ({ ident, lat, lon, headingTrue, lengthFt, widthFt, displacedFt })
 */
function createLandingTracker({ ends, light, gateFt }) {
  const recent = []; // the last 2 minutes of samples
  let touchdown = null;
  let bounces = 0;

  function update(sample) {
    recent.push(sample);
    while (recent.length && sample.t - recent[0].t > 120000) recent.shift();
  }

  /** Called on touchdown; returns the preliminary numbers known right away. */
  function onTouchdown(sample) {
    touchdown = sample;
    bounces = 0;
    return result();
  }

  function onBounce() {
    bounces += 1;
  }

  function result() {
    if (!touchdown) return null;
    const after = recent.filter((s) => s.t >= touchdown.t && s.t <= touchdown.t + 2000);
    const before = recent.filter((s) => s.t < touchdown.t);
    // MSFS keeps the previous touchdown's values (0 at the start of a flight) and updates them
    // a moment after the wheels touch. Only values that changed belong to this landing.
    const last = before[before.length - 1] || {};
    const tdSample = recent.find((s) => s.t >= touchdown.t && s.t <= touchdown.t + 3000 && typeof s.tdV === "number" && s.tdV > 0 &&
      (s.tdV !== last.tdV || s.tdLat !== last.tdLat || s.tdLon !== last.tdLon)) || null;
    // Without it: the steepest descent in the last 1.5 s in the air
    const sinks = before.filter((s) => s.t >= touchdown.t - 1500 && s.gnd === false && typeof s.vs === "number").map((s) => -s.vs);
    const fpm = tdSample ? tdSample.tdV : sinks.length ? Math.max(0, ...sinks) : null;
    const g = after.reduce((m, s) => (typeof s.g === "number" ? Math.max(m, s.g) : m), touchdown.g || 1);
    const lat = tdSample && typeof tdSample.tdLat === "number" ? tdSample.tdLat : touchdown.lat;
    const lon = tdSample && typeof tdSample.tdLon === "number" ? tdSample.tdLon : touchdown.lon;
    const out = { fpm: fpm === null ? null : Math.round(fpm), g: Math.round(g * 100) / 100, bounces };

    const end = geo.runwayFor(ends, lat, lon, touchdown.hdgT || touchdown.trk || 0);
    if (end) {
      const f = geo.runwayFrame(end, lat, lon);
      out.runway = end.ident;
      out.distanceFt = Math.round(f.along - (end.displacedFt || 0));
      out.centerlineFt = Math.round(Math.abs(f.cross));
    }
    // A simple stable check at the gate: sink under 1,000 fpm and modest bank
    const elevation = end && typeof end.elevationFt === "number" ? end.elevationFt : null;
    const atGate = before.find((s) => (elevation !== null ? s.alt - elevation : s.agl) <= (gateFt || (light ? 500 : 1000)));
    if (atGate) out.stable = (atGate.vs || 0) > -1000 && Math.abs(atGate.bank || 0) <= (light ? 20 : 15);
    return out;
  }

  /** The status line: "Landed: 180 fpm, 1,140 ft down runway 26." */
  function statusText() {
    const r = result();
    if (!r || r.fpm === null) return "Landed.";
    if (typeof r.distanceFt === "number" && r.runway) {
      return `Landed: ${r.fpm} fpm, ${r.distanceFt.toLocaleString("en-US")} ft down runway ${r.runway}.`;
    }
    return `Landed: ${r.fpm} fpm.`;
  }

  return { update, onTouchdown, onBounce, result, statusText };
}

module.exports = { createLandingTracker };
