// The ACARS screens and messages (flows/acars.md ACR-5 to ACR-7, ACR-16, ACR-17;
// flows/messages.md; flows/versions.md; brand.md → Spacing). No outside services.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApi } = require("../src/main/api");
const releaseNotes = require("../src/main/release-notes");
const places = require("../src/renderer/places");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const html = () => read("src/renderer/index.html");
const app = () => read("src/renderer/app.js");

/** A fake fetch that records every request and answers with { success: true }. */
function recorder() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  return { calls, api: createApi({ fetchImpl, baseUrl: "https://trailhead.example", version: "1.0.5", osVersion: "10.0" }) };
}

// ==========================================
// THE TOP BAR (ACR-5)
// ==========================================

test("the top bar shows the pilot's name only, never the employee ID (ACR-5)", () => {
  const source = app();
  assert.match(source, /\$\("pilotName"\)\.textContent = `\$\{p\.firstName\} \$\{p\.lastName\}`;/);
  assert.doesNotMatch(source, /pilotName"\)\.textContent = [^;]*employeeId/);
});

// ==========================================
// MISSIONS (ACR-6)
// ==========================================

test("a mission's details open right below the mission clicked, not at the bottom of the window (ACR-6)", () => {
  const source = app();
  assert.doesNotMatch(html(), /id="missionDetail"/);
  assert.match(source, /if \(anchor && anchor\.parentNode === list\) anchor\.after\(box\);\s+else list\.prepend\(box\);/);
  assert.match(source, /box\.scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(source, /openMission\(m\.id, row\)/);
  // Clicking the same mission again closes it; only one is open at a time
  assert.match(source, /const wasOpen = existing && existing\.dataset\.missionId === String\(id\);/);
  // From Home, the mission opens at the top of the Missions tab
  assert.match(source, /state\.pendingMission = id;\s+selectTab\("missions"\);/);
});

test("the filters sit in an even grid; the checkbox and Search each get a row of their own (ACR-6, brand.md → Spacing)", () => {
  const page = html();
  const grid = page.slice(page.indexOf('<div class="filter-grid">'), page.indexOf("</div>", page.indexOf('<div class="filter-grid">')));
  assert.match(grid, /id="fSort"/);
  assert.doesNotMatch(grid, /id="fFromHere"/);
  assert.match(page, /<\/div>\s+<label class="check filter-row"><input type="checkbox" id="fFromHere"> Departs from my current airport<\/label>\s+<div class="actions"><button type="submit"/);
  const css = read("src/renderer/styles.css");
  assert.match(css, /\.filter-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(200px, 1fr\)\); gap: 12px 16px;/);
  assert.match(css, /\.filters \{ display: grid; gap: 12px; \}/);
});

test("missions, legs and the logbook show airports as town, region (CODE) (MIS-7 airport display)", () => {
  const source = app();
  assert.match(source, /routePlaces\(m\.route_places, m\.route\)/);
  assert.match(source, /place\(leg\.departure_place, leg\.departure_code\)/);
  assert.match(source, /place\(e\.arrival_place, e\.arrival_code\)/);
  assert.match(html(), /<script src="places\.js" defer><\/script>/);
  assert.equal(places.text({ code: "PADQ", town: "Kodiak", region: "US-AK", country: "US" }, "en"), "Kodiak, AK (PADQ)");
});

// ==========================================
// LOGBOOK (ACR-7)
// ==========================================

test("the logbook is a table only; View report opens the report on Trailhead in the browser (ACR-7)", () => {
  const source = app();
  assert.doesNotMatch(html(), /id="reportView"|flight-charts\.js/);
  assert.doesNotMatch(source, /openReport|FlightCharts/);
  assert.equal(fs.existsSync(path.join(ROOT, "src/renderer/flight-charts.js")), false);
  assert.match(source, /A\.openInBrowser\(`\$\{TRAILHEAD\}\/flights\/\$\{encodeURIComponent\(e\.id\)\}`\) \}, "View report"\)/);
});

// ==========================================
// FILING (ACR-16)
// ==========================================

