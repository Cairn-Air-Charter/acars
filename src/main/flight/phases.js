// Phase detection on the PC (flows/acars.md ACR-10, ACR-11). Pure: it only looks at the
// samples it's given (with their own times), so it's tested with recorded or synthetic
// flights and never needs MSFS. Phases change only when a condition holds for the stated
// time, so a gust or a bump never flips the phase back and forth.
"use strict";

const geo = require("../../shared/geo");

const PHASES = [
  "preflight", "pushback", "engine_start", "taxi_out", "takeoff", "climb", "cruise", "descent",
  "approach", "go_around", "landed", "taxi_in", "parked", "engines_off",
];

const PHASE_LABELS = {
  preflight: "Preflight", pushback: "Pushback", engine_start: "Engine start", taxi_out: "Taxi out", takeoff: "Takeoff",
  climb: "Climb", cruise: "Cruise", descent: "Descent", approach: "Approach", go_around: "Go-around", landed: "Landed",
  taxi_in: "Taxi in", parked: "Parked", engines_off: "Engines off",
};

const LIGHT_CLASSES = new Set(["light_single", "bush", "light_utility"]);
const PUSHBACK_NONE = 3; // SimConnect PUSHBACK STATE: 3 = no pushback
const GO_AROUND_BELOW_AFE = 1000; // a go-around's lowest point is below this, above the field
const BOUNCE_MIN_S = 0.5; // shorter "airborne" blips at touchdown are MSFS's on-ground flag flickering
const WATER = 2; // SimConnect SURFACE TYPE: water

const num = (v) => typeof v === "number" && Number.isFinite(v);
const fmtFt = (v) => Math.round(v).toLocaleString("en-US");

/**
 * Creates a detector. options:
 *   destination: { code, lat, lon, elevationFt }
 *   light: true for light aircraft (lower speeds and distances)
 *   runways: { departure: [...ends], arrival: [...ends] } (optional, for runway names)
 * detector.update(sample) returns the changes this sample caused:
 *   [{ type: "phase", phase, message }, { type: "oooi", which: "out"|"off"|"on"|"in" },
 *    { type: "status", message }, { type: "touchdown", bounce?, touchAndGo? }]
 */
