// Cairn ACARS screens (flows/acars.md ACR-3 to ACR-17). Runs in a sandboxed window with no
// Node access; everything goes through window.acars (preload.js). Text is always set as
// text, never HTML. Dates and times use the shared CairnTime helper (GEN-8).
"use strict";

const A = window.acars;
const TRAILHEAD = "https://trailhead.cairncharter.org";
const HOME_REFRESH_MS = 60 * 1000; // ACR-4
const PAGE = 20;

const PHASES = [
  ["preflight", "Preflight"], ["pushback", "Pushback"], ["engine_start", "Engine start"], ["taxi_out", "Taxi out"],
  ["takeoff", "Takeoff"], ["climb", "Climb"], ["cruise", "Cruise"], ["descent", "Descent"], ["approach", "Approach"],
  ["landed", "Landed"], ["taxi_in", "Taxi in"], ["parked", "Parked"], ["engines_off", "Engines off"],
];
const STATUS_LABELS = { approved: "Approved", pending: "Pending", in_review: "In review", denied: "Not credited (crash)" };
const DIVERSION_PICKS = [["weather", "Weather"], ["fuel", "Fuel"], ["mechanical", "Mechanical"], ["medical", "Passenger or medical"], ["atc", "ATC or airspace"], ["decision", "My decision"], ["other", "Other"]];

const $ = (id) => document.getElementById(id);
const state = {
  tab: "home",
  home: null,
  options: null,
  flight: null,
  sim: null,
  missionsOffset: 0,
  logOffset: 0,
  seenNotices: new Set(),
  pendingMission: null,
  unread: 0,
  msgBox: "inbox",
  msgOffset: 0,
  msgTotal: 0,
  openMessage: null,
  chime: true,
  phaseTimes: {},
  diversionPick: null,
  homeTimer: null,
};

// ==========================================
// HELPERS
// ==========================================

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "onclick") node.addEventListener("click", value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const number = (v, places = 0) => (v === null || v === undefined ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: places }));
const minutes = (m) => (m === null || m === undefined ? "—" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);

/** A message with a single OK button. */
const notify = (text) => confirm(text, true);

/** An airport code that opens its Trailhead page in the browser (ACR-5, AIR-1). */
function airport(code) {
  if (!code) return "—";
  return el("button", { type: "button", className: "link-button", onclick: () => A.openInBrowser(`${TRAILHEAD}/airports/${encodeURIComponent(code)}`) }, code);
}

function route(codes) {
  const parts = [];
  codes.forEach((c, i) => {
    if (i) parts.push(" → ");
    parts.push(airport(c));
  });
  return parts;
}

/** "Anchorage, AK (PANC)", with only the code a link (MIS-7 airport display). */
function place(p, code) {
  if (!p) return [airport(code)];
  const words = CairnPlaces.label(p);
  const linked = el("span", { className: "place-code" }, words ? "(" : "", airport(p.code), words ? ")" : "");
  return words ? [`${words} `, linked] : [linked];
}

/** A route of places joined with arrows; plain codes when the server sent no places. */
function routePlaces(places, codes) {
  if (!places || !places.length) return route(codes || []);
  const parts = [];
  places.forEach((p, i) => {
    if (i) parts.push(" → ");
    parts.push(...place(p));
  });
  return parts;
}

function show(id, text, kind) {
  const box = $(id);
  box.textContent = text || "";
  if (kind) box.className = `message message-${kind}`;
  box.hidden = !text;
}

function confirm(text, single) {
  return new Promise((resolve) => {
    $("confirmText").textContent = text;
    $("confirmYes").textContent = single ? "OK" : "Yes";
    $("confirmNo").hidden = Boolean(single);
    $("confirmPanel").hidden = false;
    const done = (answer) => {
      $("confirmPanel").hidden = true;
      $("confirmYes").onclick = null;
      $("confirmNo").onclick = null;
      resolve(answer);
    };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
  });
}

// A short chime for new messages (can be turned off in Settings, ACR-10)
function chime() {
  if (!state.chime) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    /* no sound device */
  }
}

// ==========================================
// LOGIN (ACR-3)
// ==========================================

async function startUp() {
  const auth = await A.authState();
  applyAuth(auth);
}

function applyAuth(auth) {
  $("loginView").hidden = auth.loggedIn;
  $("appView").hidden = !auth.loggedIn;
  if (!auth.loggedIn) {
    $("loginEmail").value = auth.email || "";
    $("loginRemember").checked = auth.rememberMe;
    $("loginPassword").value = "";
    show("loginMessage", auth.message, "error");
    clearInterval(state.homeTimer);
    return;
  }
  const p = auth.pilot;
  // The pilot's name only: never the employee ID or email in the top bar (ACR-5)
  $("pilotName").textContent = `${p.firstName} ${p.lastName}`;
  $("accountWho").textContent = `Logged in as ${p.firstName} ${p.lastName} (${p.email}).`;
  $("sRemember").checked = auth.rememberMe;
  loadSettings();
  refreshFlight();
  selectTab(state.flight ? "flight" : state.tab);
  clearInterval(state.homeTimer);
  state.homeTimer = setInterval(() => {
    if (state.tab === "home") loadHome();
  }, HOME_REFRESH_MS);
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginButton").disabled = true;
  const result = await A.login({ email: $("loginEmail").value, password: $("loginPassword").value, remember: $("loginRemember").checked });
  $("loginButton").disabled = false;
  $("loginPassword").value = "";
  if (!result.loggedIn && result.type === "locked_out") {
    $("loginButton").disabled = true;
    setTimeout(() => { $("loginButton").disabled = false; }, (result.retryAfterSeconds || 60) * 1000);
  }
  applyAuth(result);
});
$("forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  A.openInBrowser(`${TRAILHEAD}/forgot-password`);
});