test("filing shows a line on Home; no popup and no message about processing (ACR-16, MSG-2)", () => {
  const manager = read("src/main/flight/flight-manager.js");
  assert.match(manager, /filed: \(arrival\) => `Report sent\. You're now at \$\{arrival\}\.`/);
  assert.doesNotMatch(manager, /top of the hour/);
  assert.match(app(), /show\("filedLine", result\.message, "success"\);/);
  assert.match(html(), /id="filedLine"/);
});

// ==========================================
// MESSAGES (flows/messages.md)
// ==========================================

test("the Messages tab is the same inbox as Trailhead: lists, conversations, replies, archive, new message (MSG-5)", () => {
  const page = html();
  for (const id of ["messageList", "newMessage", "threadPanel", "threadList", "replyForm", "archiveButton", "composePanel", "composeTo", "composeSend", "messagesPrev", "messagesNext"]) {
    assert.match(page, new RegExp(`id="${id}"`), id);
  }
  for (const box of ["inbox", "sent", "archived"]) assert.match(page, new RegExp(`data-box="${box}"`));
  const source = app();
  // Read and unread come from the server, shared with Trailhead; never kept on this PC
  assert.doesNotMatch(source, /localStorage/);
  assert.match(source, /setUnread\(d\.unread\)/);
});

test("ACARS uses Trailhead's message routes, and message IDs can't be used to reach other addresses (MSG-9)", async () => {
  const { calls, api } = recorder();
  await api.messages("inbox", 20);
  await api.message("k3x9q2m7a");
  await api.message("../../api/admin");
  await api.reply("k3x9q2m7a", "Thanks");
  await api.archive("k3x9q2m7a", true);
  await api.archive("k3x9q2m7a", false);
  await api.sendMessage({ to: "staff_team", subject: "Hi", body: "Hello" });
  await api.saveSubscriptions({ missions_here: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://trailhead.example", "")}`), [
    "GET /api/messages?box=inbox&offset=20",
    "GET /api/messages/k3x9q2m7a",
    "GET /api/messages/not-found",
    "POST /api/messages/k3x9q2m7a/reply",
    "POST /api/messages/k3x9q2m7a/archive",
    "POST /api/messages/k3x9q2m7a/unarchive",
    "POST /api/messages",
    "PUT /api/my/subscriptions",
  ]);
  assert.deepEqual(JSON.parse(calls[7].body), { subscriptions: { missions_here: true } });
});

test("diagnostics carry the pilot's note in a header, up to 500 characters (ACR-17, MSG-7)", async () => {
  const { calls, api } = recorder();
  await api.diagnostics(Buffer.from("PK"), "Crashes when I load the 208 ✈");
  assert.equal(decodeURIComponent(calls[0].headers["X-Cairn-Diagnostics-Note"]), "Crashes when I load the 208 ✈");
  await api.diagnostics(Buffer.from("PK"), "x".repeat(900));
  assert.equal(decodeURIComponent(calls[1].headers["X-Cairn-Diagnostics-Note"]).length, 500);
  await api.diagnostics(Buffer.from("PK"), "");
  assert.equal(calls[2].headers["X-Cairn-Diagnostics-Note"], undefined);
  // The note can't replace who ACARS says it is
  assert.match(calls[0].headers["User-Agent"], /^CairnACARS\/1\.0\.5/);
  assert.match(html(), /id="diagnosticsNote"/);
});

test("Settings has the same Notices as the profile, and explains Remember me (ACR-3, ACR-17, PRO-8)", () => {
  const page = html();
  for (const id of ["alwaysOnList", "optionalList", "saveNotices", "alwaysOnLine"]) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /ACARS keeps you logged in for 30 days from the last time you use it, like a browser\./);
  assert.match(page, /saves your password on this PC \(encrypted for your Windows account\)/);
  const preload = read("src/main/preload.js");
  for (const channel of ["messages:list", "messages:get", "messages:send", "messages:reply", "messages:archive", "messages:recipients", "notices:get", "notices:save", "app:changes"]) {
    assert.match(preload, new RegExp(`call\\("${channel}"\\)`), channel);
  }
});

