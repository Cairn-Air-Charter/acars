// Phases, the pre-flight checklist, report timing, integrity and the landing card
// (flows/acars.md ACR-9 to ACR-13), with synthetic flights standing in for MSFS (SRV-8).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFlight } = require("./helpers/synthetic-flight");
const { createPhaseDetector } = require("../src/main/flight/phases");
const { evaluateChecks } = require("../src/main/flight/checks");
const { createReportClock } = require("../src/main/flight/reporting");
const { createIntegrityMonitor, TIME_ACCELERATION_MESSAGE } = require("../src/main/flight/integrity");
const { createLandingTracker } = require("../src/main/flight/landing");

function play(options) {
  const flight = buildFlight(options);
  const detector = createPhaseDetector({ destination: { code: "ARR", ...flight.arrival }, light: (options.group || "light") === "light", runways: { departure: [], arrival: [flight.runwayEnd] } });
  const changes = [];
  for (const s of flight.samples) for (const c of detector.update(s)) changes.push({ ...c, t: s.t });
  return { flight, detector, changes, phases: changes.filter((c) => c.type === "phase").map((c) => c.phase) };
}

// ==========================================
// PHASES (ACR-11)
// ==========================================

test("a normal flight goes through every phase in order, with all four OOOI times (ACR-10, ACR-11)", () => {
  const { phases, detector, changes } = play({ group: "light" });
  assert.deepEqual(phases, ["engine_start", "taxi_out", "takeoff", "climb", "cruise", "descent", "approach", "landed", "taxi_in", "parked", "engines_off"]);
  const oooi = detector.oooi;
  assert.ok(oooi.out < oooi.off && oooi.off < oooi.on && oooi.on < oooi.in);
  const messages = changes.filter((c) => c.type === "status" || c.type === "phase").map((c) => c.message);
  for (const m of ["Engine 1 started.", "Taxiing out.", "Takeoff roll.", "Airborne.", "Starting down.", "On approach to ARR.", "Parked.", "Engines off. Ready to file."]) {
    assert.ok(messages.includes(m), m);
  }
  assert.ok(messages.some((m) => /^Leveled off at [\d,]+ ft\.$/.test(m)));
});

test("a jet flight uses the larger numbers and still finds every phase (ACR-11)", () => {
  const { phases } = play({ group: "jet", distanceNm: 400 });
  assert.deepEqual(phases.slice(0, 4), ["engine_start", "taxi_out", "takeoff", "climb"]);
  assert.ok(phases.includes("cruise") && phases.includes("approach") && phases.at(-1) === "engines_off");
});

test("a go-around shows as a step, and the timeline returns to climb and approach (ACR-10)", () => {
  const { phases, detector } = play({ group: "light", goAround: true });
  const i = phases.indexOf("go_around");
  assert.ok(i > 0);
  assert.deepEqual(phases.slice(i - 1, i + 3), ["approach", "go_around", "climb", "approach"]);
  assert.equal(detector.counts.goArounds, 1);
});

test("bounces under 5 s and 15 ft keep the landing going; the landing isn't repeated (ACR-11)", () => {
  const { detector, phases } = play({ group: "light", bounces: 2 });
  assert.equal(detector.counts.bounces, 2);
  assert.equal(detector.counts.touchAndGoes, 0);
  assert.equal(phases.filter((p) => p === "landed").length, 1);
});

test("a touch-and-go is a landing and a new takeoff in the same flight (ACR-11)", () => {
  const d = createPhaseDetector({ destination: { code: "ARR", lat: 45, lon: -100, elevationFt: 0 }, light: true });
  let t = 0;
  const feed = (s, n = 1) => {
    for (let i = 0; i < n; i += 1) {
      t += 1000;
      d.update({ t, lat: 45, lon: -100, alt: s.gnd ? 0 : 500, agl: s.gnd ? 0 : 500, gs: 70, vs: s.vs || 0, eng: [{ c: true }], ...s });
    }
  };
  feed({ gnd: true, rwy: true, gs: 50 }, 3);
  feed({ gnd: false, vs: 500 }, 10);
  feed({ gnd: true }, 3);
  feed({ gnd: false, vs: 600 }, 8); // airborne for 8 s and high: a touch-and-go
  assert.equal(d.counts.touchAndGoes, 1);
  assert.equal(d.phase, "climb");
});

test("pushback is found from moving backward, and from the pushback state (ACR-11)", () => {
  const d = createPhaseDetector({ light: false });
  let t = 0;
  const step = (s) => d.update({ t: (t += 1000), lat: 1, lon: 1, gnd: true, gs: 2, eng: [{ c: false }], ...s });
  step({ vbz: -1 });
  step({ vbz: -1 });
  assert.ok(step({ vbz: -1 }).some((c) => c.type === "phase" && c.phase === "pushback"));
  const d2 = createPhaseDetector({ light: false });
  assert.ok(d2.update({ t: 1, lat: 1, lon: 1, gnd: true, gs: 2, push: 0 }).some((c) => c.phase === "pushback"));
});