// ==========================================
// TABS
// ==========================================

function selectTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll(".tab")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  for (const name of ["home", "missions", "logbook", "messages", "settings", "flight"]) $(`${name}View`).hidden = name !== tab;
  if (tab === "home") loadHome();
  if (tab === "messages") loadMessages(state.msgOffset);
  if (tab === "missions") loadMissions(state.missionsOffset);
  if (tab === "logbook") loadLogbook(state.logOffset);
  if (tab === "settings") loadSettings();
}
for (const button of document.querySelectorAll(".tab")) button.addEventListener("click", () => selectTab(button.dataset.tab));

// ==========================================
// HOME (ACR-5)
// ==========================================

async function loadHome() {
  const result = await A.home();
  if (!result.ok) return;
  const h = result.data;
  state.home = h;
  const here = h.currentAirport;
  $("youAreAt").replaceChildren("You're at ", airport(here.code), here.isHomeBase ? ", the Cairn home base" : "");

  // Messages live on their own tab. A new one plays the chime, and Home only says how
  // many are unread. Read and unread are kept on the server, shared with Trailhead (MSG-5).
  let fresh = false;
  for (const n of h.notices) {
    if (!state.seenNotices.has(n.id)) {
      if (state.seenNotices.size) fresh = true;
      state.seenNotices.add(n.id);
    }
  }
  if (fresh) chime();
  setUnread(h.unreadMessages || 0);
  if (state.tab === "messages") loadMessages(state.msgOffset);
  const unread = state.unread;
  $("notices").replaceChildren(...(unread ? [el("p", { className: "message message-info notice" },
    el("span", {}, `You have ${unread} new message${unread === 1 ? "" : "s"}.`),
    el("button", { type: "button", className: "button button-secondary", onclick: () => selectTab("messages") }, "Open messages"))] : []));

  // Your mission, every leg in order
  const m = h.mission;
  $("noMission").hidden = Boolean(m);
  $("legTable").hidden = !m;
  $("dropButton").hidden = !m;
  $("missionSummary").textContent = "";
  $("legRows").textContent = "";
  if (m) {
    $("missionSummary").append(
      el("p", { className: "row-title" }, m.title),
      el("p", { className: "muted" }, `${m.type_label} · ${m.aircraft} · due ${CairnTime.formatDateTime(m.due_at)} (${CairnTime.formatRelativeRemaining(m.due_at)})`)
    );
    for (const leg of m.legs) {
      const start = leg.state === "next" && !state.flight
        ? el("button", { type: "button", className: "button button-primary", onclick: () => openChecklist(leg) }, "Start flight")
        : null;
      const cargo = (leg.cargo_items || []).map((c) => c.description).join(", ");
      $("legRows").append(el("tr", {},
        el("td", {}, String(leg.leg_number), leg.is_recovery ? el("span", { className: "tag" }, " recovery") : null),
        el("td", {}, place(leg.departure_place, leg.departure_code)),
        el("td", {}, place(leg.arrival_place, leg.arrival_code)),
        el("td", {}, `${number(leg.distance_nm)} nm`),
        el("td", {}, String(leg.passengers)),
        el("td", {}, `${number(leg.cargo_lbs)} lbs${cargo ? ` (${cargo})` : ""}`),
        el("td", { className: `state-${leg.state}` }, leg.state === "flown" ? "Flown" : leg.state === "next" ? "Next" : "Later"),
        el("td", {}, start)
      ));
    }
    $("dropButton").disabled = Boolean(state.flight);
    $("dropButton").title = state.flight ? "Finish or cancel your flight first." : "";
  }

  // Missions from the current airport
  const list = $("hereMissions");
  list.textContent = "";
  if (!h.missionsHere.length) list.append(el("li", { className: "muted" }, `Nothing leaving ${here.code} right now. New missions show up every hour.`));
  for (const mission of h.missionsHere) list.append(missionRow(mission, false));

  const notes = h.foqaNotes || [];
  $("foqaNotesCard").hidden = notes.length === 0;
  $("foqaNotes").replaceChildren(...notes.map((n) => el("li", { className: "row" }, n.text)));
}

/** One mission. On the Missions tab its details open right below it; from Home, on the Missions tab. */
function missionRow(m, onBoard) {
  const row = el("li", { className: "row" });
  const open = () => (onBoard ? openMission(m.id, row) : showMissionOnBoard(m.id));
  row.append(
    el("span", { className: "row-title" }, el("button", { type: "button", className: "link-button", onclick: open }, m.title), " ", el("span", { className: "tag" }, m.type_label || m.mission_type)),
    el("span", { className: "muted" }, routePlaces(m.route_places, m.route), ` · ${m.aircraft} · ${number(m.distance)} nm · ${m.legs} leg${m.legs === 1 ? "" : "s"} · ${m.passengers} passengers · ${number(m.cargo_lbs)} lbs`)
  );
  return row;
}

/** From Home: switch to Missions and open this mission at the top of the list. */
function showMissionOnBoard(id) {
  state.pendingMission = id;
  selectTab("missions");
}