// ==========================================
// VERSION AND WHAT CHANGED (flows/versions.md)
// ==========================================

test("the version and commit show at the bottom of the window; the commit opens What changed (VER-1, VER-3)", () => {
  const page = html();
  assert.match(page, /<footer class="versionbar">[\s\S]*id="versionCommit"/);
  assert.match(page, /id="changesPanel"/);
  assert.match(app(), /\$\("versionCommit"\)\.addEventListener\("click"/);
  assert.match(read("src/renderer/styles.css"), /\.app \{ display: flex; flex-direction: column; height: 100%; \}/);
});

test("the commit comes from build-info.json, written by the release workflow; 'development' without it (VER-2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acars-build-"));
  const file = path.join(dir, "build-info.json");
  fs.writeFileSync(file, JSON.stringify({ commit: "ABCDEF0123456789" }));
  assert.equal(releaseNotes.commit(file), "abcdef0");
  fs.writeFileSync(file, "{ not json");
  assert.equal(releaseNotes.commit(file), null);
  assert.equal(releaseNotes.commit(path.join(dir, "missing.json")), null);
  const release = read(".github/workflows/release.yml");
  assert.match(release, /run: \|\r?\n\s+echo "\{\\"commit\\": \\"\$GITHUB_SHA\\"\}" > src\/build-info\.json/);
  // The workflow file must be valid YAML, or GitHub refuses to run it
  const yaml = require("js-yaml");
  const workflow = yaml.load(release);
  const step = workflow.jobs.release.steps.find((s) => s.name === "Record the commit");
  assert.equal(step.run.trim(), 'echo "{\\"commit\\": \\"$GITHUB_SHA\\"}" > src/build-info.json');
  assert.ok(release.indexOf("src/build-info.json") < release.indexOf("electron-builder --win"), "written before the build");
  assert.match(read(".gitignore"), /^src\/build-info\.json$/m);
  assert.ok(JSON.parse(read("package.json")).build.files.includes("release-notes.json"));
});

test("release-notes.json is valid, newest first, with safe notes; unsafe notes are never shown (VER-4)", () => {
  assert.deepEqual(releaseNotes.validateNotes(JSON.parse(read("release-notes.json"))), []);
  assert.ok(releaseNotes.noteProblems("Changed flight-manager.js").length);
  assert.ok(releaseNotes.noteProblems("Rotated the API key").length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acars-notes-"));
  const file = path.join(dir, "notes.json");
  fs.writeFileSync(file, JSON.stringify([{ date: "2026-11-16", notes: ["Good note.", "Touched src/main/api.js"] }]));
  assert.deepEqual(releaseNotes.load(file), [{ date: "2026-11-16", notes: ["Good note."] }]);
});

test("a diagnostics note cut at 500 characters never splits an emoji or fails the upload (MSG-7)", async () => {
  const { calls, api } = recorder();
  await api.diagnostics(Buffer.from("PK"), `${"x".repeat(499)}😀 and more`);
  const note = decodeURIComponent(calls[0].headers["X-Cairn-Diagnostics-Note"]);
  assert.equal(Array.from(note).length, 500);
  assert.ok(note.endsWith("😀"));
  await api.diagnostics(Buffer.from("PK"), "broken \uD800 half");
  assert.match(decodeURIComponent(calls[1].headers["X-Cairn-Diagnostics-Note"]), /^broken \uFFFD half$/);
});

test("What changed opens by itself the first time ACARS starts after an update, and only then (VER-3)", () => {
  const { createPrefs } = require("../src/main/prefs");
  // A brand-new install isn't an update
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "acars-prefs-"));
  assert.equal(createPrefs(fresh).updatedTo("1.0.6"), false);
  assert.equal(createPrefs(fresh).updatedTo("1.0.6"), false, "same version again: not shown");
  assert.equal(createPrefs(fresh).updatedTo("1.0.7"), true, "updated: shown");
  assert.equal(createPrefs(fresh).updatedTo("1.0.7"), false, "next start: not shown again");
  // A copy from before this setting existed (settings saved, no version recorded) was updated
  const older = fs.mkdtempSync(path.join(os.tmpdir(), "acars-prefs-"));
  fs.writeFileSync(path.join(older, "settings.json"), JSON.stringify({ chime: true }));
  assert.equal(createPrefs(older).updatedTo("1.0.6"), true);
  // The screen asks once per start; the panel says ACARS was updated
  const main = read("src/main/main.js");
  assert.match(main, /let showChangesOnStart = prefs\.updatedTo\(version\);/);
  assert.match(main, /const updated = showChangesOnStart;\s+showChangesOnStart = false;/);
  const source = app();
  assert.match(source, /if \(notice && notice\.updated\) openChanges\(true\);/);
  assert.match(source, /ACARS was updated\. You're now on \$\{on\}\. Here's what changed\./);
});

