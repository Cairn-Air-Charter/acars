// ACARS settings saved on this PC (flows/acars.md ACR-17): the email address, Remember me,
// the encrypted saved login, message chime, and start with Windows. One small JSON file in
// the app's data folder, written whole each time.
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = { chime: true, startWithWindows: false, rememberMe: false };

function createPrefs(dir) {
  const file = path.join(dir, "settings.json");
  let values = { ...DEFAULTS };
  try {
    values = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    /* first run */
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(values, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
  return {
    get: (key) => values[key],
    set(key, value) {
      values[key] = value;
      save();
    },
    remove(key) {
      delete values[key];
      save();
    },
    /** Settings the screens may see. Never includes the saved login. */
    visible: () => ({ chime: values.chime !== false, startWithWindows: values.startWithWindows === true, rememberMe: values.rememberMe === true, email: values.email || "" }),
  };
}

module.exports = { createPrefs };