$("allFromHere").addEventListener("click", () => {
  $("fFromHere").checked = true;
  state.missionsOffset = 0;
  selectTab("missions");
});

$("dropButton").addEventListener("click", async () => {
  const m = state.home && state.home.mission;
  if (!m) return;
  if (!(await confirm("Drop this mission? It goes back on the board for someone else."))) return;
  const result = await A.dropMission(m.id);
  if (!result.ok) await notify(result.error);
  loadHome();
});

// ==========================================
// MISSIONS (ACR-6)
// ==========================================

async function loadOptions() {
  if (state.options) return state.options;
  const result = await A.missionOptions();
  if (!result.ok) return null;
  state.options = result.data;
  const fill = (id, entries) => $(id).append(...entries.map(([value, label]) => el("option", { value }, label)));
  fill("fType", Object.entries(result.data.types));
  fill("fAircraft", result.data.aircraft.map((a) => [String(a.id), a.name]));
  fill("fClass", Object.entries(result.data.classes));
  fill("fSim", Object.entries(result.data.simulators));
  fill("fContinent", Object.entries(result.data.continents));
  fill("fCountry", result.data.countries.map((c) => [c, c]));
  // The simulator filter starts on the simulator ACARS detects
  if (state.sim && state.sim.simulator) $("fSim").value = state.sim.simulator;
  return state.options;
}

async function loadMissions(offset) {
  await loadOptions();
  const query = { limit: String(PAGE), offset: String(offset), sort: $("fSort").value };
  for (const [key, id] of [["type", "fType"], ["aircraft", "fAircraft"], ["class", "fClass"], ["sim", "fSim"], ["continent", "fContinent"], ["country", "fCountry"]]) {
    if ($(id).value) query[key] = $(id).value;
  }
  if ($("fDeparture").value.trim()) query.departure = $("fDeparture").value.trim().toUpperCase();
  if ($("fFromHere").checked) query.fromMyAirport = "1";
  const result = await A.missions(query);
  const list = $("missionList");
  list.textContent = "";
  if (!result.ok) {
    list.append(el("li", { className: "muted" }, result.error));
    return;
  }
  state.missionsOffset = result.data.offset;
  if (!result.data.missions.length) list.append(el("li", { className: "muted" }, "No missions match those filters right now."));
  for (const m of result.data.missions) list.append(missionRow({ ...m, type_label: state.options.types[m.mission_type] }, true));
  const total = result.data.total;
  $("missionsPage").textContent = total ? `Page ${Math.floor(state.missionsOffset / PAGE) + 1} of ${Math.max(1, Math.ceil(total / PAGE))}` : "";
  $("missionsPrev").disabled = state.missionsOffset === 0;
  $("missionsNext").disabled = state.missionsOffset + PAGE >= total;
  if (state.pendingMission) {
    const id = state.pendingMission;
    state.pendingMission = null;
    openMission(id, null);
  }
}

$("missionFilters").addEventListener("submit", (e) => {
  e.preventDefault();
  loadMissions(0);
});
$("missionsPrev").addEventListener("click", () => loadMissions(Math.max(0, state.missionsOffset - PAGE)));
$("missionsNext").addEventListener("click", () => loadMissions(state.missionsOffset + PAGE));

/**
 * A mission's details, opened right below the mission clicked, so they appear where the
 * pilot is looking (ACR-6, brand.md → Spacing). Clicking the same mission again closes them.
 * anchor: the row clicked, or null to open at the top of the list.
 */
async function openMission(id, anchor) {
  const list = $("missionList");
  const existing = list.querySelector(".mission-detail");
  const wasOpen = existing && existing.dataset.missionId === String(id);
  if (existing) existing.remove();
  if (wasOpen) return;
  const box = el("li", { className: "card stack mission-detail", dataset: { missionId: String(id) } }, el("p", { className: "muted" }, "Loading…"));
  if (anchor && anchor.parentNode === list) anchor.after(box);
  else list.prepend(box);
  const result = await A.mission(id);
  if (!box.isConnected) return;
  box.textContent = "";
  const close = el("button", { type: "button", className: "button button-secondary", onclick: () => box.remove() }, "Close");
  if (!result.ok) {
    box.append(el("p", {}, result.error), el("div", { className: "actions" }, close));
    return;
  }
  const m = result.data.mission;
  box.append(
    el("div", { className: "card-head" }, el("h2", {}, m.title), el("span", { className: "tag" }, m.type_label)),
    el("p", {}, m.description),
    el("p", { className: "muted" }, `${m.aircraft} (${m.class_label}) · ${m.simulator_labels.join(", ")}`)
  );
  if (m.disaster) {
    box.append(el("p", {}, `${m.disaster.name}, ${m.disaster.type}, ${m.disaster.area || ""}. `,
      m.disaster.reportUrl ? el("button", { type: "button", className: "link-button", onclick: () => A.openInBrowser(m.disaster.reportUrl) }, "GDACS report") : null, " ",
      el("button", { type: "button", className: "link-button", onclick: () => A.openInBrowser(`${TRAILHEAD}/disasters`) }, "Disasters page")));
  }
  const rows = m.legs.map((leg) => el("tr", {},
    el("td", {}, String(leg.leg_number)), el("td", {}, place(leg.departure_place, leg.departure_code)), el("td", {}, place(leg.arrival_place, leg.arrival_code)),
    el("td", {}, `${number(leg.distance_nm)} nm`), el("td", {}, String(leg.passengers)),
    el("td", {}, leg.cargo.join("; ") || "—")));
  box.append(el("div", { className: "table-wrap" }, el("table", { className: "table" },
    el("thead", {}, el("tr", {}, ...["Leg", "From", "To", "Distance", "Passengers", "Cargo"].map((h) => el("th", {}, h)))), el("tbody", {}, rows))));
  const message = el("p", { className: "muted" });
  box.append(message);
  const actions = el("div", { className: "actions" });
  if (result.data.canTake) {
    const take = el("button", { type: "button", className: "button button-primary" }, "Take this mission");
    take.addEventListener("click", () => takeMission(m, message));
    actions.append(take);
  } else if (result.data.oneMissionMessage) {
    message.textContent = result.data.oneMissionMessage;
  }
  actions.append(close);
  box.append(actions);
  // Only scrolls when the details would be off screen, so the view stays where the pilot is
  box.scrollIntoView({ block: "nearest" });
}