function createPhaseDetector(options) {
  const light = Boolean(options.light);
  const dest = options.destination || null;
  const runways = options.runways || {};
  const state = {
    phase: "preflight",
    oooi: { out: null, off: null, on: null, in: null },
    airborne: false,
    everAirborne: false,
    maxAlt: null,
    lowestAfe: null,
    enginesStarted: new Set(),
    timers: {},
    lastGs: [],
    touchdown: null, // { t, airborneSince } while deciding bounce vs touch-and-go
    bounces: 0,
    touchAndGoes: 0,
    goArounds: 0,
    levelledAt: null,
  };

  // True once cond has held for `seconds` of sample time
  function held(key, cond, seconds, t) {
    if (!cond) {
      delete state.timers[key];
      return false;
    }
    if (state.timers[key] === undefined) state.timers[key] = t;
    return (t - state.timers[key]) / 1000 >= seconds;
  }

  function enginesRunning(s) {
    return (s.eng || []).some((e) => e.c === true);
  }

  function afe(s) {
    if (!num(s.alt)) return num(s.agl) ? s.agl : 0;
    return dest && num(dest.elevationFt) ? s.alt - dest.elevationFt : num(s.agl) ? s.agl : s.alt;
  }

  function distToDest(s) {
    return dest && num(dest.lat) ? geo.distanceNm(s.lat, s.lon, dest.lat, dest.lon) : Infinity;
  }

  function update(s) {
    const out = [];
    const t = s.t;
    const set = (phase, message) => {
      if (state.phase === phase) return;
      state.phase = phase;
      out.push({ type: "phase", phase, message: message || PHASE_LABELS[phase] });
      for (const key of Object.keys(state.timers)) if (key.startsWith("p:")) delete state.timers[key];
    };
    const oooi = (which) => {
      if (which === "on" || which === "in" || !state.oooi[which]) {
        state.oooi[which] = t;
        out.push({ type: "oooi", which, t });
      }
    };
    const onGround = s.gnd === true;
    const gs = num(s.gs) ? s.gs : 0;
    state.lastGs.push({ t, gs });
    while (state.lastGs.length && t - state.lastGs[0].t > 3000) state.lastGs.shift();
    const accelerating = state.lastGs.length > 1 && gs > state.lastGs[0].gs + 0.5;

    // Engines (logged per engine)
    (s.eng || []).forEach((e, i) => {
      if (e.c === true && !state.enginesStarted.has(i)) {
        state.enginesStarted.add(i);
        out.push({ type: "status", message: `Engine ${i + 1} started.` });
        if (["preflight", "pushback"].includes(state.phase) && !state.everAirborne) set("engine_start");
      }
      if (e.c === false && state.enginesStarted.has(i) && !state.airborne && !["parked", "engines_off"].includes(state.phase)) {
        state.enginesStarted.delete(i);
      }
    });

    // First movement is Out (OOOI)
    if (!state.oooi.out && onGround && gs >= 1) oooi("out");

    // ---------------- On the ground before takeoff ----------------
    if (!state.everAirborne) {
      const pushing = (num(s.vbz) && held("push", s.vbz < -0.5, 2, t)) || (num(s.push) && s.push !== PUSHBACK_NONE && s.push >= 0 && s.push < 3);
      if (pushing && ["preflight", "engine_start"].includes(state.phase)) {
        set("pushback");
        out.push({ type: "status", message: "Pushing back." });
      }
      const onRunwayOrWater = s.rwy === true || s.surf === WATER;
      if (onGround && held("p:taxi", gs > 3 && s.pbrk !== true && !(num(s.vbz) && s.vbz < 0), 5, t) && !["taxi_out", "takeoff"].includes(state.phase)) {
        set("taxi_out");
        out.push({ type: "status", message: "Taxiing out." });
      }
      if (onGround && onRunwayOrWater && gs > (light ? 30 : 40) && accelerating && state.phase !== "takeoff") {
        set("takeoff");
        const end = geo.runwayFor(runways.departure, s.lat, s.lon, s.hdgT);
        out.push({ type: "status", message: end && end.ident ? `Takeoff roll, runway ${end.ident}.` : "Takeoff roll." });
      }
    }

    // ---------------- Leaving and touching the ground ----------------
    if (!onGround) {
      if (!state.airborne) {
        state.airborne = true;
        state.airborneSince = t;
        state.airborneMaxAgl = 0;
      }
      state.airborneMaxAgl = Math.max(state.airborneMaxAgl, num(s.agl) ? s.agl : 0);
      const firstFlight = !state.everAirborne;
      const airTime = (t - state.airborneSince) / 1000;
      if (firstFlight && airTime >= 3 && (s.agl || 0) > 10) {
        state.everAirborne = true;
        oooi("off");
        set("climb");
        out.push({ type: "status", message: "Airborne." });
      }
      // After a touchdown: airborne again less than 5 s and below 15 ft is a bounce;
      // longer or higher is a touch-and-go (a landing and a new takeoff in the same flight)
      if (state.touchdown && (airTime >= 5 || state.airborneMaxAgl >= 15)) {
        state.touchdown = null;
        state.touchAndGoes += 1;
        out.push({ type: "touchdown", touchAndGo: true });
        out.push({ type: "status", message: "Touch-and-go." });
        set("climb");
      }
    } else if (state.airborne) {
      const airTime = (t - state.airborneSince) / 1000;
      const flicker = state.touchdown && airTime < BOUNCE_MIN_S;
      const wasBounce = state.touchdown && !flicker && airTime < 5 && state.airborneMaxAgl < 15;
      state.airborne = false;
      if (flicker) {
        // MSFS's on-ground flag often flickers for a moment at touchdown: not a bounce
      } else if (wasBounce) {
        state.bounces += 1;
        out.push({ type: "touchdown", bounce: true });
      } else if (state.everAirborne && (s.agl === undefined || s.agl <= 5)) {
        state.touchdown = { t };
        oooi("on");
        set("landed");
        out.push({ type: "touchdown" });
      }
    }

    // ---------------- In flight ----------------
    if (!onGround && state.everAirborne && !state.touchdown) {
      const height = afe(s);
      state.maxAlt = Math.max(state.maxAlt === null ? -Infinity : state.maxAlt, s.alt || 0);
      const vs = num(s.vs) ? s.vs : 0;
      const dist = distToDest(s);
      const nearDest = dist <= (light ? 10 : 30) && height < (light ? 3000 : 5000);

      if (state.phase === "approach" || state.phase === "go_around") {
        if (state.lowestAfe === null || height < state.lowestAfe) state.lowestAfe = height;
        // A go-around starts low on the approach (below 1,000 ft above the field). Climbing back
        // to circuit height afterwards, or a step-climb higher up, isn't another go-around.
        if (state.phase === "approach" && held("ga", vs > 500 && state.lowestAfe < GO_AROUND_BELOW_AFE && height - state.lowestAfe >= 300, 10, t)) {
          state.goArounds += 1;
          state.lowestAfe = null;
          set("go_around");
          out.push({ type: "status", message: "Going around." });
        }
      }
      if (state.phase === "go_around") {
        if (held("p:after-ga", true, 30, t)) set(nearDest && vs < 0 ? "approach" : "climb");
      } else if (nearDest && (vs < -100 || (s.gear >= 100 && (s.flapsIdx || 0) > 0 && vs <= 300)) && state.phase !== "approach") {
        set("approach", dest && dest.code ? `On approach to ${dest.code}.` : "On approach.");
        state.lowestAfe = height;
      } else if (state.phase !== "approach") {
        if (["cruise", "descent"].includes(state.phase) && held("p:climb", vs > 300, 60, t)) set("climb");
        if (["climb", "descent"].includes(state.phase) && held("p:cruise", Math.abs(vs) <= 300 && s.alt >= state.maxAlt - 500, 120, t)) {
          set("cruise", `Leveled off at ${fmtFt(Math.round(s.alt / 100) * 100)} ft.`);
        }
        if (["climb", "cruise"].includes(state.phase) && held("p:descent", vs < -300, 60, t)) set("descent", "Starting down.");
      }
    }

    // ---------------- After landing ----------------
    if (onGround && state.touchdown) {
      if (state.phase === "landed" && gs < (light ? 20 : 30)) set("taxi_in");
      const water = s.surf === WATER;
      const stopped = water ? held("p:stopped", gs < 0.5, 30, t) : held("p:stopped", gs < 0.5 && s.pbrk === true, 10, t);
      if (["landed", "taxi_in"].includes(state.phase) && stopped) {
        set("parked", "Parked.");
        oooi("in");
      }
      if (state.phase === "parked" && !enginesRunning(s)) {
        set("engines_off", "Engines off. Ready to file.");
      }
      if (state.phase === "engines_off" && enginesRunning(s)) set("parked");
      if (state.phase === "parked" && gs > 3 && s.pbrk !== true) {
        set("taxi_in");
        state.oooi.in = null;
      }
    }
    return out;
  }

  return {
    update,
    get phase() {
      return state.phase;
    },
    get oooi() {
      return { ...state.oooi };
    },
    get counts() {
      return { bounces: state.bounces, touchAndGoes: state.touchAndGoes, goArounds: state.goArounds };
    },
    snapshot() {
      return JSON.parse(JSON.stringify({ ...state, enginesStarted: [...state.enginesStarted] }));
    },
    restore(saved) {
      Object.assign(state, saved, { enginesStarted: new Set(saved.enginesStarted || []), timers: {} });
    },
  };
}

module.exports = { PHASES, PHASE_LABELS, LIGHT_CLASSES, createPhaseDetector };
