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
  $("pilotName").textContent = `${p.firstName} ${p.lastName} · ${p.employeeId}`;
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
  if (tab === "messages") {
    renderMessages();
    markMessagesRead();
  }
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

  // Messages (Trailhead notices) live on their own tab. A new one plays the chime, and
  // Home only says there are new ones.
  let fresh = false;
  for (const n of h.notices) {
    if (!state.seenNotices.has(n.id)) {
      if (state.seenNotices.size) fresh = true;
      state.seenNotices.add(n.id);
    }
  }
  if (fresh) chime();
  renderMessages();
  if (state.tab === "messages") markMessagesRead();
  const unread = unreadMessages().length;
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
        el("td", {}, airport(leg.departure_code)),
        el("td", {}, airport(leg.arrival_code)),
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
  for (const mission of h.missionsHere) list.append(missionRow(mission));

  const notes = h.foqaNotes || [];
  $("foqaNotesCard").hidden = notes.length === 0;
  $("foqaNotes").replaceChildren(...notes.map((n) => el("li", { className: "row" }, n.text)));
}

function missionRow(m) {
  return el("li", { className: "row" },
    el("span", { className: "row-title" }, el("button", { type: "button", className: "link-button", onclick: () => openMission(m.id) }, m.title), " ", el("span", { className: "tag" }, m.type_label || m.mission_type)),
    el("span", { className: "muted" }, route(m.route), ` · ${m.aircraft} · ${number(m.distance)} nm · ${m.legs} leg${m.legs === 1 ? "" : "s"} · ${m.passengers} passengers · ${number(m.cargo_lbs)} lbs`)
  );
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
  for (const m of result.data.missions) list.append(missionRow({ ...m, type_label: state.options.types[m.mission_type] }));
  const total = result.data.total;
  $("missionsPage").textContent = total ? `Page ${Math.floor(state.missionsOffset / PAGE) + 1} of ${Math.max(1, Math.ceil(total / PAGE))}` : "";
  $("missionsPrev").disabled = state.missionsOffset === 0;
  $("missionsNext").disabled = state.missionsOffset + PAGE >= total;
}

$("missionFilters").addEventListener("submit", (e) => {
  e.preventDefault();
  loadMissions(0);
});
$("missionsPrev").addEventListener("click", () => loadMissions(Math.max(0, state.missionsOffset - PAGE)));
$("missionsNext").addEventListener("click", () => loadMissions(state.missionsOffset + PAGE));

async function openMission(id) {
  if (state.tab !== "missions") selectTab("missions");
  const result = await A.mission(id);
  const box = $("missionDetail");
  box.hidden = false;
  box.textContent = "";
  if (!result.ok) {
    box.append(el("p", {}, result.error));
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
    el("td", {}, String(leg.leg_number)), el("td", {}, airport(leg.departure_code)), el("td", {}, airport(leg.arrival_code)),
    el("td", {}, `${number(leg.distance_nm)} nm`), el("td", {}, String(leg.passengers)),
    el("td", {}, leg.cargo.join("; ") || "—")));
  box.append(el("div", { className: "table-wrap" }, el("table", { className: "table" },
    el("thead", {}, el("tr", {}, ...["Leg", "From", "To", "Distance", "Passengers", "Cargo"].map((h) => el("th", {}, h)))), el("tbody", {}, rows))));
  const message = el("p", { className: "muted" });
  box.append(message);
  if (result.data.canTake) {
    const take = el("button", { type: "button", className: "button button-primary" }, "Take this mission");
    take.addEventListener("click", () => takeMission(m, message));
    box.append(el("div", { className: "actions" }, take));
  } else if (result.data.oneMissionMessage) {
    message.textContent = result.data.oneMissionMessage;
  }
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
  $("missionDetail").hidden = true;
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
      el("td", {}, route([e.departure_code, e.arrival_code])),
      el("td", {}, e.aircraft || "—"),
      el("td", {}, minutes(e.block_minutes)),
      el("td", {}, `${number(e.distance_nm)} nm`),
      el("td", {}, status, " ", e.has_report ? el("button", { type: "button", className: "link-button", onclick: () => openReport(e.id) }, "Open") : null));
  }));
  $("logEmpty").hidden = d.totals.entries > 0;
  $("logPage").textContent = d.totals.entries ? `Page ${Math.floor(d.offset / PAGE) + 1} of ${Math.max(1, Math.ceil(d.totals.entries / PAGE))}` : "";
  $("logPrev").disabled = d.offset === 0;
  $("logNext").disabled = d.offset + PAGE >= d.totals.entries;
}
$("logPrev").addEventListener("click", () => loadLogbook(Math.max(0, state.logOffset - PAGE)));
$("logNext").addEventListener("click", () => loadLogbook(state.logOffset + PAGE));

