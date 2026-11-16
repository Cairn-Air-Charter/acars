// Login and Remember me, the API client, SimConnect values, diagnostics, logs, links,
// window security, and the files shared with Trailhead (flows/acars.md ACR-1 to ACR-3,
// ACR-8, ACR-17, SRV-6).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createAuth, SAVED_PASSWORD_FAILED } = require("../src/main/auth");
const { createApi } = require("../src/main/api");
const { createPrefs } = require("../src/main/prefs");
const { createLogger, redact } = require("../src/main/logger");
const { zip, crc32 } = require("../src/main/diagnostics");
const { isAllowedExternal } = require("../src/main/links");
const vars = require("../src/main/sim/variables");
const { BY_NAME, cleanSample } = require("../src/shared/sample-fields");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cairn-acars-app-"));

// A stand-in for Windows DPAPI (safeStorage): reversible, but never plain text on disk
const secrets = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, "utf8").map((b) => b ^ 0x5a)),
  decryptString: (buf) => Buffer.from(buf.map((b) => b ^ 0x5a)).toString("utf8"),
};

function fakeApi(answers) {
  const calls = [];
  const api = {};
  for (const name of ["login", "me", "logout"]) {
    api[name] = async (...args) => {
      calls.push([name, ...args]);
      const next = answers[name].shift();
      return typeof next === "function" ? next(...args) : next;
    };
  }
  return { api, calls };
}

const ME = { ok: true, status: 200, data: { success: true, pilot: { id: 1, first_name: "Test", last_name: "Pilot", employee_id: "10001", email: "pilot@example.com" }, permissions: [] } };
const NO_SESSION = { ok: false, status: 401, data: { success: false } };
const GENERIC = { ok: false, status: 401, data: { success: false, type: "generic", error: "We couldn't log you in. Please check your email and password and try again." } };

function makeAuth(answers, dir = tempDir()) {
  const prefs = createPrefs(dir);
  const { api, calls } = fakeApi(answers);
  const auth = createAuth({ api, secrets, prefs, locale: () => ({ timeZone: "America/Anchorage", language: "en-US" }), clearSession: async () => {} });
  return { auth, calls, prefs, dir };
}

// ==========================================
// LOGIN AND REMEMBER ME (ACR-3)
// ==========================================

test("logging in uses Trailhead's login with the PC's time zone and language; Remember me saves it encrypted (ACR-3)", async () => {
  const { auth, calls, dir } = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [] });
  const result = await auth.login("pilot@example.com", "Secret-Pass1", true);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["login", "pilot@example.com", "Secret-Pass1", "America/Anchorage", "en-US"]);
  const onDisk = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
  assert.ok(!onDisk.includes("Secret-Pass1"), "the password is never saved in plain text");
  assert.ok(auth.hasSavedPassword());
});

test("a wrong password shows Trailhead's own message and saves nothing (AUTH-4)", async () => {
  const { auth } = makeAuth({ login: [GENERIC], me: [], logout: [] });
  const result = await auth.login("pilot@example.com", "wrong", true);
  assert.equal(result.ok, false);
  assert.equal(result.message, "We couldn't log you in. Please check your email and password and try again.");
  assert.equal(auth.hasSavedPassword(), false);
});

test("an inactive pilot and a locked-out machine get the same messages as the website (AUTH-4, AUTH-5)", async () => {
  const inactive = { ok: false, status: 403, data: { success: false, type: "account_inactive", error: "Your email and password are correct, but your pilot account is inactive. To rejoin Cairn, please submit a new application.", applyUrl: "https://cairncharter.org/apply" } };
  const { auth } = makeAuth({ login: [inactive], me: [], logout: [] });
  const result = await auth.login("pilot@example.com", "right", false);
  assert.equal(result.type, "account_inactive");
  assert.equal(result.applyUrl, "https://cairncharter.org/apply");
  const locked = { ok: false, status: 429, data: { success: false, type: "locked_out", error: "Too many failed attempts. Please try again in 15 minutes.", retryAfterSeconds: 900 } };
  const second = makeAuth({ login: [locked], me: [], logout: [] });
  const r2 = await second.auth.login("pilot@example.com", "x", false);
  assert.deepEqual([r2.type, r2.retryAfterSeconds], ["locked_out", 900]);
});

test("with a valid session, ACARS goes straight in; no login is sent (ACR-3)", async () => {
  const { auth, calls } = makeAuth({ login: [], me: [ME], logout: [] });
  assert.equal((await auth.resume()).ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ["me"]);
});

test("an ended session logs in again once, silently, with the saved details (ACR-3)", async () => {
  const dir = tempDir();
  const first = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [] }, dir);
  await first.auth.login("pilot@example.com", "Secret-Pass1", true);
  const next = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [NO_SESSION, ME], logout: [] }, dir);
  const result = await next.auth.resume();
  assert.equal(result.ok, true);
  assert.deepEqual(next.calls.map((c) => c[0]), ["me", "login", "me"]);
  assert.equal(next.calls[1][2], "Secret-Pass1");
});