test("on water, parked means stopped for 30 s, no parking brake needed (ACR-11)", () => {
  const { phases } = play({ group: "light", water: true });
  assert.ok(phases.includes("parked"));
});

// ==========================================
// THE CHECKLIST (ACR-9)
// ==========================================

const DEP = { code: "PANC", lat: 61.1744, lon: -149.9964, type: "large_airport" };
const ready = { t: 1, lat: 61.175, lon: -149.996, gnd: true, pbrk: true, gs: 0, simRate: 1, slew: false, crashOn: true, surf: 4 };
const sim = { connected: true, inFlight: true };
const byKey = (result) => Object.fromEntries(result.items.map((i) => [i.key, i]));

test("every required check green lets Begin flight go (ACR-9)", () => {
  const result = evaluateChecks({ sim, sample: ready, leg: { departure: DEP }, aircraft: { known: true, loadedType: "Cessna 172", missionType: "Cessna 172" } });
  assert.equal(result.ready, true);
  assert.equal(byKey(result).aircraft.detail, "Aircraft: Cessna 172.");
});

test("each failing check says what to do in plain words (ACR-9)", () => {
  const result = evaluateChecks({ sim, sample: { ...ready, pbrk: false, gs: 3, simRate: 4 }, leg: { departure: DEP } });
  assert.equal(result.ready, false);
  const k = byKey(result);
  assert.equal(k.parkingBrake.detail, "Set the parking brake.");
  assert.equal(k.notMoving.detail, "Come to a full stop.");
  assert.equal(k.simRate.detail, "Set the sim rate back to 1×.");
  assert.match(evaluateChecks({ sim: { connected: false }, sample: null, leg: { departure: DEP } }).items[0].detail, /Start MSFS/);
  assert.match(evaluateChecks({ sim: { connected: true, inFlight: false }, sample: null, leg: { departure: DEP } }).items[0].detail, /Load an aircraft/);
});

test("at the departure airport: within 3 nm, or 5 nm for large airports; otherwise where you are (ACR-9)", () => {
  const fourNm = { ...ready, lat: DEP.lat + 4 / 60 };
  assert.equal(byKey(evaluateChecks({ sim, sample: fourNm, leg: { departure: DEP } })).atDeparture.pass, true);
  const small = { ...DEP, type: "small_airport" };
  const k = byKey(evaluateChecks({ sim, sample: fourNm, leg: { departure: small }, nearestAirport: { code: "PALH" } }));
  assert.equal(k.atDeparture.pass, false);
  assert.equal(k.atDeparture.detail, "You're at PALH, 4 nm from PANC. Move to PANC to start.");
});

test("on water the parking brake check passes when stopped (ACR-9)", () => {
  const k = byKey(evaluateChecks({ sim, sample: { ...ready, pbrk: false, surf: 2, floats: true, gs: 0.4 }, leg: { departure: DEP } }));
  assert.equal(k.parkingBrake.pass, true);
  assert.equal(k.parkingBrake.label, "Stopped on the water");
});

test("crash detection off and the aircraft type are advice only, never blocking (ACR-9, FR-9)", () => {
  const result = evaluateChecks({ sim, sample: { ...ready, crashOn: false }, leg: { departure: DEP }, aircraft: { known: false, loadedType: "Odd add-on" } });
  assert.equal(result.ready, true);
  const k = byKey(result);
  assert.equal(k.crashDetection.required, false);
  assert.equal(k.crashDetection.detail, "Crash detection is off in MSFS. You can still fly; ACARS just can't tell if the flight ends in a crash.");
  assert.equal(k.aircraft.detail, "We don't recognize this aircraft yet. You can still fly it; staff will look at the report.");
  const different = byKey(evaluateChecks({ sim, sample: ready, leg: { departure: DEP }, aircraft: { known: true, loadedType: "Cessna 208B Grand Caravan EX", missionType: "Cessna 172" } }));
  assert.equal(different.aircraft.detail, "The mission calls for a Cessna 172, but you're flying a Cessna 208B Grand Caravan EX. That's fine; your report and FOQA will use the Cessna 208B Grand Caravan EX.");
});

test("slew mode fails the simulation-rate check (ACR-9)", () => {
  assert.equal(byKey(evaluateChecks({ sim, sample: { ...ready, slew: true }, leg: { departure: DEP } })).simRate.detail, "Turn off slew mode.");
});

// ==========================================
// REPORT TIMING (ACR-12)
// ==========================================

