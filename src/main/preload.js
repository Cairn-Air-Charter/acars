// The only bridge between the ACARS screens and the rest of the app (flows/acars.md ACR-1):
// a small, named list of functions. The screens can't reach Node, SimConnect, the network
// or the disk any other way (contextIsolation, sandbox, no nodeIntegration).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// Messages the main process sends to the screens
const EVENTS = ["auth", "sim", "live", "feed", "landing", "flight", "checks", "sync", "connection", "warning", "crashed", "briefing", "update", "outbox", "sayintentions"];

contextBridge.exposeInMainWorld("acars", {
  // Account (ACR-3)
  authState: call("auth:state"),
  login: call("auth:login"),
  logout: call("auth:logout"),
  setRememberMe: call("auth:setRemember"),
  // Home, missions, logbook (ACR-5 to ACR-7)
  home: call("home:get"),
  missionOptions: call("missions:options"),
  missions: call("missions:list"),
  mission: call("missions:get"),
  takePreview: call("missions:preview"),
  takeMission: call("missions:take"),
  dropMission: call("missions:drop"),
  logbook: call("logbook:get"),
  report: call("report:get"),
  dismissNotice: call("notices:dismiss"),
  // Messages and optional notices (flows/messages.md)
  messages: call("messages:list"),
  message: call("messages:get"),
  sendMessage: call("messages:send"),
  reply: call("messages:reply"),
  archive: call("messages:archive"),
  recipients: call("messages:recipients"),
  notices: call("notices:get"),
  saveNotices: call("notices:save"),
  // Simulator and flying (ACR-8 to ACR-16)
  simStatus: call("sim:status"),
  testSim: call("sim:test"),
  openChecklist: call("flight:checklist"),
  closeChecklist: call("flight:closeChecklist"),
  beginFlight: call("flight:begin"),
  flightView: call("flight:view"),
  cancelFlight: call("flight:cancel"),
  arrivalCheck: call("flight:arrival"),
  fileReport: call("flight:file"),
  // SayIntentions (flows/sayintentions.md SI-3, SI-6)
  sayIntentions: call("sayintentions:status"),
  atis: call("sayintentions:atis"),
  // Settings and diagnostics (ACR-17)
  settings: call("settings:get"),
  saveSetting: call("settings:set"),
  appInfo: call("app:info"),
  checkForUpdates: call("app:checkUpdates"),
  sendDiagnostics: call("app:diagnostics"),
  changes: call("app:changes"),
  justUpdated: call("app:justUpdated"),
  openInBrowser: call("app:openExternal"),
  // Subscribe to updates from the main process; returns an unsubscribe function
  on(event, handler) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