test("a failed silent login deletes the saved password, keeps the email, and never retries (ACR-3, AUTH-5)", async () => {
  const dir = tempDir();
  const first = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [] }, dir);
  await first.auth.login("pilot@example.com", "Old-Pass1", true);
  const next = makeAuth({ login: [GENERIC], me: [NO_SESSION, NO_SESSION], logout: [] }, dir);
  const result = await next.auth.resume();
  assert.deepEqual([result.ok, result.message, result.email], [false, SAVED_PASSWORD_FAILED, "pilot@example.com"]);
  assert.equal(next.auth.hasSavedPassword(), false);
  // Opening again doesn't try the old password: there's nothing saved to try
  const again = await next.auth.resume();
  assert.equal(again.ok, false);
  assert.equal(next.calls.filter((c) => c[0] === "login").length, 1);
});

test("offline during a silent login keeps the saved password for later (ACR-3)", async () => {
  const dir = tempDir();
  await makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [] }, dir).auth.login("pilot@example.com", "Pass-123", true);
  const next = makeAuth({ login: [{ ok: false, status: 0, error: "You're offline. ACARS will keep trying.", data: {} }], me: [{ ok: false, status: 0, data: {} }], logout: [] }, dir);
  const result = await next.auth.resume();
  assert.equal(result.offline, true);
  assert.equal(next.auth.hasSavedPassword(), true);
});

test("unchecking Remember me, or logging out, deletes the saved password right away (ACR-3)", async () => {
  const dir = tempDir();
  const a = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [{ ok: true, status: 200, data: {} }] }, dir);
  await a.auth.login("pilot@example.com", "Pass-123", true);
  a.auth.setRememberMe(false);
  assert.equal(a.auth.hasSavedPassword(), false);
  const b = makeAuth({ login: [{ ok: true, status: 200, data: { success: true } }], me: [ME], logout: [{ ok: true, status: 200, data: {} }] }, dir);
  await b.auth.login("pilot@example.com", "Pass-123", true);
  await b.auth.logout();
  assert.equal(b.auth.hasSavedPassword(), false);
  assert.deepEqual(b.calls.map((c) => c[0]), ["login", "me", "logout"]);
});

// ==========================================
// THE API CLIENT (ACR-2, SRV-6)
// ==========================================

test("every request says it's ACARS, with its version; the edge key is never in ACARS (ACR-2, SRV-6)", async () => {
  const seen = [];
  const api = createApi({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    version: "1.2.3",
    osVersion: "10.0.26100",
  });
  await api.sync();
  assert.equal(seen[0].url, "https://trailhead.cairncharter.org/api/acars/sync");
  assert.equal(seen[0].init.headers["User-Agent"], "CairnACARS/1.2.3 (Windows 10.0.26100)");
  assert.equal(seen[0].init.headers["X-Cairn-ACARS-Version"], "1.2.3");
  for (const file of fs.readdirSync(path.join(ROOT, "src", "main"))) {
    if (file.endsWith(".js")) assert.doesNotMatch(read(`src/main/${file}`), /X-Cairn-Edge|EDGE_KEY/, file);
  }
});

test("ACARS talks to the real Trailhead unless a developer points it at https or this PC", () => {
  const { trailheadUrl } = require("../src/main/api");
  assert.equal(trailheadUrl({}), "https://trailhead.cairncharter.org");
  assert.equal(trailheadUrl({ CAIRN_TRAILHEAD_URL: "http://127.0.0.1:8080/" }), "http://127.0.0.1:8080");
  assert.equal(trailheadUrl({ CAIRN_TRAILHEAD_URL: "http://evil.example.com" }), "https://trailhead.cairncharter.org");
});

test("a 401 tells ACARS the session ended; offline is reported as status 0 (TH-3, ACR-4)", async () => {
  let ended = 0;
  const api = createApi({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ success: false }) }), version: "1.0.0", osVersion: "10", onUnauthorized: () => { ended += 1; } });
  await api.home();
  await api.login("a@example.com", "b"); // a failed login is not an ended session
  assert.equal(ended, 1);
  const offline = createApi({ fetchImpl: async () => { throw new Error("ENOTFOUND"); }, version: "1.0.0", osVersion: "10" });
  const result = await offline.home();
  assert.deepEqual([result.ok, result.status], [false, 0]);
});

// ==========================================
// SIMCONNECT VALUES (ACR-8)
// ==========================================

