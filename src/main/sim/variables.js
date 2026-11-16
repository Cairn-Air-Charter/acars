// Every SimConnect variable ACARS reads (flows/acars.md ACR-8), with its units, its type and
// the sample field it fills (src/shared/sample-fields.js). One map per simulator version,
// because MSFS 2024 renamed or retired a few (for example the aircraft title). A variable a
// simulator doesn't have is dropped and recorded as missing; it never breaks the flight.
"use strict";

const ENGINES = 4;

// [SimConnect name, units, type, sample field, convert]
// type: "f" FLOAT64, "i" INT32, "s32"/"s64"/"s256" strings
const COMMON = [
  ["PLANE LATITUDE", "degrees", "f", "lat"],
  ["PLANE LONGITUDE", "degrees", "f", "lon"],
  ["PLANE ALTITUDE", "feet", "f", "alt"],
  ["PLANE ALT ABOVE GROUND", "feet", "f", "agl"],
  ["PLANE ALT ABOVE GROUND MINUS CG", "feet", "f", "aglCg"],
  ["INDICATED ALTITUDE", "feet", "f", "ialt"],
  ["PRESSURE ALTITUDE", "feet", "f", "palt"],
  ["AIRSPEED INDICATED", "knots", "f", "ias"],
  ["AIRSPEED TRUE", "knots", "f", "tas"],
  ["AIRSPEED MACH", "mach", "f", "mach"],
  ["GROUND VELOCITY", "knots", "f", "gs"],
  ["VERTICAL SPEED", "feet per minute", "f", "vs"],
  ["VELOCITY BODY Z", "feet per second", "f", "vbz"],
  ["PLANE HEADING DEGREES TRUE", "degrees", "f", "hdgT", "heading"],
  ["PLANE HEADING DEGREES MAGNETIC", "degrees", "f", "hdgM", "heading"],
  ["GPS GROUND TRUE TRACK", "degrees", "f", "trk", "heading"],
  // SimConnect reports pitch as negative when the nose is up; Cairn uses nose-up positive
  ["PLANE PITCH DEGREES", "degrees", "f", "pitch", "flip"],
  ["PLANE BANK DEGREES", "degrees", "f", "bank"],
  ["G FORCE", "gforce", "f", "g"],
  ["SIM ON GROUND", "bool", "i", "gnd", "bool"],
  ["SURFACE TYPE", "enum", "i", "surf"],
  ["ON ANY RUNWAY", "bool", "i", "rwy", "bool"],
  ["BRAKE PARKING POSITION", "bool", "i", "pbrk", "bool"],
  ["BRAKE PARKING INDICATOR", "bool", "i", "pbrkInd", "bool"],
  ["PUSHBACK STATE", "enum", "i", "push"],
  ["GEAR HANDLE POSITION", "bool", "i", "gearH", "bool"],
  ["GEAR TOTAL PCT EXTENDED", "percent", "f", "gear"],
  ["IS GEAR RETRACTABLE", "bool", "i", "gearRet", "bool"],
  ["IS GEAR FLOATS", "bool", "i", "floats", "bool"],
  ["FLAPS HANDLE INDEX", "number", "i", "flapsIdx"],
  ["FLAPS HANDLE PERCENT", "percent", "f", "flaps"],
  ["TRAILING EDGE FLAPS LEFT PERCENT", "percent", "f", "flapsTe"],
  ["SPOILERS HANDLE POSITION", "percent", "f", "spl"],
  ["SPOILERS ARMED", "bool", "i", "splArm", "bool"],
  ["NUMBER OF ENGINES", "number", "i", "nEng"],
  ["ENGINE TYPE", "enum", "i", "engType"],
  ["FUEL TOTAL QUANTITY", "gallons", "f", "fuelGal"],
  ["FUEL TOTAL QUANTITY WEIGHT", "pounds", "f", "fuel"],
  ["FUEL WEIGHT PER GALLON", "pounds", "f", null],
  ["TOTAL WEIGHT", "pounds", "f", "wt"],
  ["MAX GROSS WEIGHT", "pounds", "f", "mgw"],
  ["EMPTY WEIGHT", "pounds", "f", "ew"],
  ["AMBIENT WIND DIRECTION", "degrees", "f", "wDir", "heading"],
  ["AMBIENT WIND VELOCITY", "knots", "f", "wSpd"],
  ["AIRCRAFT WIND X", "knots", "f", "wX"],
  ["AIRCRAFT WIND Z", "knots", "f", "wZ"],
  ["AMBIENT TEMPERATURE", "celsius", "f", "oat"],
  ["AMBIENT VISIBILITY", "meters", "f", "vis"],
  ["AMBIENT IN CLOUD", "bool", "i", "cloud", "bool"],
  ["AMBIENT PRECIP STATE", "mask", "i", "precip"],
  ["SEA LEVEL PRESSURE", "millibars", "f", "slp"],
  ["KOHLSMAN SETTING HG:1", "inHg", "f", "kohl"],
  ["STALL WARNING", "bool", "i", "stall", "bool"],
  ["OVERSPEED WARNING", "bool", "i", "ovs", "bool"],
  ["FLAP SPEED EXCEEDED", "bool", "i", "flapOvs", "bool"],
  ["GEAR SPEED EXCEEDED", "bool", "i", "gearOvs", "bool"],
  ["GPWS WARNING", "bool", "i", "gpws", "bool"],
  ["GPWS SYSTEM ACTIVE", "bool", "i", "gpwsOn", "bool"],
  ["PLANE TOUCHDOWN LATITUDE", "degrees", "f", "tdLat"],
  ["PLANE TOUCHDOWN LONGITUDE", "degrees", "f", "tdLon"],
  // Feet per second, positive descending -> feet per minute
  ["PLANE TOUCHDOWN NORMAL VELOCITY", "feet per second", "f", "tdV", "fpsToFpm"],
  ["PLANE TOUCHDOWN PITCH DEGREES", "degrees", "f", "tdPitch", "flip"],
  ["PLANE TOUCHDOWN BANK DEGREES", "degrees", "f", "tdBank"],
  ["PLANE TOUCHDOWN HEADING DEGREES TRUE", "degrees", "f", "tdHdg", "heading"],
  ["NAV HAS LOCALIZER:1", "bool", "i", "locOk", "bool"],
  ["NAV HAS GLIDE SLOPE:1", "bool", "i", "gsOk", "bool"],
  ["NAV CDI:1", "number", "f", "cdi"],
  ["NAV GLIDE SLOPE ERROR:1", "degrees", "f", "gsErr"],
  ["NAV GS FLAG:1", "bool", "i", "gsFlag", "bool"],
  ["NAV IDENT:1", null, "s8", "navId"],
  ["AUTOPILOT MASTER", "bool", "i", "ap", "bool"],
  ["AUTOPILOT ALTITUDE LOCK VAR", "feet", "f", "apAlt"],
  ["AUTOPILOT AIRSPEED HOLD VAR", "knots", "f", "apSpd"],
  ["LIGHT BEACON", "bool", "i", "lBcn", "bool"],
  ["LIGHT NAV", "bool", "i", "lNav", "bool"],
  ["LIGHT STROBE", "bool", "i", "lStrb", "bool"],
  ["LIGHT LANDING", "bool", "i", "lLand", "bool"],
  ["LIGHT TAXI", "bool", "i", "lTaxi", "bool"],
  ["PRESSURIZATION CABIN ALTITUDE", "feet", "f", "cabAlt"],
  ["PRESSURIZATION CABIN ALTITUDE RATE", "feet per minute", "f", "cabRate"],
  ["CABIN SEATBELTS ALERT SWITCH", "bool", "i", "belts", "bool"],
  ["TRANSPONDER CODE:1", "number", "i", "xpdr"],
  ["COM ACTIVE FREQUENCY:1", "MHz", "f", "com"],
  ["SIMULATION RATE", "number", "f", "simRate"],
  ["IS SLEW ACTIVE", "bool", "i", "slew", "bool"],
  ["SIM DISABLED", "bool", "i", null],
  ["REALISM CRASH DETECTION", "bool", "i", "crashOn", "bool"],
  ["CRASH FLAG", "enum", "i", "crash"],
  ["CRASH SEQUENCE", "enum", "i", "crashSeq"],
  ["ZULU YEAR", "number", "i", "_zy"],
  ["ZULU MONTH OF YEAR", "number", "i", "_zm"],
  ["ZULU DAY OF MONTH", "number", "i", "_zd"],
  ["ZULU TIME", "seconds", "f", "_zt"],
  ["LOCAL TIME", "seconds", "f", null],
  ["ABSOLUTE TIME", "seconds", "f", null],
];

