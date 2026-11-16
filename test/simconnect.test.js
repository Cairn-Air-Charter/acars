// The SimConnect connection's "in a flight" state (flows/acars.md ACR-8, ACR-9), with a fake
// SimConnect. Regression: MSFS has an aircraft loaded in its menus, and loading into a flight
// with the same aircraft sends no new aircraft data, so ACARS got stuck on "no aircraft".
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSimConnection } = require("../src/main/sim/simconnect");

function fakeSimConnect(title) {
  const handle = Object.assign(new EventEmitter(), {
    requests: [],
    systemStates: [],
    clearDataDefinition() {},
    addToDataDefinition: () => 1,
    addToFacilityDefinition() {},
    subscribeToSystemEvent() {},
    requestDataOnSimObject(requestId, defId, object, period) {
      this.requests.push({ requestId, period });
    },
    requestSystemState(requestId, name) {
      this.systemStates.push({ requestId, name });
    },
    close() {},
  });
  const SC = {
    Protocol: { KittyHawk: 5 },
    SimConnectDataType: { FLOAT64: 4, INT32: 1, STRING8: 5, STRING32: 6, STRING64: 7, STRING256: 9 },
    SimConnectPeriod: { NEVER: 0, ONCE: 1, SIM_FRAME: 3, SECOND: 4 },
    SimConnectConstants: { OBJECT_ID_USER: 0 },
    DataRequestFlag: { DATA_REQUEST_FLAG_CHANGED: 1 },
    FacilityDataType: { AIRPORT: 0, RUNWAY: 1 },
    open: async () => ({ recvOpen: { applicationVersionMajor: 11, applicationVersionMinor: 0, applicationName: "KittyHawk" }, handle }),
  };
  // Identity data: every string reader returns the aircraft's title or model
  const identity = (requestID) => ({ requestID, data: { readString256: () => title, readString32: () => "TT:ATCCOM.AC_MODEL_C172.0.text", readString64: () => "Cessna", readString8: () => "" } });
  return { SC, handle, identity };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an aircraft in the MSFS menus isn't 'in a flight'; loading into a flight with the same aircraft is (ACR-8)", async () => {
  const { SC, handle, identity } = fakeSimConnect("Cessna Skyhawk Asobo");
  const sim = createSimConnection({ simconnect: SC });
  sim.start();
  await tick();
  assert.deepEqual(handle.systemStates.map((s) => s.name), ["Sim"]); // asks right away whether a flight is running

  // In the main menu: the sim says no flight is running, but an aircraft is "loaded"
  handle.emit("systemState", { requestID: 5, dataInteger: 0 });
  handle.emit("simObjectData", identity(3));
  assert.equal(sim.status().inFlight, false);
  assert.equal(sim.status().aircraft.title, "Cessna Skyhawk Asobo");

  // Loading into the flight: MSFS sends SimStop on the way, then SimStart. Same aircraft,
  // so the changed-only aircraft data never comes again; ACARS asks for it once instead.
  handle.emit("event", { clientEventId: 2, data: 0 }); // SimStop
  const before = handle.requests.length;
  handle.emit("event", { clientEventId: 1, data: 0 }); // SimStart
  assert.ok(handle.requests.slice(before).some((r) => r.requestId === 4 && r.period === 1), "asks for the aircraft again, once");
  assert.equal(sim.status().inFlight, true);
  assert.equal(sim.status().aircraft.designator, "C172");

  // Back to the menus
  handle.emit("event", { clientEventId: 10, data: 0 }); // Sim: 0
  assert.equal(sim.status().inFlight, false);
  sim.stop();
});

test("connecting while a flight is already running is 'in a flight' as soon as the aircraft is known (ACR-8)", async () => {
  const { SC, handle, identity } = fakeSimConnect("DHC-2 Beaver");
  const sim = createSimConnection({ simconnect: SC });
  sim.start();
  await tick();
  handle.emit("simObjectData", identity(3));
  assert.equal(sim.status().inFlight, false); // not known yet whether a flight is running
  handle.emit("systemState", { requestID: 5, dataInteger: 1 });
  assert.equal(sim.status().inFlight, true);
  sim.stop();
});