async function takeMission(m, message) {
  const preview = await A.takePreview(m.id);
  if (!preview.ok) {
    message.textContent = preview.error;
    return;
  }
  const p = preview.data.preview;
  // Where the pilot will end up (ACR-6)
  const where = p.reposition
    ? `You're at ${p.currentAirport}. Taking this mission puts you on a deadhead to ${p.departureAirport} first. Deadheads don't count toward your totals.`
    : `You're at ${p.currentAirport}, right where this mission starts.`;
  if (!(await confirm(`${where} You'll have ${p.hoursAllowed} hours to fly it. Take this mission?`))) return;
  const result = await A.takeMission(m.id);
  if (!result.ok) {
    message.textContent = result.error;
    return;
  }
  const detail = $("missionList").querySelector(".mission-detail");
  if (detail) detail.remove();
  selectTab("home");
}

// ==========================================
// LOGBOOK AND REPORTS (ACR-7)
// ==========================================

async function loadLogbook(offset) {
  const result = await A.logbook({ limit: PAGE, offset });
  if (!result.ok) return;
  const d = result.data;
  state.logOffset = d.offset;
  const fact = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value));
  $("logTotals").replaceChildren(
    fact("Flights flown", number(d.totals.flights)),
    fact("Flight hours", minutes(d.totals.block_minutes)),
    fact("Distance", `${number(d.totals.distance_nm)} nm`),
    fact("Landings", number(d.totals.landings))
  );
  $("logRows").replaceChildren(...d.entries.map((e) => {
    const status = e.flight_type === "reposition" ? "Approved" : `${STATUS_LABELS[e.status] || "Approved"}${e.status === "pending" || e.status === "in_review" ? " · Not counted yet" : ""}`;
    return el("tr", {},
      el("td", {}, CairnTime.formatDateTime(e.completed_at)),
      el("td", {}, e.flight_type === "reposition" ? "Reposition (deadhead)" : "Mission flight"),
      el("td", {}, place(e.departure_place, e.departure_code)),
      el("td", {}, place(e.arrival_place, e.arrival_code)),
      el("td", {}, e.aircraft || "—"),
      el("td", {}, minutes(e.block_minutes)),
      el("td", {}, `${number(e.distance_nm)} nm`),
      el("td", {}, status),
      el("td", {}, e.has_report ? el("button", { type: "button", className: "link-button", onclick: () => A.openInBrowser(`${TRAILHEAD}/flights/${encodeURIComponent(e.id)}`) }, "View report") : "—"));
  }));
  $("logEmpty").hidden = d.totals.entries > 0;
  $("logPage").textContent = d.totals.entries ? `Page ${Math.floor(d.offset / PAGE) + 1} of ${Math.max(1, Math.ceil(d.totals.entries / PAGE))}` : "";
  $("logPrev").disabled = d.offset === 0;
  $("logNext").disabled = d.offset + PAGE >= d.totals.entries;
}
$("logPrev").addEventListener("click", () => loadLogbook(Math.max(0, state.logOffset - PAGE)));
$("logNext").addEventListener("click", () => loadLogbook(state.logOffset + PAGE));

// ==========================================
// SETTINGS (ACR-17)
// ==========================================

async function loadSettings() {
  const s = await A.settings();
  state.chime = s.chime;
  $("sChime").checked = s.chime;
  $("sStartup").checked = s.startWithWindows;
  $("sRemember").checked = s.rememberMe;
  const info = await A.appInfo();
  $("aboutVersion").textContent = `Cairn ACARS ${info.version}${info.commit ? ` · ${info.commit}` : ""}`;
  loadNotices();
  renderUpdate(info.update);
  renderSim(await A.simStatus());
}

$("sChime").addEventListener("change", async () => {
  const s = await A.saveSetting({ key: "chime", value: $("sChime").checked });
  state.chime = s.chime;
});
$("sStartup").addEventListener("change", () => A.saveSetting({ key: "startWithWindows", value: $("sStartup").checked }));
$("sRemember").addEventListener("change", () => A.setRememberMe($("sRemember").checked));
$("logoutButton").addEventListener("click", async () => {
  if (state.flight && !(await confirm("You're in the middle of a flight. Log out anyway? The flight keeps recording and sends when you log back in."))) return;
  applyAuth(await A.logout());
});
$("testSim").addEventListener("click", async () => renderSim(await A.testSim()));
$("checkUpdates").addEventListener("click", async () => renderUpdate(await A.checkForUpdates()));
$("openTrailhead").addEventListener("click", () => A.openInBrowser(TRAILHEAD));
$("openHelp").addEventListener("click", () => A.openInBrowser(`${TRAILHEAD}/acars`));
$("sendDiagnostics").addEventListener("click", async () => {
  $("sendDiagnostics").disabled = true;
  const result = await A.sendDiagnostics($("diagnosticsNote").value);
  $("sendDiagnostics").disabled = false;
  if (result.ok) $("diagnosticsNote").value = "";
  show("diagnosticsMessage", result.ok ? result.message : result.error, result.ok ? "success" : "error");
});

