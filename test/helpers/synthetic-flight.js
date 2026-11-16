// Synthetic flights for tests (flows/acars.md SRV-8). Until real MSFS recordings replace
// them, these stand in for recorded flight data files. Made-up places only; no real pilots.
// Identical copy in Trailhead (test/helpers/synthetic-flight.js) and ACARS
// (test/helpers/synthetic-flight.js). Change both at the same time.
//
// The flight is simulated in a flat frame anchored at the arrival runway's threshold:
// x runs along the runway heading (feet, negative = before the threshold), y to the right.
// The departure runway lies on the same line, D nm before the arrival.
"use strict";

const FT_PER_NM = 6076.12;
const EARTH_FT = 20902231;
const KT_TO_FTS = 1.68781;

// A made-up arrival runway near nowhere in particular (open water and empty land)
const DEFAULT_FIELD = { lat: 45.0, lon: -100.0, headingTrue: 90, lengthFt: 7000, widthFt: 150, displacedFt: 0, elevationFt: 1000, ident: "09" };

function offset(lat, lon, northFt, eastFt) {
  const dLat = (northFt / EARTH_FT) * (180 / Math.PI);
  const dLon = (eastFt / (EARTH_FT * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

function toLatLon(field, x, y) {
  const h = (field.headingTrue * Math.PI) / 180;
  const north = x * Math.cos(h) - y * Math.sin(h);
  const east = x * Math.sin(h) + y * Math.cos(h);
  return offset(field.lat, field.lon, north, east);
}

const PROFILES = {
  light: { vr: 55, climbKt: 80, cruiseKt: 120, vapp: 65, climbFpm: 700, cruiseAlt: 6500, fuelFlow: 60, fuel: 300, weight: 2400, engType: 0, retract: false, light: true },
  turboprop: { vr: 100, climbKt: 160, cruiseKt: 240, vapp: 110, climbFpm: 1500, cruiseAlt: 16000, fuelFlow: 600, fuel: 3000, weight: 14000, engType: 5, retract: true, light: false },
  jet: { vr: 145, climbKt: 250, cruiseKt: 450, vapp: 140, climbFpm: 2500, cruiseAlt: 35000, fuelFlow: 5000, fuel: 30000, weight: 150000, engType: 1, retract: true, light: false },
};

/**
 * Builds a flight. options:
 *   group: "light" | "turboprop" | "jet"
 *   distanceNm: departure to arrival (default 60)
 *   startMs: time of the first sample
 *   touchdownPastFt: where the wheels touch, past the landing threshold (default 1000)
 *   touchdownFpm: sink rate at touchdown (default 150)
 *   centerlineFt: lateral offset at touchdown
 *   unstable: true for a sink-rate and speed problem below the gate
 *   goAround: true for one go-around from an unstable approach before the landing
 *   bounces: number of bounces after the first touchdown
 *   water: true for a water landing (floats)
 *   slewAtS / jumpAtS / fuelUpAtS: seconds into cruise for integrity problems
 *   accelSeconds: seconds of 4x time acceleration during cruise
 *   crashAtTouchdown: the touchdown ends in a crash (CRASH FLAG)
 *   extremeImpact: touchdown at 2,500 fpm and 4.5 G (crash detection off)
 *   divertTo: { x, y } where the aircraft parks instead (diversion), feet in the field frame
 *   field: the arrival runway
 * Returns { field, departure, samples, phases: [{ phase, t }], expect }.
 */
function buildFlight(options = {}) {
  const o = { group: "light", distanceNm: 60, startMs: Date.UTC(2026, 10, 16, 15, 0, 0), touchdownPastFt: 1000, touchdownFpm: 150, centerlineFt: 0, bounces: 0, ...options };
  const field = { ...DEFAULT_FIELD, ...(o.field || {}) };
  const p = PROFILES[o.group];
  const samples = [];
  const phases = [];
  const elev = field.elevationFt;
  const s = { t: o.startMs, x: -o.distanceNm * FT_PER_NM - 1500, y: 0, alt: elev, gs: 0, vs: 0, gnd: true, pitch: 0, bank: 0, hdg: 0, fuel: p.fuel, ph: "preflight", g: 1, flapsIdx: 0, gear: 100, pbrk: true, engines: false, rate: 1, slew: false, td: { tdV: 0, tdLat: 0, tdLon: 0, tdPitch: 0, tdBank: 0 } };
  let fuelExtra = 0;
  let phase = null;
  const setPhase = (name) => {
    if (phase !== name) {
      phase = name;
      s.ph = name;
      phases.push({ phase: name, t: s.t });
    }
  };

  function emit(extra = {}) {
    const pos = toLatLon(field, s.x, s.y);
    const agl = s.gnd ? 0 : Math.max(0, s.alt - elev);
    const hdgTrue = (field.headingTrue + s.hdg + 360) % 360;
    samples.push({
      t: s.t, z: s.t, ph: s.ph, lat: pos.lat, lon: pos.lon, alt: s.alt, agl, ialt: s.alt, ias: s.gs, tas: s.gs, gs: s.gs, mach: s.gs / 660,
      vs: s.vs, hdgT: hdgTrue, hdgM: hdgTrue, trk: hdgTrue, pitch: s.pitch, bank: s.bank, g: s.g, gnd: s.gnd,
      surf: o.water ? 2 : 4,
      rwy: s.gnd && (s.ph === "takeoff" || (Math.abs(s.y) < field.widthFt / 2 && s.x > -200 && s.x < field.lengthFt)),
      pbrk: s.pbrk, gearH: s.gear > 50, gear: s.gear, gearRet: p.retract, floats: Boolean(o.water), flapsIdx: s.flapsIdx, flaps: s.flapsIdx * 25,
      nEng: 1, engType: p.engType, eng: [{ c: s.engines, rpm: s.engines ? 2300 : 0, ff: s.engines ? p.fuelFlow : 0, thr: 70, fail: false }],
      fuel: s.fuel + fuelExtra, fuelFlow: s.engines ? p.fuelFlow : 0, wt: p.weight + s.fuel + fuelExtra, mgw: p.weight * 1.3,
      wDir: field.headingTrue, wSpd: 8, oat: 10, vis: 16000, cloud: false, slp: 1013.25, kohl: 29.92,
      stall: false, ovs: false, flapOvs: false, gearOvs: false, lBcn: s.engines, lNav: true, lStrb: !s.gnd || s.gs > 30, lLand: !s.gnd,
      simRate: s.rate, slew: s.slew, paused: false, crash: 0, crashOn: !o.extremeImpact,
      // Like MSFS: every reading carries the LAST touchdown's values (0 at the start of a flight)
      ...s.td,
      ...extra,
    });
  }

  function step(dt, extra) {
    s.t += dt * 1000;
    const h = (s.hdg * Math.PI) / 180;
    s.x += Math.cos(h) * s.gs * KT_TO_FTS * dt;
    s.y += Math.sin(h) * s.gs * KT_TO_FTS * dt;
    if (!s.gnd) s.alt += (s.vs / 60) * dt;
    if (s.engines) s.fuel = Math.max(0, s.fuel - (p.fuelFlow / 3600) * dt);
    emit(extra);
  }

  // ---------------- Parked, engine start, taxi ----------------
  setPhase("preflight");
  for (let i = 0; i < 30; i += 1) step(1);
  s.engines = true;
  setPhase("engine_start");
  for (let i = 0; i < 30; i += 1) step(1);
  s.pbrk = false;
  setPhase("taxi_out");
  s.gs = 12;
  while (s.x < -o.distanceNm * FT_PER_NM) step(1);
  s.gs = 0;
  for (let i = 0; i < 10; i += 1) step(1);

  // ---------------- Takeoff ----------------
  setPhase("takeoff");
  while (s.gs < p.vr) {
    s.gs = Math.min(p.vr, s.gs + (o.group === "jet" ? 3 : 2) * 0.1);
    step(0.1);
  }
  s.gnd = false;
  s.vs = p.climbFpm;
  s.pitch = 8;
  setPhase("climb");
  for (let i = 0; i < 100; i += 1) step(0.1);
  s.gear = p.retract ? 0 : 100;
  while (s.alt < elev + p.cruiseAlt - 1000 && s.alt < elev + p.cruiseAlt) {
    s.gs = Math.min(p.climbKt, s.gs + 1);
    step(1);
  }
  s.alt = elev + p.cruiseAlt - 1000 + 1000;
  s.vs = 0;
  s.pitch = 2;

  // ---------------- Cruise ----------------
  const glideStartX = -10 * FT_PER_NM;
  const topOfDescentX = glideStartX - ((p.cruiseAlt - 3200) / 1000) * (p.cruiseKt * KT_TO_FTS * 60) * 0.55;
  let cruiseSeconds = 0;
  s.gs = p.cruiseKt;
  setPhase("cruise");
  while (s.x < topOfDescentX) {
    cruiseSeconds += 1;
    const extra = {};
    s.slew = o.slewAtS !== undefined && cruiseSeconds >= o.slewAtS && cruiseSeconds < o.slewAtS + 20;
    s.rate = o.accelSeconds && cruiseSeconds >= 60 && cruiseSeconds < 60 + o.accelSeconds ? 4 : 1;
    if (o.jumpAtS !== undefined && cruiseSeconds === o.jumpAtS) s.y += 15 * FT_PER_NM;
    if (o.jumpAtS !== undefined && cruiseSeconds === o.jumpAtS + 1) s.y -= 15 * FT_PER_NM;
    if (o.fuelUpAtS !== undefined && cruiseSeconds === o.fuelUpAtS) fuelExtra += p.fuel * 0.2;
    step(1, extra);
    if (cruiseSeconds > 4 * 3600) break;
  }
  s.slew = false;
  s.rate = 1;

  // ---------------- Descent to the glide path ----------------
  setPhase("descent");
  s.vs = -((s.alt - (elev + 3185)) / Math.max(60, (glideStartX - s.x) / (s.gs * KT_TO_FTS)));
  while (s.x < glideStartX) {
    s.gs = Math.max(p.vapp + 40, s.gs - 0.5);
    s.vs = -Math.max(300, ((s.alt - (elev + 3185)) / Math.max(1, glideStartX - s.x)) * s.gs * KT_TO_FTS * 60);
    step(1);
  }

  function approach(minHeightAfe, isGoAround) {
    setPhase("approach");
    s.flapsIdx = 3;
    s.gear = 100;
    const slope = Math.tan((3 * Math.PI) / 180);
    while (true) {
      const target = elev + 50 + Math.max(0, -s.x) * slope;
      let afe = s.alt - elev;
      // An unstable approach: fast and steep from 900 ft down (APP-1, APP-2)
      const unstable = (o.unstable || isGoAround) && afe < 900 && afe > 60;
      s.gs = unstable ? p.vapp + 30 : Math.max(p.vapp, s.gs - 1);
      const desiredVs = ((target - s.alt) / 4) * 60 - s.gs * KT_TO_FTS * 60 * slope;
      s.vs = unstable ? -1400 : Math.max(-1200, Math.min(200, desiredVs));
      s.y += (o.centerlineFt - s.y) * 0.05;
      s.pitch = unstable ? -2 : 2;
      const dt = afe < 250 ? 0.1 : 1;
      step(dt);
      afe = s.alt - elev;
      if (afe <= minHeightAfe) return;
    }
  }

  // ---------------- Optional go-around ----------------
  if (o.goAround) {
    approach(350, true);
    setPhase("go_around");
    s.vs = 1200;
    s.gs = p.vapp + 20;
    for (let i = 0; i < 90; i += 1) step(1);
    s.vs = 0;
    // a right-hand circuit back to a 10 nm final
    for (let turn = 0; turn < 2; turn += 1) {
      for (let i = 0; i < 60; i += 1) {
        s.hdg += 3;
        s.bank = 25;
        step(1);
      }
      s.bank = 0;
      s.hdg = turn === 0 ? 180 : 0;
      const until = turn === 0 ? -12 * FT_PER_NM : null;
      if (until !== null) while (s.x > until) step(1);
    }
    s.hdg = 0;
    s.x = Math.min(s.x, -9 * FT_PER_NM);
    s.vs = -300;
    while (s.alt > elev + 2600) step(1);
  }

  // ---------------- Final approach, flare, touchdown ----------------
  approach(50, false);
  const flareSeconds = o.group === "light" ? 5 : 6;
  const tdX = (field.displacedFt || 0) + o.touchdownPastFt;
  const flareStartX = s.x;
  const steps = flareSeconds * 10;
  const startAlt = s.alt;
  const tdVs = -(o.extremeImpact ? 2500 : o.touchdownFpm);
  for (let i = 1; i <= steps; i += 1) {
    const k = i / steps;
    s.x = flareStartX + (tdX - flareStartX) * k;
    s.alt = startAlt + (elev - startAlt) * (1 - (1 - k) * (1 - k)) ;
    s.vs = tdVs + (-(s.gs * KT_TO_FTS * 60 * 0.052) - tdVs) * (1 - k);
    s.pitch = 4;
    s.t += 100;
    emit();
  }
  s.alt = elev;
  s.gnd = true;
  s.vs = 0;
  setPhase("landed");
  const touchdownT = s.t;
  const tdPitch = 4;
  const tdG = o.extremeImpact ? 4.5 : o.touchdownFpm > 700 ? 2.3 : 1.2;
  s.g = tdG;
  const touchPoint = samples[samples.length - 1];
  // The touchdown frame itself still carries the old touchdown values, like MSFS
  step(0.1, { crash: o.crashAtTouchdown ? 1 : 0 });
  s.g = 1;
  step(0.1);
  // ...and MSFS updates them a moment later
  s.td = { tdV: o.extremeImpact ? 2500 : o.touchdownFpm, tdLat: touchPoint.lat, tdLon: touchPoint.lon, tdPitch, tdBank: 0 };
  step(0.1);

  for (let b = 0; b < o.bounces; b += 1) {
    s.gnd = false;
    s.vs = 400;
    for (let i = 0; i < 12; i += 1) step(0.1, { agl: 6 });
    s.vs = -300;
    for (let i = 0; i < 12; i += 1) step(0.1);
    s.gnd = true;
    s.alt = elev;
    s.vs = 0;
    for (let i = 0; i < 5; i += 1) step(0.1);
  }

  // ---------------- Rollout, taxi in, park ----------------
  while (s.gs > 30) {
    s.gs -= o.group === "light" ? 0.6 : 0.4;
    step(0.1);
  }
  const at30 = s.x;
  setPhase("taxi_in");
  while (s.gs > 15) {
    s.gs -= 0.5;
    step(1);
  }
  s.hdg = 90;
  for (let i = 0; i < 40; i += 1) step(1);
  if (o.divertTo) {
    s.x = o.divertTo.x;
    s.y = o.divertTo.y;
  }
  s.gs = 0;
  s.pbrk = true;
  setPhase("parked");
  for (let i = 0; i < (o.water ? 35 : 15); i += 1) step(1);
  s.engines = false;
  setPhase("engines_off");
  for (let i = 0; i < 10; i += 1) step(1);

  const runwayEnd = {
    ident: field.ident, lat: field.lat, lon: field.lon, headingTrue: field.headingTrue, lengthFt: field.lengthFt,
    widthFt: field.widthFt, displacedFt: field.displacedFt || 0, surface: o.water ? "water" : "hard", elevationFt: elev,
  };
  const departurePos = toLatLon(field, -o.distanceNm * FT_PER_NM, 0);
  return {
    field,
    runwayEnd,
    departure: { lat: departurePos.lat, lon: departurePos.lon, elevationFt: elev },
    arrival: { lat: field.lat, lon: field.lon, elevationFt: elev },
    samples,
    phases,
    expect: { touchdownT, touchdownPastFt: o.touchdownPastFt, runwayLeftAt30Ft: field.lengthFt - at30, tdG },
  };
}

module.exports = { buildFlight, toLatLon, PROFILES, DEFAULT_FIELD, FT_PER_NM };