// Per-engine variables, for engines 1 to 4: [name, units, type, engine field, convert]
const ENGINE_VARS = [
  ["GENERAL ENG COMBUSTION", "bool", "i", "c", "bool"],
  ["GENERAL ENG RPM", "rpm", "f", "rpm"],
  ["TURB ENG N1", "percent", "f", "n1"],
  ["TURB ENG N2", "percent", "f", "n2"],
  ["GENERAL ENG THROTTLE LEVER POSITION", "percent", "f", "thr"],
  ["ENG FUEL FLOW GPH", "gallons per hour", "f", "_gph"],
  ["TURB ENG FUEL FLOW PPH", "pounds per hour", "f", "_pph"],
  ["GENERAL ENG FAILED", "bool", "i", "fail", "bool"],
];

// The loaded aircraft (FR-9). MSFS 2024 retired TITLE's meaning; LIVERY NAME stands in.
const IDENTITY = {
  msfs2020: [["TITLE", null, "s256", "title"], ["ATC MODEL", null, "s32", "model"], ["ATC TYPE", null, "s64", "atcType"], ["ATC ID", null, "s32", "atcId"], ["CATEGORY", null, "s32", "category"]],
  msfs2024: [["TITLE", null, "s256", "title"], ["LIVERY NAME", null, "s256", "livery"], ["ATC MODEL", null, "s32", "model"], ["ATC TYPE", null, "s64", "atcType"], ["ATC ID", null, "s32", "atcId"], ["CATEGORY", null, "s32", "category"]],
};