test("every variable fills a known sample field (ACR-8)", () => {
  for (const v of vars.sampleVariables().concat(vars.frameVariables())) {
    if (!v.field || v.field.startsWith("_") || v.engine !== undefined) continue;
    assert.ok(BY_NAME.has(v.field), `${v.name} -> ${v.field}`);
  }
});

test("values are turned into Cairn's units: nose-up pitch positive, touchdown in fpm, fuel flow in pounds per hour (ACR-8)", () => {
  const list = [
    { name: "PLANE LATITUDE", type: "f", field: "lat" }, { name: "PLANE LONGITUDE", type: "f", field: "lon" },
    { name: "PLANE PITCH DEGREES", type: "f", field: "pitch", convert: "flip" },
    { name: "SIM ON GROUND", type: "i", field: "gnd", convert: "bool" },
    { name: "PLANE TOUCHDOWN NORMAL VELOCITY", type: "f", field: "tdV", convert: "fpsToFpm" },
    { name: "PLANE HEADING DEGREES TRUE", type: "f", field: "hdgT", convert: "heading" },
    { name: "NUMBER OF ENGINES", type: "i", field: "nEng" },
    { name: "FUEL TOTAL QUANTITY", type: "f", field: "fuelGal" }, { name: "FUEL TOTAL QUANTITY WEIGHT", type: "f", field: "fuel" },
    { name: "GENERAL ENG COMBUSTION:1", type: "i", field: "c", convert: "bool", engine: 0 },
    { name: "ENG FUEL FLOW GPH:1", type: "f", field: "_gph", engine: 0 },
    { name: "TURB ENG FUEL FLOW PPH:1", type: "f", field: "_pph", engine: 0 },
    { name: "ZULU YEAR", type: "i", field: "_zy" }, { name: "ZULU MONTH OF YEAR", type: "i", field: "_zm" },
    { name: "ZULU DAY OF MONTH", type: "i", field: "_zd" }, { name: "ZULU TIME", type: "f", field: "_zt" },
  ];
  const s = vars.buildSample(list, [61.2, -149.9, -5, 1, -3, 365, 1, 40, 240, 1, 8, 0, 2026, 11, 16, 3600], 1000);
  assert.deepEqual([s.pitch, s.gnd, s.tdV, s.hdgT], [5, true, 180, 5]);
  assert.equal(s.eng[0].ff, 48); // 8 gal/h at 6 lbs per gallon
  assert.equal(s.fuelFlow, 48);
  assert.equal(s.z, Date.UTC(2026, 10, 16, 1, 0, 0));
  assert.ok(cleanSample(s), "the sample passes the server's own check");
});

test("the type designator comes out of ATC MODEL, even as a text key (FR-9)", () => {
  assert.equal(vars.designatorFrom("TT:ATCCOM.AC_MODEL_C172.0.text"), "C172");
  assert.equal(vars.designatorFrom("TT:ATCCOM.AC_MODEL C208.0.text"), "C208");
  assert.equal(vars.designatorFrom("B738"), "B738");
  assert.equal(vars.designatorFrom("Some Odd Model!"), null);
});

test("an MSFS runway becomes two landing ends with names, headings and surfaces (ACR-8)", () => {
  const [a, b] = vars.runwayEnds({ lat: 45, lon: -100, heading: 90, lengthM: 2000, widthM: 45, primaryNumber: 9, primaryDesignator: 1, secondaryNumber: 27, secondaryDesignator: 2, surface: 4 }, 300);
  assert.deepEqual([a.ident, a.headingTrue, b.ident, b.headingTrue, a.surface], ["09L", 90, "27R", 270, "hard"]);
  assert.ok(a.lon < -100 && b.lon > -100);
  assert.ok(Math.abs(a.lengthFt - 6561.68) < 0.1);
  assert.equal(vars.runwaySurface(2), "water");
  assert.equal(vars.runwaySurface(14), "soft");
});

// ==========================================
// DIAGNOSTICS AND LOGS (ACR-17)
// ==========================================

test("logs never hold passwords, cookies, tokens or email addresses (ACR-17)", () => {
  const cleaned = redact({ email: "pilot@example.com", password: "x", details: { note: "user pilot@example.com", cookie: "connect.sid=abc" }, header: "connect.sid=s%3Aabc; Path=/" });
  const text = JSON.stringify(cleaned);
  for (const secret of ["pilot@example.com", "abc", "\"x\""]) assert.ok(!text.includes(secret), secret);
});

test("old log files are deleted after 14 days (ACR-17)", () => {
  const dir = tempDir();
  const logger = createLogger(dir, () => new Date("2026-11-16T12:00:00Z"));
  fs.writeFileSync(path.join(logger.folder, "acars-2026-10-20.log"), "old\n");
  logger.info("hello");
  logger.prune();
  assert.deepEqual(fs.readdirSync(logger.folder), ["acars-2026-11-16.log"]);
});