test("parked: a report every 120 s; moving: every 60 s; phase changes right away (ACR-12)", () => {
  const clock = createReportClock({ parked_s: 120, moving_s: 60 });
  const at = (t, extra = {}) => ({ t: t * 1000, gnd: true, gs: 0, ...extra });
  assert.equal(clock.due(at(0)), "first");
  assert.equal(clock.due(at(60)), null);
  assert.equal(clock.due(at(120)), "timed");
  assert.equal(clock.due(at(150, { gs: 5 })), null);
  assert.equal(clock.due(at(180, { gs: 5 })), "timed");
  assert.equal(clock.due(at(181, { gs: 5 }), true), "phase");
  assert.equal(clock.due(at(240, { gnd: false, gs: 100 })), null);
  assert.equal(clock.due(at(241, { gnd: false, gs: 100 })), "timed");
});

test("while paused there are no timed reports: one marks the pause, one the resume (ACR-12)", () => {
  const clock = createReportClock();
  clock.due({ t: 0, gnd: false, gs: 100 });
  assert.equal(clock.due({ t: 1000, paused: true }), "pause");
  assert.equal(clock.due({ t: 500000, paused: true }), null);
  assert.equal(clock.due({ t: 600000, gnd: false, gs: 100 }), "resume");
});

test("a whole flight sends roughly one report a minute while moving (ACR-12)", () => {
  const flight = buildFlight({ group: "light" });
  const clock = createReportClock();
  const sent = flight.samples.filter((s) => clock.due(s));
  const minutesLong = (flight.samples.at(-1).t - flight.samples[0].t) / 60000;
  assert.ok(sent.length >= minutesLong * 0.9 && sent.length <= minutesLong * 1.2, `${sent.length} reports over ${Math.round(minutesLong)} min`);
});

// ==========================================
// INTEGRITY (ACR-13)
// ==========================================

test("slew, jumps, fuel going up and time acceleration are noted; long acceleration means review (ACR-13)", () => {
  const flight = buildFlight({ group: "light", slewAtS: 30, jumpAtS: 100, fuelUpAtS: 200, accelSeconds: 60 });
  const m = createIntegrityMonitor();
  const messages = flight.samples.flatMap((s) => m.update(s));
  const notes = Object.fromEntries(m.notes().map((n) => [n.code, n]));
  for (const code of ["slew", "jump", "fuel_up", "time_acceleration"]) assert.equal(notes[code].review, true, code);
  assert.deepEqual([...new Set(messages)], [TIME_ACCELERATION_MESSAGE]);
});

test("up to 30 s of time acceleration is ignored as an accidental key press (ACR-13)", () => {
  const m = createIntegrityMonitor();
  for (const s of buildFlight({ group: "light", accelSeconds: 20 }).samples) m.update(s);
  assert.equal(m.notes().find((n) => n.code === "time_acceleration").review, false);
});

test("pauses are only noted, with the total time (ACR-13)", () => {
  const m = createIntegrityMonitor();
  m.update({ t: 0, lat: 1, lon: 1, gs: 100, gnd: false });
  m.update({ t: 1000, lat: 1, lon: 1, gs: 100, gnd: false, paused: true });
  m.update({ t: 301000, lat: 1, lon: 1, gs: 100, gnd: false });
  assert.equal(m.pausedSeconds, 300);
  assert.deepEqual(m.notes(), []);
});

test("during a resume, slew and teleport don't count (ACR-14)", () => {
  const m = createIntegrityMonitor();
  m.update({ t: 0, lat: 1, lon: 1, gs: 100, gnd: false });
  m.allowResume(1000);
  m.update({ t: 2000, lat: 1.5, lon: 1, gs: 100, gnd: false, slew: true });
  assert.deepEqual(m.notes(), []);
});

// ==========================================
// THE LANDING CARD (ACR-10)
// ==========================================

test("the preliminary landing card has rate, G, distance, centerline and bounces (ACR-10)", () => {
  const flight = buildFlight({ group: "light", touchdownPastFt: 1200, touchdownFpm: 220, bounces: 1 });
  const tracker = createLandingTracker({ ends: [flight.runwayEnd], light: true });
  const detector = createPhaseDetector({ destination: { code: "ARR", ...flight.arrival }, light: true });
  for (const s of flight.samples) {
    tracker.update(s);
    for (const c of detector.update(s)) {
      if (c.type === "touchdown" && c.bounce) tracker.onBounce();
      else if (c.type === "touchdown" && !c.touchAndGo) tracker.onTouchdown(s);
    }
  }
  const r = tracker.result();
  assert.equal(r.fpm, 220);
  assert.equal(r.bounces, 1);
  assert.equal(r.runway, "09");
  assert.ok(Math.abs(r.distanceFt - 1200) < 30);
  assert.ok(r.centerlineFt < 5);
  assert.match(tracker.statusText(), /^Landed: 220 fpm, 1,[12]\d\d ft down runway 09\.$/);
});