test("each release copies the installer, then latest.json, to the website's downloads with no stored key (ACR-2)", () => {
  const yaml = require("js-yaml");
  const workflow = yaml.load(read(".github/workflows/release.yml"));
  assert.equal(workflow.permissions["id-token"], "write");
  const steps = workflow.jobs.release.steps;
  const names = steps.map((s) => s.name || s.uses);
  assert.ok(names.indexOf("Publish one release with every file") < names.indexOf("Sign in to Google Cloud"), "GitHub release first");
  const signIn = steps.find((s) => s.name === "Sign in to Google Cloud");
  assert.deepEqual(signIn.with, { workload_identity_provider: "${{ vars.GCP_WIF_PROVIDER }}", service_account: "${{ vars.GCP_RELEASE_SA }}" });
  const copy = steps.find((s) => s.name === "Copy the installer to the website's downloads").run;
  assert.ok(copy.indexOf('acars/$FILE"') < copy.indexOf("acars/latest.json"), "installer before latest.json");
  assert.ok(copy.includes('acars/latest.json" \\\n  --cache-control="no-cache"'), "latest.json is never cached");
  assert.doesNotMatch(read(".github/workflows/release.yml"), /credentials_json|secrets\.GCP/);
});

// ==========================================
// SAYINTENTIONS (flows/sayintentions.md SI-1, SI-3, SI-5, SI-6)
// ==========================================

