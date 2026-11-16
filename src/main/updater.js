// Updates (flows/acars.md ACR-2): ACARS checks GitHub Releases when it starts and every
// 6 hours. An update downloads in the background and installs the next time ACARS closes.
// An update never installs during a flight.
"use strict";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function createUpdater({ log, flightActive, notify, autoUpdater = require("electron-updater").autoUpdater }) {
  let state = { status: "idle", version: null };
  const set = (next) => {
    state = { ...state, ...next };
    notify(state);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-not-available", () => set({ status: "current" }));
  autoUpdater.on("update-available", (info) => set({ status: "downloading", version: info.version }));
  autoUpdater.on("update-downloaded", (info) => set({ status: "ready", version: info.version }));
  autoUpdater.on("error", (error) => {
    log("update_error", { message: error && error.message });
    set({ status: "error" });
  });

  async function checkNow() {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      log("update_check_failed", { message: error.message });
    }
    return state;
  }

  return {
    start() {
      checkNow();
      setInterval(checkNow, CHECK_EVERY_MS);
    },
    checkNow,
    state: () => state,
    /** Called as ACARS closes: install a waiting update only when no flight is in progress. */
    beforeQuit() {
      autoUpdater.autoInstallOnAppQuit = !flightActive();
    },
  };
}

module.exports = { createUpdater, CHECK_EVERY_MS };