function renderUpdate(u) {
  const text = !u ? "" : {
    checking: "Checking for updates…",
    current: "You're on the newest version.",
    downloading: `Downloading version ${u.version}…`,
    ready: `Version ${u.version} is ready. It installs the next time you close ACARS${state.flight ? ", after your flight" : ""}.`,
    error: "We couldn't check for updates right now.",
    idle: "",
  }[u.status] || "";
  $("updateStatus").textContent = text;
  $("updateBar").textContent = u && u.status === "ready" ? text : "";
  $("updateBar").hidden = !(u && u.status === "ready");
}

// ==========================================
// THE SIMULATOR (ACR-8)
// ==========================================

function renderSim(st) {
  state.sim = st;
  const pill = $("simPill");
  const name = st.simulator === "msfs2024" ? "MSFS 2024" : "MSFS 2020";
  if (!st.connected) {
    pill.textContent = "MSFS not running";
    pill.className = "pill warn";
  } else if (!st.inFlight) {
    pill.textContent = "MSFS connected — no aircraft";
    pill.className = "pill warn";
  } else {
    pill.textContent = `${name} — ${(st.aircraft && st.aircraft.title) || "aircraft loaded"}`;
    pill.className = "pill ok";
  }
  $("simDetail").textContent = st.connected
    ? `Connected to ${name}.${st.missing && st.missing.length ? ` A few simulator values aren't available: ${st.missing.join(", ")}.` : ""}`
    : "MSFS isn't running. ACARS connects on its own when it starts, and tries again every 5 seconds.";
}

// ==========================================
// PRE-FLIGHT CHECKLIST (ACR-9)
// ==========================================

async function openChecklist(leg) {
  const result = await A.openChecklist(leg.id);
  if (!result.ok) {
    await notify(result.error);
    return;
  }
  $("checklistLeg").textContent = `Leg ${leg.leg_number}: ${leg.departure_code} to ${leg.arrival_code}`;
  show("checklistError", "");
  $("checklistPanel").hidden = false;
  renderChecks(result.checks);
}

function renderChecks(checks) {
  if (!checks || $("checklistPanel").hidden) return;
  $("checklistItems").replaceChildren(...checks.items.map((item) => {
    const cls = item.pass ? (item.key === "aircraft" ? "info" : "pass") : item.required ? "fail" : "advice";
    return el("li", { className: cls },
      el("span", { className: "dot", "aria-hidden": "true" }),
      el("span", {}, el("strong", {}, `${item.label}${item.pass ? "" : item.required ? "" : " (advice only)"}`), item.detail ? el("span", { className: "muted" }, ` — ${item.detail}`) : null));
  }));
  $("beginButton").disabled = !checks.ready;
}

$("checklistClose").addEventListener("click", async () => {
  $("checklistPanel").hidden = true;
  await A.closeChecklist();
});
$("beginButton").addEventListener("click", async () => {
  $("beginButton").disabled = true;
  const result = await A.beginFlight();
  if (!result.ok) {
    show("checklistError", result.error, "error");
    $("beginButton").disabled = false;
    return;
  }
  $("checklistPanel").hidden = true;
  applyFlight(result.flight);
});

// ==========================================
// THE FLIGHT SCREEN (ACR-10)
// ==========================================

async function refreshFlight() {
  applyFlight(await A.flightView());
}

function applyFlight(view) {
  const wasFlying = Boolean(state.flight);
  state.flight = view;
  $("flightTab").hidden = !view;
  if (!view) {
    if (wasFlying || state.tab === "flight") selectTab("home");
    return;
  }
  if (!wasFlying) {
    show("filedLine", "");
    selectTab("flight");
  }
  renderTimeline(view.phase, view.oooi);
  $("resumeBanner").hidden = !view.waitingToResume;
  $("fileButton").disabled = !view.canFile;
  $("statusFeed").replaceChildren(...view.feed.map(feedItem));
  renderFlightMission(view);
  if (!$("liveData").children.length) renderNow({});
  if (view.landing) renderLanding(view.landing);
}

/** What this flight is: the mission, the leg, the load and the time limit (ACR-10). */
function renderFlightMission(view) {
  const m = view.mission || {};
  const full = state.home && state.home.mission && state.home.mission.id === m.id ? state.home.mission : null;
  const leg = full ? full.legs.find((l) => l.id === view.leg.id) : null;
  const dep = view.leg.departure;
  const arr = view.leg.arrival;
  const load = leg
    ? `${leg.passengers} passenger${leg.passengers === 1 ? "" : "s"} · ${number(leg.cargo_lbs)} lbs cargo${(leg.cargo_items || []).length ? ` (${leg.cargo_items.map((c) => c.description).join(", ")})` : ""}`
    : `${view.leg.passengers || 0} passengers`;
  $("flightMission").replaceChildren(
    el("div", { className: "card-head" }, el("h2", {}, m.title || "Your flight"), el("span", { className: "tag" }, full ? full.type_label : m.type || "")),
    el("p", { className: "route" }, full && leg ? `Leg ${leg.leg_number} of ${full.legs.length}: ` : "", airport(dep.code), ` ${dep.name || ""} → `, airport(arr.code), ` ${arr.name || ""}`),
    el("p", { className: "muted" }, [m.aircraft, leg ? `${number(leg.distance_nm)} nm` : null, load, full ? `due ${CairnTime.formatDateTime(full.due_at)}` : null].filter(Boolean).join(" · "))
  );
}

