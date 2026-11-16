// A whole ACARS flight with a fake simulator and a fake Trailhead (flows/acars.md ACR-9 to
// ACR-16, SRV-8): starting, reports, the outbox when the internet drops, pause, disconnect
// and resume, restarting ACARS mid-flight, cancelling, crashing and filing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { buildFlight } = require("./helpers/synthetic-flight");
const { createFlightManager, decideArrival } = require("../src/main/flight/flight-manager");
const { createOutbox } = require("../src/main/flight/outbox");
const { createRecorder } = require("../src/main/flight/recorder");
const { outboxResult } = require("../src/main/api");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-acars-test-"));
}

/** A fake Trailhead that records what ACARS sent. online can be switched off. */
function fakeServer(flight) {
  const server = { online: true, positions: [], events: [], submits: [], cancels: [], uploads: [], starts: [], submitAnswer: null };
  const answer = (data) => (server.online ? { ok: true, status: 200, data: { success: true, ...data } } : { ok: false, status: 0, error: "You're offline. ACARS will keep trying.", data: {} });
  server.api = {
    startFlight: async (body) => {
      server.starts.push(body);
      return answer({ flight: { id: 77, startedAt: new Date(flight.samples[0].t).toISOString() } });
    },
    postPositions: async (id, body) => {
      if (!server.online) return answer();
      server.positions.push(...body.reports);
      server.events.push(...body.events);
      return answer({ accepted: {} });
    },
    submit: async (id, body) => {
      if (!server.online) return answer();
      server.submits.push(body);
      if (server.submitAnswer) return server.submitAnswer(body);
      return answer({ flightLogId: 900, status: body.crashed ? "denied" : "pending", arrival: { code: "ARR", name: "Arrival Field" } });
    },
    cancel: async (id) => {
      server.cancels.push(id);
      return answer();
    },
    uploadData: async (id, buffer) => {
      server.uploads.push(buffer);
      return answer();
    },
    nearestAirports: async () => answer({ airports: [{ code: "ARR", name: "Arrival Field", type: "medium_airport", lat: flight.arrival.lat, lon: flight.arrival.lon, distanceNm: 0.5 }] }),
  };
  return server;
}

function setUp(flightOptions = {}, dir = tempDir()) {
  const flight = buildFlight({ group: "light", ...flightOptions });
  const server = fakeServer(flight);
  const send = async (item) => {
    if (item.kind === "positions") return outboxResult(await server.api.postPositions(item.flightId, item));
    if (item.kind === "cancel") return outboxResult(await server.api.cancel(item.flightId));
    if (item.kind === "submit") return outboxResult(await server.api.submit(item.flightId, item.body));
    if (item.kind === "data") return outboxResult(await server.api.uploadData(item.flightId, fs.readFileSync(path.join(dir, "flights", `${item.flightId}.jsonl.gz`))));
    return "drop";
  };
  const outbox = createOutbox(dir, send);
  const manager = createFlightManager({ dataDir: dir, api: server.api, outbox, flushOutbox: () => outbox.flush(), version: "1.0.0" });
  return { flight, server, outbox, manager, dir };
}

const LEG = (flight) => ({
  id: 5,
  passengers: 2,
  departure: { code: "DEP", name: "Departure Field", ...flight.departure, type: "medium_airport" },
  arrival: { code: "ARR", name: "Arrival Field", ...flight.arrival, type: "medium_airport" },
});

async function begin(ctx) {
  const result = await ctx.manager.begin({
    leg: LEG(ctx.flight),
    mission: { id: 3, title: "Test mission", mission_type: "cargo", aircraft: "Cessna 172", aircraft_class: "light_single" },
    simulator: "msfs2024",
    sample: ctx.flight.samples[0],
    aircraft: { title: "Cessna 172", designator: "C172" },
    checks: { parkingBrake: { pass: true } },
    runways: { departure: [], arrival: [ctx.flight.runwayEnd] },
    intervals: { parked_s: 120, moving_s: 60 },
  });
  assert.equal(result.ok, true);
}

