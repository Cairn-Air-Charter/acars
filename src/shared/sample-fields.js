// The flight data sample: one reading of the simulator (flows/acars.md ACR-8, ACR-12).
// Identical copy in Trailhead (acars/sample-fields.js) and ACARS (src/shared/sample-fields.js).
// Change both at the same time.
//
// ACARS builds every sample with these short names, in these units. Position reports and
// the flight data file both use them. Units are converted in ACARS, never on the server:
//   - pitch is nose-up positive (SimConnect reports nose-up as negative; ACARS flips it)
//   - vertical speeds are feet per minute; touchdown rate (tdV) is positive when descending
//   - weights and fuel are pounds; fuel flow is pounds per hour
//   - times (t, z) are milliseconds since 1970 in UTC
(function (root) {
  "use strict";

  // [name, kind, min, max, position-report column (or null for the extra data)]
  // kind: "n" number, "b" true/false, "s" short text, "a" list of engines
  const FIELDS = [
    ["t", "n", 0, 9e15, "pc_time"],
    ["z", "n", 0, 9e15, "sim_zulu_time"],
    ["ph", "s", 0, 20, "phase"],
    ["lat", "n", -90, 90, "latitude"],
    ["lon", "n", -180, 180, "longitude"],
    ["alt", "n", -2000, 70000, "altitude_ft"],
    ["agl", "n", -500, 70000, "agl_ft"],
    ["aglCg", "n", -500, 70000, null],
    ["ialt", "n", -2000, 70000, "indicated_alt_ft"],
    ["palt", "n", -2000, 70000, null],
    ["ias", "n", -50, 1000, "ias_kt"],
    ["tas", "n", -50, 1500, "tas_kt"],
    ["mach", "n", 0, 5, "mach"],
    ["gs", "n", 0, 1500, "gs_kt"],
    ["vs", "n", -30000, 30000, "vs_fpm"],
    ["vbz", "n", -2000, 2000, null],
    ["hdgT", "n", 0, 360, "heading_true"],
    ["hdgM", "n", 0, 360, "heading_mag"],
    ["trk", "n", 0, 360, "track_true"],
    ["pitch", "n", -90, 90, "pitch_deg"],
    ["bank", "n", -180, 180, "bank_deg"],
    ["g", "n", -10, 15, "g_force"],
    ["gnd", "b", 0, 1, "on_ground"],
    ["surf", "n", 0, 50, null],
    ["rwy", "b", 0, 1, null],
    ["pbrk", "b", 0, 1, "parking_brake"],
    ["pbrkInd", "b", 0, 1, null],
    ["push", "n", 0, 10, null],
    ["gearH", "b", 0, 1, null],
    ["gear", "n", 0, 100, "gear_pct"],
    ["gearRet", "b", 0, 1, null],
    ["floats", "b", 0, 1, null],
    ["flapsIdx", "n", 0, 20, null],
    ["flaps", "n", 0, 100, "flaps_pct"],
    ["flapsTe", "n", 0, 100, null],
    ["spl", "n", 0, 100, null],
    ["splArm", "b", 0, 1, null],
    ["nEng", "n", 0, 8, null],
    ["engType", "n", 0, 10, null],
    ["eng", "a", 0, 8, null],
    ["fuel", "n", 0, 2000000, "fuel_lbs"],
    ["fuelGal", "n", 0, 400000, null],
    ["fuelFlow", "n", 0, 200000, "fuel_flow_pph"],
    ["wt", "n", 0, 2000000, "total_weight_lbs"],
    ["mgw", "n", 0, 2000000, null],
    ["ew", "n", 0, 2000000, null],
    ["wDir", "n", 0, 360, null],
    ["wSpd", "n", 0, 400, null],
    ["wX", "n", -400, 400, null],
    ["wZ", "n", -400, 400, null],
    ["oat", "n", -100, 70, null],
    ["vis", "n", 0, 1000000, null],
    ["cloud", "b", 0, 1, null],
    ["precip", "n", 0, 10, null],
    ["slp", "n", 800, 1100, null],
    ["kohl", "n", 25, 33, null],
    ["stall", "b", 0, 1, null],
    ["ovs", "b", 0, 1, null],
    ["flapOvs", "b", 0, 1, null],
    ["gearOvs", "b", 0, 1, null],
    ["gpws", "b", 0, 1, null],
    ["gpwsOn", "b", 0, 1, null],
    ["tdLat", "n", -90, 90, null],
    ["tdLon", "n", -180, 180, null],
    ["tdV", "n", -10000, 20000, null],
    ["tdPitch", "n", -90, 90, null],
    ["tdBank", "n", -180, 180, null],
    ["tdHdg", "n", 0, 360, null],
    ["locOk", "b", 0, 1, null],
    ["gsOk", "b", 0, 1, null],
    ["cdi", "n", -127, 127, null],
    ["gsErr", "n", -90, 90, null],
    ["gsFlag", "b", 0, 1, null],
    ["navId", "s", 0, 8, null],
    ["ap", "b", 0, 1, null],
    ["apAlt", "n", -2000, 70000, null],
    ["apSpd", "n", 0, 1000, null],
    ["lBcn", "b", 0, 1, null],
    ["lNav", "b", 0, 1, null],
    ["lStrb", "b", 0, 1, null],
    ["lLand", "b", 0, 1, null],
    ["lTaxi", "b", 0, 1, null],
    ["cabAlt", "n", -2000, 70000, null],
    ["cabRate", "n", -30000, 30000, null],
    ["belts", "b", 0, 1, null],
    ["xpdr", "n", 0, 7777, null],
    ["com", "n", 0, 200, null],
    ["simRate", "n", 0, 128, null],
    ["slew", "b", 0, 1, null],
    ["paused", "b", 0, 1, "paused"],
    ["crash", "n", 0, 100000, null],
    ["crashSeq", "n", 0, 100, null],
    ["crashOn", "b", 0, 1, null],
  ];

  // Engine entries: [name, kind, min, max]
  const ENGINE_FIELDS = [
    ["c", "b", 0, 1], // combustion (running)
    ["rpm", "n", 0, 100000],
    ["n1", "n", 0, 150],
    ["n2", "n", 0, 150],
    ["thr", "n", -100, 150],
    ["ff", "n", 0, 100000], // fuel flow, pounds per hour
    ["fail", "b", 0, 1],
  ];

  const BY_NAME = new Map(FIELDS.map((f) => [f[0], f]));

  function cleanValue(kind, min, max, value) {
    if (value === null || value === undefined) return null;
    if (kind === "b") return typeof value === "boolean" ? value : value === 1 ? true : value === 0 ? false : undefined;
    if (kind === "s") return typeof value === "string" && value.length <= max ? value : undefined;
    if (kind === "n") return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    return undefined;
  }

  /**
   * Checks one sample and returns a clean copy with only known fields, or null when it
   * isn't usable (no time or position, or any value of the wrong type or out of range).
   */
  function cleanSample(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const out = {};
    for (const [name, value] of Object.entries(input)) {
      const field = BY_NAME.get(name);
      if (!field) continue; // unknown fields are dropped
      const [, kind, min, max] = field;
      if (kind === "a") {
        if (!Array.isArray(value) || value.length > max) return null;
        const engines = [];
        for (const engine of value) {
          if (!engine || typeof engine !== "object") return null;
          const clean = {};
          for (const [ename, ekind, emin, emax] of ENGINE_FIELDS) {
            if (!(ename in engine)) continue;
            const v = cleanValue(ekind, emin, emax, engine[ename]);
            if (v === undefined) return null;
            if (v !== null) clean[ename] = v;
          }
          engines.push(clean);
        }
        out.eng = engines;
        continue;
      }
      const v = cleanValue(kind, min, max, value);
      if (v === undefined) return null;
      if (v !== null) out[name] = v;
    }
    if (typeof out.t !== "number" || typeof out.lat !== "number" || typeof out.lon !== "number") return null;
    return out;
  }

  const SampleFields = { FIELDS, ENGINE_FIELDS, BY_NAME, cleanSample };
  if (typeof module !== "undefined" && module.exports) module.exports = SampleFields;
  if (root) root.SampleFields = SampleFields;
})(typeof window !== "undefined" ? window : null);