test("only 'running' and 'flight active' are read from SayIntentions' local data; its key and email are thrown away (SI-3)", async () => {
  const si = require("../src/main/sayintentions");
  const local = { flight_details: { flight_id: 991, api_key: "SECRET-KEY-1234", Email: "pilot@example.com", userid: 77, callsign: "N123" } };
  assert.deepEqual(si.readLocal(local), { running: true, flight: true });
  assert.deepEqual(si.readLocal({}), { running: true, flight: false });
  const seen = [];
  const watch = si.createSayIntentionsWatch({ fetchImpl: async (url) => { seen.push(url); return { ok: true, json: async () => local }; }, onChange: (s) => seen.push(s) });
  const state = await watch.poll();
  assert.deepEqual(state, { running: true, flight: true });
  assert.equal(seen[0], "http://localhost:43117/flightJSON");
  assert.doesNotMatch(JSON.stringify(seen), /SECRET-KEY|pilot@example/);
  const down = si.createSayIntentionsWatch({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(await down.poll(), { running: false, flight: false });
});

test("no SayIntentions key is ever in ACARS: telexes go to Trailhead by type only (SI-1, SI-5)", async () => {
  for (const file of ["src/main/api.js", "src/main/main.js", "src/main/sayintentions.js", "src/renderer/app.js", "src/main/preload.js"]) {
    assert.doesNotMatch(read(file), /api_key|X-Developer-Key|SI_DEV_KEY|SI_VA_KEY|apipri\.sayintentions/i, file);
  }
  const { calls, api } = recorder();
  await api.telex(12, "staff_message", "k3x9q2m7a");
  await api.telex(12, "start", "../../etc");
  await api.atis(["PADQ", "PANC", "x;y"]);
  assert.equal(calls[0].url, "https://trailhead.example/api/acars/flights/12/telex");
  assert.deepEqual(JSON.parse(calls[0].body), { type: "staff_message", messageId: "k3x9q2m7a" });
  assert.deepEqual(JSON.parse(calls[1].body), { type: "start" });
  assert.equal(calls[2].url, "https://trailhead.example/api/sayintentions/atis?codes=PADQ%2CPANC");
});

test("telexes are asked for only with a key saved, telexes on, and SayIntentions running with a flight; each once (SI-5)", async () => {
  const si = require("../src/main/sayintentions");
  const asked = [];
  const sent = [];
  const api = { telex: async (id, type, messageId) => { asked.push([id, type, messageId]); return { ok: true, data: { sent: true, text: "CAIRN DISPATCH. GOOD FLIGHT." } }; } };
  let prefsTelexes = true;
  let keySaved = true;
  let flight = true;
  const telex = si.createTelexer({ api, prefs: { get: () => prefsTelexes }, watch: { state: () => ({ running: true, flight }) }, keySaved: () => keySaved, onSent: (t) => sent.push(t) });
  await telex(5, "start");
  await telex(5, "start");
  assert.deepEqual(asked, [[5, "start", undefined]], "once");
  assert.deepEqual(sent, ["CAIRN DISPATCH. GOOD FLIGHT."]);
  prefsTelexes = false;
  await telex(5, "welcome");
  prefsTelexes = true;
  keySaved = false;
  await telex(5, "welcome");
  keySaved = true;
  flight = false;
  await telex(5, "welcome");
  assert.equal(asked.length, 1, "telexes off, no key, or no SayIntentions flight: nothing asked");
  // The checklist item is information only, and not shown without a key
  assert.equal(si.checklistItem({ running: false, flight: false }, false), null);
  assert.equal(si.checklistItem({ running: false, flight: false }, true).required, false);
  assert.equal(si.checklistItem({ running: true, flight: true }, true).detail, "SayIntentions is running. Cairn dispatch will reach you by ACARS telex.");
});

test("the pill, Settings, telexes default on, and the ATIS box (SI-3, SI-6)", () => {
  const page = html();
  assert.match(page, /<span id="siPill" class="pill ok" hidden>SayIntentions connected<\/span>/);
  assert.match(page, /id="sTelexes"> Cairn dispatch telexes in the cockpit/);
  assert.match(page, /id="atisBox" hidden/);
  const { createPrefs } = require("../src/main/prefs");
  assert.equal(createPrefs(fs.mkdtempSync(path.join(os.tmpdir(), "acars-si-"))).visible().telexes, true);
  const source = app();
  assert.match(source, /\$\("siPill"\)\.hidden = !\(si && si\.available && si\.running\);/);
  assert.match(source, /setInterval\(loadAtis, 10 \* 60 \* 1000\)/);
  assert.match(read("src/main/main.js"), /if \(geo\.distanceNm\(lastSample\.lat, lastSample\.lon, view\.leg\.arrival\.lat, view\.leg\.arrival\.lon\) > 5\) return;/, "no welcome at a diversion airport");
});

test("a telex held back by the 60-second gap is tried again, a few times at most (SI-5)", async () => {
  const si = require("../src/main/sayintentions");
  const answers = [{ sent: false, reason: "limit" }, { sent: true, text: "CAIRN: NEW MESSAGE FROM CAIRN STAFF. READ IT IN CAIRN ACARS." }];
  const asked = [];
  const waits = [];
  let pending = null;
  const telex = si.createTelexer({
    api: { telex: async (...args) => (asked.push(args), { ok: true, data: answers.shift() || { sent: false, reason: "limit" } }) },
    prefs: { get: () => true },
    watch: { state: () => ({ running: true, flight: true }) },
    keySaved: () => true,
    later: (fn, ms) => { waits.push(ms); pending = fn; },
  });
  await telex(5, "staff_message", "k3x9q2m7a");
  assert.deepEqual(waits, [65000]);
  await pending();
  assert.equal(asked.length, 2);
  assert.equal(waits.length, 1, "sent the second time: no more tries");
});