/** The full flight report, with everything the website's report page shows (FR-6). */
async function openReport(id) {
  const result = await A.report(id);
  const box = $("reportView");
  box.hidden = false;
  box.textContent = "";
  if (!result.ok) {
    box.append(el("p", {}, result.error));
    return;
  }
  const r = result.data.report;
  const fact = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value === null || value === undefined ? "—" : value));
  // Each part of the report is its own section, with a clear break between them
  const section = (title, ...children) => el("section", { className: "report-section" }, el("h3", {}, title), ...children);
  const oooi = (label, meaning, value) => el("div", {}, el("dt", {}, label, el("small", {}, meaning)), el("dd", {}, CairnTime.formatTime(value)));
  box.append(
    el("div", { className: "card-head" }, el("h2", {}, r.mission.title || "Flight report"), el("span", { className: "tag" }, r.statusLabel || r.status)),
    el("p", { className: "route" }, route([r.route.departure.code, r.route.arrival.code])),
    r.diversion ? el("p", {}, r.diversion.text, r.diversion.reason ? ` ${r.diversion.reason}: ${r.diversion.explanation || ""}` : "") : null,
    r.aircraft.note ? el("p", { className: "muted" }, r.aircraft.note) : null,
    section("Summary", el("dl", { className: "facts" },
      fact("Date", CairnTime.formatDateTime(r.date)), fact("Aircraft", r.aircraft.flown), fact("Block time", minutes(r.times.blockMinutes)),
      fact("Air time", minutes(r.times.airMinutes)), fact("Distance", `${number(r.distanceNm)} nm`), fact("Fuel used", r.fuel.usedLbs === null ? null : `${number(r.fuel.usedLbs)} lbs`))),
    section("Out, Off, On, In", el("dl", { className: "oooi" },
      oooi("Out", "First movement", r.times.out), oooi("Off", "Wheels up", r.times.off), oooi("On", "Touchdown", r.times.on), oooi("In", "Parked", r.times.in)))
  );
  if (r.review.reasons.length || r.review.noteToPilot) {
    box.append(section("Review", ...r.review.reasons.map((x) => el("p", {}, x)),
      r.review.noteToPilot ? el("p", { className: "message message-info" }, `Note from the reviewer: ${r.review.noteToPilot}`) : null));
  }
  const track = el("div", { className: "chart" });
  box.append(section("Track", track));
  FlightCharts.track(track, r.track, [
    { code: r.route.departure.code, lat: r.route.departure.lat, lon: r.route.departure.lon },
    { code: r.route.arrival.code, lat: r.route.arrival.lat, lon: r.route.arrival.lon },
  ]);
  // Altitude and speed for the whole flight (same charts as the website)
  const altitudeFlight = el("div", { className: "chart" });
  const speedFlight = el("div", { className: "chart" });
  box.append(section("Altitude", altitudeFlight), section("Speed", speedFlight));
  FlightCharts.flight({ altitude: altitudeFlight, speed: speedFlight }, r.charts && r.charts.flight);
  if (r.timeline && r.timeline.length) {
    box.append(section("Flight events", el("ol", { className: "feed" }, r.timeline.map((t) => el("li", {}, el("time", {}, CairnTime.formatTime(t.at)), t.message || t.phase || t.type)))));
  }
  const m = r.foqa && r.foqa.metrics;
  if (r.analysis && r.analysis.status === "pending") {
    box.append(section("Approach and landing", el("p", { className: "muted" }, "Your final numbers, the approach charts and the runway drawing come with the hourly check, at the top of the hour.")));
  } else if (m) {
    box.append(section("Approach and landing", el("dl", { className: "facts" },
      fact("Touchdown rate", m.touchdown_fpm === null ? null : `${number(m.touchdown_fpm)} fpm`), fact("Peak G", number(m.touchdown_g, 2)),
      fact("Past the threshold", m.touchdown_distance_ft === null ? null : `${number(m.touchdown_distance_ft)} ft`), fact("From the centerline", m.centerline_offset_ft === null ? null : `${number(m.centerline_offset_ft)} ft`),
      fact("Bounces", number(m.bounces)), fact("Stable at the gate", m.stable_at_gate === null ? null : m.stable_at_gate ? "Yes" : "No"))));
    const profile = r.charts.profile;
    const runway = el("div", { className: "chart" });
    const alt = el("div", { className: "chart" });
    const vs = el("div", { className: "chart" });
    const ias = el("div", { className: "chart" });
    box.append(section("Runway", runway), section("Height above the field", alt), section("Vertical speed", vs), section("Airspeed", ias));
    FlightCharts.runway(runway, profile && profile.runway);
    FlightCharts.approach({ altitude: alt, verticalSpeed: vs, airspeed: ias }, profile);
  }
  if (r.foqa && r.foqa.events && r.foqa.events.length) {
    box.append(section("FOQA", el("ul", { className: "rows" }, r.foqa.events.map((e) =>
      el("li", { className: "row" }, el("span", { className: "row-title" }, `${e.name || e.code} · ${e.kind === "good_call" ? "Good call" : e.level ? `Level ${e.level}` : "Habit"}`), e.advice ? el("span", { className: "muted" }, e.advice) : null)))));
  }
  if (r.integrity && r.integrity.length) box.append(section("Integrity notes", ...r.integrity.map((t) => el("p", {}, t))));
  box.append(el("div", { className: "actions" }, el("button", { type: "button", className: "button button-secondary", onclick: () => A.openInBrowser(`${TRAILHEAD}/flights/${r.id}`) }, "Open on the website")));
  box.scrollIntoView({ behavior: "smooth" });
}

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
  $("aboutVersion").textContent = `Cairn ACARS ${info.version}`;
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
  const result = await A.sendDiagnostics();
  $("sendDiagnostics").disabled = false;
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
  if (!wasFlying) selectTab("flight");
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