function feedItem(item) {
  return el("li", { className: item.kind === "warning" ? "warning" : "" }, el("time", {}, CairnTime.formatTime(item.t)), el("span", {}, item.message));
}

function renderTimeline(phase, oooi) {
  const index = PHASES.findIndex(([key]) => key === phase);
  if (phase && !state.phaseTimes[phase]) state.phaseTimes[phase] = Date.now();
  $("phaseTimeline").replaceChildren(...PHASES.map(([key, label], i) => el("li", { className: key === phase ? "current" : i < index ? "done" : "" },
    label, state.phaseTimes[key] && i <= index ? el("time", {}, CairnTime.formatTime(state.phaseTimes[key])) : null)));
  if (phase === "go_around") $("phaseTimeline").append(el("li", { className: "current" }, "Go-around"));
  const fact = (label, meaning, t) => el("div", {}, el("dt", {}, label, el("small", {}, meaning)), el("dd", {}, t ? CairnTime.formatTime(t) : "—"));
  $("oooiTimes").replaceChildren(
    fact("Out", "First movement", oooi.out),
    fact("Off", "Wheels up", oooi.off),
    fact("On", "Touchdown", oooi.on),
    fact("In", "Parked", oooi.in)
  );
}

function renderLanding(l) {
  $("landingCard").hidden = false;
  const fact = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value));
  $("landingFacts").replaceChildren(
    fact("Touchdown rate", l.fpm === null ? "—" : `${number(l.fpm)} fpm`),
    fact("Peak G", number(l.g, 2)),
    fact("Past the threshold", l.distanceFt === undefined ? "—" : `${number(l.distanceFt)} ft`),
    fact("From the centerline", l.centerlineFt === undefined ? "—" : `${number(l.centerlineFt)} ft`),
    fact("Bounces", String(l.bounces || 0)),
    fact("Stable at the gate", l.stable === undefined ? "—" : l.stable ? "Looked stable" : "Didn't look stable")
  );
}

// ==========================================
// MESSAGES (their own tab)
// ==========================================

/** The unread count on the Messages tab and on Home. */
function setUnread(count) {
  state.unread = Number(count) || 0;
  $("messageBadge").textContent = String(state.unread);
  $("messageBadge").hidden = state.unread === 0;
}

async function loadMessages(offset) {
  const result = await A.messages({ box: state.msgBox, offset });
  const list = $("messageList");
  list.textContent = "";
  if (!result.ok) {
    list.append(el("li", { className: "muted" }, result.error));
    return;
  }
  const d = result.data;
  state.msgOffset = d.offset;
  state.msgTotal = d.total;
  setUnread(d.unread);
  if (!d.messages.length) {
    list.append(el("li", { className: "muted" }, {
      inbox: "No messages right now. Messages from staff and news about your flights show up here.",
      sent: "You haven't sent any messages yet.",
      archived: "Nothing archived.",
    }[state.msgBox]));
  }
  for (const m of d.messages) {
    list.append(el("li", {}, el("button", { type: "button", className: `row message-item${m.read ? "" : " unread"}`, onclick: () => openMessage(m.id) },
      el("span", { className: "meta" }, el("span", {}, m.from), el("span", {}, m.categoryLabel), el("span", {}, CairnTime.formatDateTime(m.sentAt)), m.read ? null : el("span", { className: "new" }, "New")),
      el("span", { className: "row-title" }, m.subject || m.body.split("\n")[0]),
      m.subject ? el("span", { className: "muted" }, m.body) : null)));
  }
  $("messagesPage").textContent = d.total ? `Page ${Math.floor(d.offset / d.limit) + 1} of ${Math.max(1, Math.ceil(d.total / d.limit))}` : "";
  $("messagesPrev").disabled = d.offset === 0;
  $("messagesNext").disabled = d.offset + d.limit >= d.total;
}

/** Where a message's button goes: always a Trailhead page in the browser. */
function messageLink(link) {
  if (!link || typeof link !== "object") return null;
  if (link.type === "diagnostics_deleted") return null;
  const id = String(link.id || "");
  if (link.type === "flight" && /^[a-z0-9]{9}$/.test(id)) return [`${TRAILHEAD}/flights/${id}`, "View flight report"];
  if (link.type === "board") return [`${TRAILHEAD}/missions${link.departure ? `?departure=${encodeURIComponent(link.departure)}` : ""}`, "See them on the board"];
  if (link.type === "disaster") return [`${TRAILHEAD}/disasters`, "Open Disasters"];
  if (link.type === "my_missions") return [`${TRAILHEAD}/my-missions`, "Open My missions"];
  if (link.type === "diagnostics" && /^\d+$/.test(id)) return [`${TRAILHEAD}/api/staff/diagnostics/${id}/file`, "Download diagnostics"];
  return null;
}