async function flyAll(ctx, samples = ctx.flight.samples) {
  for (const s of samples) ctx.manager.onSample(s, "second");
  await ctx.outbox.flush();
}

test("a whole flight: started, reported about once a minute, phases sent as events, then filed (ACR-9, ACR-12, ACR-16)", async () => {
  const ctx = setUp();
  await begin(ctx);
  assert.equal(ctx.server.starts[0].missionLegId, 5);
  await flyAll(ctx);
  const minutesLong = (ctx.flight.samples.at(-1).t - ctx.flight.samples[0].t) / 60000;
  assert.ok(ctx.server.positions.length > minutesLong * 0.9, `${ctx.server.positions.length} reports`);
  assert.deepEqual(ctx.server.positions.map((p) => p.seq), ctx.server.positions.map((_, i) => i)); // in order, no gaps
  const phases = ctx.server.events.filter((e) => e.type === "phase").map((e) => e.phase);
  assert.deepEqual(phases.slice(0, 3), ["preflight", "engine_start", "taxi_out"]);
  assert.equal(ctx.manager.view().canFile, true);

  const arrival = await ctx.manager.arrivalCheck();
  assert.equal(arrival.kind, "planned");
  const filed = await ctx.manager.file(null);
  assert.equal(filed.ok, true);
  assert.equal(filed.message, "Report sent. You're now at ARR. It's checked automatically at the top of the hour.");
  const body = ctx.server.submits[0];
  assert.ok(body.oooi.out && body.oooi.off && body.oooi.on && body.oooi.in);
  assert.equal(body.landing.fpm, 150);
  assert.ok(body.flownDistanceNm > 55 && body.flownDistanceNm < 70);
  // The flight data file went up after the report, and it's readable gzip
  await ctx.outbox.flush();
  const text = zlib.gunzipSync(ctx.server.uploads[0]).toString("utf8").trim().split("\n");
  assert.equal(JSON.parse(text[0]).type, "header");
  assert.ok(text.length > ctx.flight.samples.length);
  assert.equal(ctx.manager.active, false);
});

test("File flight report waits for Engines off (ACR-16)", async () => {
  const ctx = setUp();
  await begin(ctx);
  await flyAll(ctx, ctx.flight.samples.slice(0, 500));
  const result = await ctx.manager.file(null);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Shut down the engines first, then file.");
});

test("when the internet drops, reports wait in order and go out when it's back (ACR-12)", async () => {
  const ctx = setUp();
  await begin(ctx);
  const half = Math.floor(ctx.flight.samples.length / 2);
  await flyAll(ctx, ctx.flight.samples.slice(0, 200));
  ctx.server.online = false;
  await flyAll(ctx, ctx.flight.samples.slice(200, half));
  const waiting = ctx.outbox.size;
  assert.ok(waiting > 5);
  ctx.server.online = true;
  await flyAll(ctx, ctx.flight.samples.slice(half));
  assert.equal(ctx.outbox.size, 0);
  assert.deepEqual(ctx.server.positions.map((p) => p.seq), ctx.server.positions.map((_, i) => i));
});

test("the outbox survives an ACARS or Windows restart (ACR-12)", async () => {
  const dir = tempDir();
  const sent = [];
  const first = createOutbox(dir, async () => "retry");
  first.addPositions(1, [{ seq: 0, sample: { t: 1 } }], []);
  first.add({ kind: "data", flightId: 1 });
  assert.equal(await first.flush(), "retry");
  const second = createOutbox(dir, async (item) => {
    sent.push(item.kind);
    return "sent";
  });
  assert.equal(await second.flush(), "empty");
  assert.deepEqual(sent, ["positions", "data"]);
});