// Which messages have been seen on this PC: a convenience only, so it's fine if it's lost
function readIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("readMessages") || "[]"));
  } catch {
    return new Set();
  }
}

function unreadMessages() {
  const read = readIds();
  return ((state.home && state.home.notices) || []).filter((n) => !read.has(n.id));
}

function markMessagesRead() {
  const ids = ((state.home && state.home.notices) || []).map((n) => n.id);
  try {
    localStorage.setItem("readMessages", JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
  updateBadge();
}

function updateBadge() {
  const count = unreadMessages().length;
  $("messageBadge").textContent = String(count);
  $("messageBadge").hidden = count === 0;
}

function renderMessages() {
  const notices = (state.home && state.home.notices) || [];
  const read = readIds();
  $("messageList").replaceChildren(...(notices.length
    ? notices.map((n) => {
        const dismiss = el("button", { type: "button", className: "button button-secondary" }, "Dismiss");
        const item = el("li", { className: "row notice" },
          el("span", {}, el("strong", {}, CairnTime.formatDateTime(n.created_at)), read.has(n.id) ? "" : " · New", el("br"), n.message),
          dismiss);
        dismiss.addEventListener("click", async () => {
          dismiss.disabled = true;
          await A.dismissNotice(n.id);
          state.home.notices = state.home.notices.filter((x) => x.id !== n.id);
          item.remove();
          updateBadge();
        });
        return item;
      })
    : [el("li", { className: "muted" }, "No messages.")]));
  updateBadge();
}

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
  if (changed.includes("notices") || changed.includes("mission") || changed.includes("airport")) loadHome();
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
  await notify(result.message);
  loadHome();
});

document.addEventListener("DOMContentLoaded", startUp);