async function openMessage(id) {
  const result = await A.message(id);
  if (!result.ok) return notify(result.error);
  const d = result.data;
  state.openMessage = d.message;
  setUnread(d.unread);
  $("threadHeading").textContent = d.message.subject || d.message.categoryLabel;
  $("threadList").replaceChildren(...d.thread.map((m) => el("li", {},
    el("span", { className: "meta" }, `${m.from} · ${CairnTime.formatDateTime(m.sentAt)}`),
    el("p", { className: "body" }, m.body))));
  const link = messageLink(d.message.link);
  const deleted = d.message.link && d.message.link.type === "diagnostics_deleted" ? el("p", { className: "muted" }, d.message.link.text) : null;
  $("threadLink").replaceChildren(...(link ? [el("button", { type: "button", className: "button button-secondary", onclick: () => A.openInBrowser(link[0]) }, link[1])] : deleted ? [deleted] : []));
  $("replyForm").hidden = !d.message.canReply;
  $("replyBody").value = "";
  show("replyError", "");
  $("archiveButton").textContent = d.message.archived ? "Move to inbox" : "Archive";
  $("archiveButton").hidden = state.msgBox === "sent";
  $("threadPanel").hidden = false;
  loadMessages(state.msgOffset);
}

for (const button of document.querySelectorAll(".box")) {
  button.addEventListener("click", () => {
    state.msgBox = button.dataset.box;
    for (const b of document.querySelectorAll(".box")) b.setAttribute("aria-selected", String(b === button));
    loadMessages(0);
  });
}
$("messagesPrev").addEventListener("click", () => loadMessages(Math.max(0, state.msgOffset - PAGE)));
$("messagesNext").addEventListener("click", () => loadMessages(state.msgOffset + PAGE));
$("threadClose").addEventListener("click", () => {
  $("threadPanel").hidden = true;
  state.openMessage = null;
});
$("archiveButton").addEventListener("click", async () => {
  if (!state.openMessage) return;
  const result = await A.archive({ id: state.openMessage.id, archived: !state.openMessage.archived });
  if (!result.ok) return show("replyError", result.error, "error");
  $("threadPanel").hidden = true;
  state.openMessage = null;
  loadMessages(state.msgOffset);
});
$("replyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.openMessage) return;
  const result = await A.reply({ id: state.openMessage.id, body: $("replyBody").value });
  if (!result.ok) return show("replyError", result.error, "error");
  show("messagesNotice", result.data.message, "success");
  openMessage(state.openMessage.id);
});
$("newMessage").addEventListener("click", async () => {
  const result = await A.recipients();
  if (!result.ok) return notify(result.error);
  $("composeTo").replaceChildren(...result.data.recipients.map((r) => el("option", { value: r.id }, r.label)));
  $("composeSubject").value = "";
  $("composeBody").value = "";
  show("composeError", "");
  $("composePanel").hidden = false;
});
$("composeClose").addEventListener("click", () => { $("composePanel").hidden = true; });
$("composeSend").addEventListener("click", async () => {
  $("composeSend").disabled = true;
  const result = await A.sendMessage({ to: $("composeTo").value, subject: $("composeSubject").value, body: $("composeBody").value });
  $("composeSend").disabled = false;
  if (!result.ok) return show("composeError", result.error, "error");
  $("composePanel").hidden = true;
  show("messagesNotice", result.data.message, "success");
  loadMessages(0);
});

// ==========================================
// NOTICES (flows/messages.md MSG-2): the same setting as the Trailhead profile
// ==========================================

async function loadNotices() {
  const result = await A.notices();
  if (!result.ok) return;
  const d = result.data;
  $("alwaysOnLine").textContent = d.alwaysOnLine;
  const option = (item, alwaysOn) => el("label", { className: "check notice-option" },
    el("input", { type: "checkbox", value: item.category, checked: alwaysOn || item.on, disabled: alwaysOn }), ` ${item.label}`);
  $("alwaysOnList").replaceChildren(...d.alwaysOn.map((item) => option(item, true)));
  $("optionalList").replaceChildren(...d.optional.map((item) => option(item, false)));
}

$("saveNotices").addEventListener("click", async () => {
  const subscriptions = {};
  for (const input of $("optionalList").querySelectorAll("input[type=checkbox]")) subscriptions[input.value] = input.checked;
  const result = await A.saveNotices(subscriptions);
  show("noticesMessage", result.ok ? result.data.message : result.error, result.ok ? "success" : "error");
});

// ==========================================
// VERSION AND WHAT CHANGED (flows/versions.md VER-1, VER-3)
// ==========================================

async function showVersion() {
  const info = await A.appInfo();
  $("versionText").textContent = `Cairn ACARS ${info.version}${info.commit ? " ·" : " · development"}`;
  $("versionCommit").textContent = info.commit || "";
  $("versionCommit").hidden = !info.commit;
}

$("versionCommit").addEventListener("click", async () => {
  const result = await A.changes();
  $("changesIntro").textContent = result.commit ? `You're on Cairn ACARS ${result.version}, commit ${result.commit}.` : `You're on Cairn ACARS ${result.version}.`;
  $("changesList").replaceChildren(...(result.entries.length
    ? result.entries.map((e) => el("li", {}, el("h3", {}, CairnTime.formatDateOnly(e.date)), el("ul", {}, e.notes.map((n) => el("li", {}, n)))))
    : [el("li", { className: "muted" }, "No notes yet.")]));
  $("changesPanel").hidden = false;
});
$("changesClose").addEventListener("click", () => { $("changesPanel").hidden = true; });