test("reports added while a batch is on its way are never lost (ACR-12)", async () => {
  const dir = tempDir();
  const received = [];
  let release;
  const box = createOutbox(dir, async (item) => {
    received.push(...item.reports.map((r) => r.seq));
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return "sent";
  });
  box.addPositions(1, [{ seq: 0, sample: { t: 0 } }], []);
  const flushing = box.flush();
  while (!release) await new Promise((resolve) => setImmediate(resolve)); // the first batch is on its way
  box.addPositions(1, [{ seq: 1, sample: { t: 1 } }], []);
  box.addPositions(1, [{ seq: 2, sample: { t: 2 } }], []);
  release();
  await flushing;
  await box.flush();
  assert.deepEqual(received, [0, 1, 2]);
});

test("a 401 stops the outbox until the pilot logs in again; nothing is lost (ACR-3)", async () => {
  const dir = tempDir();
  const box = createOutbox(dir, async () => "auth");
  box.addPositions(1, [{ seq: 0, sample: { t: 1 } }], []);
  assert.equal(await box.flush(), "auth");
  assert.equal(box.size, 1);
});

test("the server's answers map to the outbox: 5xx and offline retry, 401 waits, other refusals drop (ACR-12)", () => {
  assert.equal(outboxResult({ ok: true, status: 200 }), "sent");
  assert.equal(outboxResult({ ok: false, status: 0 }), "retry");
  assert.equal(outboxResult({ ok: false, status: 503 }), "retry");
  assert.equal(outboxResult({ ok: false, status: 401 }), "auth");
  assert.equal(outboxResult({ ok: false, status: 409 }), "drop");
});

test("a diversion asks what happened before sending; the server's answer is used too (ACR-16)", async () => {
  const ctx = setUp();
  await begin(ctx);
  await flyAll(ctx);
  ctx.server.api.nearestAirports = async () => ({ ok: true, status: 200, data: { airports: [{ code: "DIV", name: "Diversion Strip", type: "small_airport", distanceNm: 0.3 }] } });
  const leg = LEG(ctx.flight);
  const far = { ...leg.arrival, distanceNm: 40 };
  assert.equal(decideArrival(far, [{ code: "DIV", type: "small_airport", distanceNm: 0.3 }]).kind, "diversion");
  ctx.server.submitAnswer = (body) => body.diversion
    ? { ok: true, status: 200, data: { success: true, flightLogId: 901, arrival: { code: "DIV" } } }
    : { ok: false, status: 409, error: "Tell us what happened before you send the report.", data: { success: false, code: "reason_needed", arrival: { code: "DIV", name: "Diversion Strip", offAirport: false } } };
  const first = await ctx.manager.file(null);
  assert.equal(first.needsReason, true);
  assert.equal(first.question, "You're at DIV (Diversion Strip), not ARR. What happened?");
  const second = await ctx.manager.file({ code: "weather", text: "Fog at the destination" });
  assert.equal(second.ok, true);
  assert.equal(second.arrival, "DIV");
});

test("not at any airport asks the off-airport question (ACR-16)", () => {
  const result = decideArrival({ code: "ARR", type: "small_airport", distanceNm: 40 }, [{ code: "FAR", type: "small_airport", distanceNm: 12 }]);
  assert.deepEqual([result.kind, result.airport.code], ["off_airport", "FAR"]);
});

test("a crash files itself as a crash on the spot, even offline (ACR-16)", async () => {
  const ctx = setUp();
  await begin(ctx);
  let crashMessage = null;
  ctx.manager.events.on("crashed", (m) => {
    crashMessage = m;
  });
  const touchdown = ctx.flight.samples.findIndex((s) => typeof s.tdV === "number");
  ctx.server.online = false;
  await flyAll(ctx, ctx.flight.samples.slice(0, touchdown));
  ctx.manager.onSample({ ...ctx.flight.samples[touchdown], crash: 1 }, "second");
  assert.equal(crashMessage, "Looks like that one ended in a crash. The flight isn't credited and you're still at DEP. The leg's still on your mission whenever you want to try again.");
  assert.equal(ctx.manager.active, false);
  ctx.server.online = true;
  await ctx.outbox.flush();
  assert.equal(ctx.server.submits[0].crashed, true);
  assert.equal(ctx.server.uploads.length, 1);
});

