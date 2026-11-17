// ACARS settings saved on this PC (flows/acars.md ACR-17): the email address, Remember me,
// the encrypted saved login, message chime, start with Windows, and the version that last
// ran (to open What changed after an update, flows/versions.md VER-3). One small JSON file in
// the app's data folder, written whole each time.
"use strict";

const fs = require("fs");
const path = require("path");

// telexes: Cairn dispatch telexes through SayIntentions, on by default (flows/sayintentions.md SI-3)
const DEFAULTS = { chime: true, startWithWindows: false, rememberMe: false, telexes: true };

function createPrefs(dir) {
  const file = path.join(dir, "settings.json");
  let values = { ...DEFAULTS };
  let existed = false;
  try {
    values = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    existed = true;
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
    /**
     * True when this version is different from the one that ran last time (an update), and
     * records this version. A brand-new install isn't an update. Copies from before 1.0.6
     * didn't record a version, so a settings file without one counts as an update.
     */
    updatedTo(current) {
      const last = values.lastVersion;
      const updated = last ? last !== current : existed;
      if (last !== current) {
        values.lastVersion = current;
        save();
      }
      return updated;
    },
    /** Settings the screens may see. Never includes the saved login. */
    visible: () => ({ chime: values.chime !== false, startWithWindows: values.startWithWindows === true, rememberMe: values.rememberMe === true, telexes: values.telexes !== false, email: values.email || "" }),
  };
}

module.exports = { createPrefs };