/** A few numbers only, in fixed-size boxes (styles.css .now), updated in place. */
function renderNow(live) {
  const known = (v) => v !== null && v !== undefined;
  const values = [
    ["To go", known(live.distanceNm) ? `${number(live.distanceNm, 0)} nm` : "—"],
    ["ETE", known(live.eteMinutes) ? minutes(live.eteMinutes) : "—"],
    ["Ground speed", known(live.gs) ? `${number(live.gs)} kt` : "—"],
    ["Fuel on board", known(live.fuelLbs) ? `${number(live.fuelLbs)} lbs` : "—"],
  ];
  const box = $("liveData");
  if (box.children.length !== values.length) {
    box.replaceChildren(...values.map(([label]) => el("div", {}, el("dt", {}, label), el("dd", {}, "—"))));
  }
  values.forEach(([, value], i) => {
    box.children[i].querySelector("dd").textContent = value;
  });
}

A.on("live", (live) => {
  renderNow(live);
  if (state.flight && live.phase !== state.flight.phase) {
    state.flight.phase = live.phase;
    state.flight.oooi = live.oooi;
    renderTimeline(live.phase, live.oooi);
  }
  $("fileButton").disabled = live.phase !== "engines_off";
  const waiting = live.waitingToSend;
  $("outboxStatus").hidden = !waiting || waiting < 2;
  $("outboxStatus").textContent = `Offline — ${waiting} reports waiting to send`;
});
A.on("feed", (item) => {
  $("statusFeed").prepend(feedItem(item));
});
A.on("landing", renderLanding);
A.on("warning", (message) => show("flightWarning", message, "warning"));
A.on("flight", (view) => applyFlight(view));
A.on("checks", renderChecks);
A.on("sim", renderSim);
A.on("briefing", (b) => {
  if (!b.notes || !b.notes.length) return;
  show("briefing", b.notes.map((n) => n.text).join(" "), "info");
});
A.on("crashed", async (message) => {
  applyFlight(null);
  await notify(message);
});
A.on("update", renderUpdate);
A.on("connection", ({ online, lastSyncAt }) => {
  $("offlineBar").hidden = online;
  $("offlineBar").textContent = `Offline — showing what we had at ${lastSyncAt ? CairnTime.formatTime(lastSyncAt) : "the last check"}`;
});
A.on("outbox", ({ waiting }) => {
  $("outboxStatus").hidden = waiting < 2;
  $("outboxStatus").textContent = `Offline — ${waiting} reports waiting to send`;
});
A.on("sync", ({ changed }) => {
  if (changed.includes("notices") || changed.includes("messages") || changed.includes("mission") || changed.includes("airport")) loadHome();
  if (changed.includes("logbook") && state.tab === "logbook") loadLogbook(state.logOffset);
});
A.on("auth", (auth) => applyAuth(auth));

$("cancelFlightButton").addEventListener("click", async () => {
  const dep = state.flight && state.flight.leg.departure.code;
  if (!(await confirm(`Cancel this flight? It won't be logged, and you'll stay at ${dep}. The leg stays on your mission so you can fly it again.`))) return;
  const result = await A.cancelFlight();
  applyFlight(null);
  if (result.message) await notify(result.message);
  loadHome();
});

// ==========================================
// FILING (ACR-16)
// ==========================================

$("fileButton").addEventListener("click", async () => {
  const check = await A.arrivalCheck();
  const s = check.summary;
  const fact = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value));
  $("fileSummary").replaceChildren(
    fact("Route", s.route), fact("Block time", minutes(s.blockMinutes)), fact("Fuel used", s.fuelUsedLbs === null ? "—" : `${number(s.fuelUsedLbs)} lbs`),
    fact("Touchdown", s.landing && s.landing.fpm !== null ? `${number(s.landing.fpm)} fpm` : "—")
  );
  askReason(check.kind !== "planned" ? check.question : null);
  show("fileError", "");
  $("filePanel").hidden = false;
});

function askReason(question) {
  $("diversionForm").hidden = !question;
  state.diversionPick = null;
  if (!question) return;
  $("diversionQuestion").textContent = question;
  $("diversionPicks").replaceChildren(...DIVERSION_PICKS.map(([code, label]) => {
    const b = el("button", { type: "button", className: "button button-secondary", "aria-pressed": "false" }, label);
    b.addEventListener("click", () => {
      state.diversionPick = code;
      for (const other of $("diversionPicks").children) other.setAttribute("aria-pressed", String(other === b));
    });
    return b;
  }));
  $("diversionText").value = "";
}

$("fileClose").addEventListener("click", () => { $("filePanel").hidden = true; });
$("sendReport").addEventListener("click", async () => {
  let diversion = null;
  if (!$("diversionForm").hidden) {
    const text = $("diversionText").value.trim();
    if (!state.diversionPick) return show("fileError", "Pick what happened.", "error");
    if (text.length < 10) return show("fileError", "Tell us a little more: at least 10 characters.", "error");
    diversion = { code: state.diversionPick, text };
  }
  $("sendReport").disabled = true;
  const result = await A.fileReport(diversion);
  $("sendReport").disabled = false;
  if (result.needsReason) {
    askReason(result.question);
    return show("fileError", "Tell us what happened before you send the report.", "error");
  }
  if (!result.ok) return show("fileError", result.message, "error");
  $("filePanel").hidden = true;
  state.phaseTimes = {};
  applyFlight(null);
  show("filedLine", result.message, "success");
  loadHome();
});

document.addEventListener("DOMContentLoaded", () => {
  showVersion();
  startUp();
});