// The fast subset read every simulator frame around takeoff and landing (ACR-8)
const FRAME_FIELDS = new Set(["lat", "lon", "alt", "agl", "aglCg", "ias", "gs", "vs", "hdgT", "trk", "pitch", "bank", "g", "gnd", "rwy", "surf", "gear", "flapsIdx", "tdLat", "tdLon", "tdV", "tdPitch", "tdBank", "tdHdg", "wDir", "wSpd", "simRate", "slew", "crash", "crashSeq"]);

function sampleVariables() {
  const list = COMMON.map(([name, units, type, field, convert]) => ({ name, units, type, field, convert }));
  for (let n = 1; n <= ENGINES; n += 1) {
    for (const [name, units, type, field, convert] of ENGINE_VARS) list.push({ name: `${name}:${n}`, units, type, field, convert, engine: n - 1 });
  }
  return list;
}

function frameVariables() {
  return sampleVariables().filter((v) => FRAME_FIELDS.has(v.field));
}

function identityVariables(simulator) {
  return (IDENTITY[simulator] || IDENTITY.msfs2020).map(([name, units, type, field]) => ({ name, units, type, field }));
}

/**
 * Turns raw values (in definition order) into a sample in Cairn's units (sample-fields.js).
 * t is the PC's UTC time in milliseconds.
 */