test("the diagnostics zip is a real zip that unpacks to the same files (ACR-17)", () => {
  const files = [{ name: "logs/a.log", content: "line one\nline two\n" }, { name: "flight.json", content: "{}" }];
  const buf = zip(files);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const nameLength = buf.readUInt16LE(26);
  const packedLength = buf.readUInt32LE(18);
  const data = zlib.inflateRawSync(buf.subarray(30 + nameLength, 30 + nameLength + packedLength));
  assert.equal(data.toString(), files[0].content);
  assert.equal(buf.readUInt32LE(14), crc32(Buffer.from(files[0].content)));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

// ==========================================
// WINDOW SECURITY AND LINKS (ACR-1)
// ==========================================

test("every window is isolated: contextIsolation, sandbox, no Node, and a strict content security policy (ACR-1)", () => {
  const main = read("src/main/main.js");
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  const html = read("src/renderer/index.html");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self';/);
  assert.doesNotMatch(html, /<script>[^<]/, "no inline scripts");
  assert.doesNotMatch(read("src/renderer/app.js"), /innerHTML|require\(|eval\(/);
});

test("the screens reach the app only through a short list of named functions (ACR-1)", () => {
  const preload = read("src/main/preload.js");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("acars"/);
  assert.doesNotMatch(preload, /ipcRenderer\.(send|sendSync)\(/);
  const exposed = [...preload.matchAll(/call\("([a-z:A-Z]+)"\)/g)].map((m) => m[1]);
  const handled = [...read("src/main/main.js").matchAll(/handle\("([a-z:A-Z]+)"/g)].map((m) => m[1]);
  for (const channel of exposed) assert.ok(handled.includes(channel), channel);
});

test("links open only Cairn's own sites and the ACARS download page, over https (ACR-5)", () => {
  assert.equal(isAllowedExternal("https://trailhead.cairncharter.org/airports/PANC"), true);
  assert.equal(isAllowedExternal("https://github.com/Cairn-Air-Charter/acars/releases/latest"), true);
  assert.equal(isAllowedExternal("http://trailhead.cairncharter.org/"), false);
  assert.equal(isAllowedExternal("https://evil.example.com/"), false);
  assert.equal(isAllowedExternal("javascript:alert(1)"), false);
});

test("the minimum window is 1024 x 640, one window, per-user installer with no admin password (ACR-1, ACR-2)", () => {
  const main = read("src/main/main.js");
  assert.match(main, /minWidth: 1024/);
  assert.match(main, /minHeight: 640/);
  assert.match(main, /requestSingleInstanceLock/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.deepEqual(pkg.build.publish[0], { provider: "github", owner: "Cairn-Air-Charter", repo: "acars", releaseType: "release" });
});

test("updates never install during a flight (ACR-2)", () => {
  const { createUpdater } = require("../src/main/updater");
  const { EventEmitter } = require("node:events");
  const fake = Object.assign(new EventEmitter(), { checkForUpdates: async () => {} });
  let flying = true;
  const updater = createUpdater({ log: () => {}, flightActive: () => flying, notify: () => {}, autoUpdater: fake });
  updater.beforeQuit();
  assert.equal(fake.autoInstallOnAppQuit, false);
  flying = false;
  updater.beforeQuit();
  assert.equal(fake.autoInstallOnAppQuit, true);
});

// ==========================================
// BRAND AND SHARED FILES
// ==========================================

test("the stylesheet uses only the brand tokens: no hex colors outside tokens.css (brand.md)", () => {
  assert.doesNotMatch(read("src/renderer/styles.css"), /#[0-9a-fA-F]{3,8}\b/);
  assert.match(read("src/renderer/index.html"), /src="assets\/cairn-primary-dark\.png" alt="Cairn Air Charter" width="180"/);
});

test("Trailhead's shared files are identical copies (sample fields, charts, dates, tokens, test flights)", (t) => {
  const trailhead = path.join(ROOT, "..", "trailhead");
  const props = path.join(ROOT, "..", "coding-properties");
  if (!fs.existsSync(trailhead) || !fs.existsSync(props)) return t.skip("trailhead and coding-properties aren't next to this repository");
  const pairs = [
    ["src/shared/sample-fields.js", path.join(trailhead, "acars", "sample-fields.js")],
    ["src/renderer/flight-charts.js", path.join(trailhead, "public", "flight-charts.js")],
    ["src/renderer/datetime.js", path.join(trailhead, "public", "datetime.js")],
    ["test/helpers/synthetic-flight.js", path.join(trailhead, "test", "helpers", "synthetic-flight.js")],
    ["src/renderer/tokens.css", path.join(props, "tokens.css")],
  ];
  for (const [mine, theirs] of pairs) assert.equal(read(mine), fs.readFileSync(theirs, "utf8"), mine);
});