test("cancelling tells the server, keeps the pilot where they are, and ends the flight (ACR-14)", async () => {
  const ctx = setUp();
  await begin(ctx);
  await flyAll(ctx, ctx.flight.samples.slice(0, 100));
  const result = await ctx.manager.cancel();
  await ctx.outbox.flush();
  assert.equal(result.message, "Flight cancelled. You're still at DEP.");
  assert.deepEqual(ctx.server.cancels, [77]);
  assert.equal(ctx.manager.active, false);
});

test("losing MSFS keeps the flight; it resumes when the aircraft is back where it was (ACR-14)", async () => {
  const ctx = setUp();
  await begin(ctx);
  ctx.manager.onSimConnection(true);
  const cut = 1500;
  await flyAll(ctx, ctx.flight.samples.slice(0, cut));
  ctx.manager.onSimConnection(false);
  assert.equal(ctx.manager.view().waitingToResume, true);
  // A sample far from the last position doesn't resume the flight
  ctx.manager.onSample({ ...ctx.flight.samples[cut], lat: ctx.flight.samples[cut].lat + 1 }, "second");
  assert.equal(ctx.manager.view().waitingToResume, true);
  ctx.manager.onSimConnection(true);
  const later = { ...ctx.flight.samples[cut], t: ctx.flight.samples[cut].t + 600000 };
  ctx.manager.onSample(later, "second");
  assert.equal(ctx.manager.view().waitingToResume, false);
  await ctx.outbox.flush();
  const resume = ctx.server.events.find((e) => e.type === "resume");
  assert.equal(resume.message, "Resumed after a simulator disconnect (10 min).");
});

test("after ACARS restarts mid-flight, the saved flight is picked back up (ACR-14)", async () => {
  const dir = tempDir();
  const first = setUp({}, dir);
  await begin(first);
  await flyAll(first, first.flight.samples.slice(0, 800));
  const phaseBefore = first.manager.view().phase;
  // A new ACARS process with the same data folder
  const second = setUp({}, dir);
  assert.equal(second.manager.restore({ id: 77 }), true);
  assert.equal(second.manager.view().phase, phaseBefore);
  assert.equal(second.manager.view().waitingToResume, true);
  // The server says there's no active flight anymore (abandoned): the saved one is cleared
  const third = setUp({}, dir);
  assert.equal(third.manager.restore(null), false);
  assert.equal(fs.existsSync(path.join(dir, "active-flight.json")), false);
});

test("the flight data file is written as it happens and stays readable after a crash of ACARS (ACR-12)", () => {
  const dir = tempDir();
  const rec = createRecorder(dir, 9, { version: 1 });
  for (let i = 0; i < 20; i += 1) rec.write({ t: i * 1000, lat: 1, lon: 1 }, i * 1000);
  // ACARS "crashes": a new recorder appends to the same file
  const again = createRecorder(dir, 9, { version: 1 });
  again.write({ t: 99000, lat: 1, lon: 1 }, 99000);
  const lines = zlib.gunzipSync(again.read()).toString("utf8").trim().split("\n");
  assert.equal(JSON.parse(lines[0]).type, "header");
  assert.equal(lines.filter((l) => l.includes('"type":"header"')).length, 1);
  // Everything written up to the last 5-second save survived; at most the last few seconds are lost
  const times = lines.slice(1).map((l) => JSON.parse(l).t);
  assert.deepEqual(times.slice(0, 16), Array.from({ length: 16 }, (_, i) => i * 1000));
  assert.equal(times.at(-1), 99000);
});

test("time acceleration shows the warning right away (ACR-13)", async () => {
  const ctx = setUp({ accelSeconds: 40 });
  await begin(ctx);
  const warnings = [];
  ctx.manager.events.on("warning", (w) => warnings.push(w));
  await flyAll(ctx);
  assert.deepEqual(warnings, ["Time acceleration isn't used on Cairn flights. Set the sim rate back to 1×."]);
});