function buildSample(variables, values, t) {
  const s = { t };
  const engines = [];
  variables.forEach((v, i) => {
    let value = values[i];
    if (value === undefined || value === null || (typeof value === "number" && !Number.isFinite(value)) || !v.field) return;
    if (v.convert === "bool") value = value !== 0;
    else if (v.convert === "flip") value = -value;
    else if (v.convert === "heading") value = ((value % 360) + 360) % 360;
    else if (v.convert === "fpsToFpm") value = Math.abs(value) * 60;
    if (v.engine !== undefined) {
      engines[v.engine] = engines[v.engine] || {};
      engines[v.engine][v.field] = value;
      return;
    }
    s[v.field] = value;
  });
  // Zulu time from the simulator's date and seconds since midnight
  if (s._zy && s._zm && s._zd && typeof s._zt === "number") s.z = Date.UTC(s._zy, s._zm - 1, s._zd) + Math.round(s._zt * 1000);
  delete s._zy;
  delete s._zm;
  delete s._zd;
  delete s._zt;
  const count = typeof s.nEng === "number" ? Math.max(0, Math.min(ENGINES, s.nEng)) : 0;
  if (count) {
    s.eng = engines.slice(0, count).map((e) => {
      const engine = { ...(e || {}) };
      // Fuel flow in pounds per hour: turbines report it directly; pistons in gallons per hour
      const pph = engine._pph > 0 ? engine._pph : engine._gph > 0 && s.fuelGal > 0 && s.fuel > 0 ? engine._gph * (s.fuel / s.fuelGal) : 0;
      engine.ff = Math.round(pph * 10) / 10;
      delete engine._pph;
      delete engine._gph;
      return engine;
    });
    s.fuelFlow = Math.round(s.eng.reduce((sum, e) => sum + (e.ff || 0), 0) * 10) / 10;
  }
  if (typeof s.xpdr === "number" && (s.xpdr < 0 || s.xpdr > 7777)) delete s.xpdr;
  if (typeof s.navId === "string") s.navId = s.navId.trim().slice(0, 8);
  return s;
}

/**
 * The ICAO type designator from ATC MODEL. Some aircraft report a text key such as
 * "TT:ATCCOM.AC_MODEL_C172.0.text"; the designator is taken out of it (FR-9 step 1).
 */
function designatorFrom(model) {
  const text = String(model || "").trim().toUpperCase();
  const keyed = /AC_MODEL[ _]([A-Z0-9]{2,4})\b/.exec(text);
  if (keyed) return keyed[1];
  return /^[A-Z0-9]{2,8}$/.test(text) ? text : null;
}

// MSFS runway surfaces -> hard, soft or water
const HARD_SURFACES = new Set([0, 4, 10, 15, 16, 17, 18, 19, 23]);
function runwaySurface(code) {
  if (code === 2) return "water";
  return HARD_SURFACES.has(code) ? "hard" : "soft";
}

const DESIGNATORS = { 0: "", 1: "L", 2: "R", 3: "C", 4: "W", 5: "A", 6: "B" };
const FT_PER_M = 3.28084;

function runwayIdent(number, designator) {
  if (!number) return null;
  const n = number > 36 ? null : String(number).padStart(2, "0");
  return n ? `${n}${DESIGNATORS[designator] || ""}` : null;
}

/**
 * Turns an MSFS runway (centre, heading, length, width in meters) into its two landing ends,
 * the same shape the server uses (foqa/geometry.js). Displaced thresholds aren't sent from
 * MSFS here, so the server fills them in from OurAirports when it knows them.
 */
function runwayEnds(runway, airportElevationM) {
  const lengthFt = runway.lengthM * FT_PER_M;
  const half = lengthFt / 2;
  const toRad = (d) => (d * Math.PI) / 180;
  const move = (lat, lon, bearing, ft) => {
    const R = 20902231;
    const d = ft / R;
    const b = toRad(bearing);
    const la = toRad(lat);
    const lo = toRad(lon);
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: (la2 * 180) / Math.PI, lon: ((((lo2 * 180) / Math.PI) + 540) % 360) - 180 };
  };
  const heading = ((runway.heading % 360) + 360) % 360;
  const primary = move(runway.lat, runway.lon, heading + 180, half);
  const secondary = move(runway.lat, runway.lon, heading, half);
  const base = { lengthFt, widthFt: runway.widthM * FT_PER_M, surface: runwaySurface(runway.surface), elevationFt: typeof airportElevationM === "number" ? airportElevationM * FT_PER_M : null };
  return [
    { ...base, ident: runwayIdent(runway.primaryNumber, runway.primaryDesignator), lat: primary.lat, lon: primary.lon, headingTrue: heading },
    { ...base, ident: runwayIdent(runway.secondaryNumber, runway.secondaryDesignator), lat: secondary.lat, lon: secondary.lon, headingTrue: (heading + 180) % 360 },
  ];
}

module.exports = { COMMON, ENGINE_VARS, IDENTITY, sampleVariables, frameVariables, identityVariables, buildSample, designatorFrom, runwaySurface, runwayIdent, runwayEnds };
