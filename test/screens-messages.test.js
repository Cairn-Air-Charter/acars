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
  assert.match(release, /run: echo "\{\\"commit\\": \\"\$GITHUB_SHA\\"\}" > src\/build-info\.json/);
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
