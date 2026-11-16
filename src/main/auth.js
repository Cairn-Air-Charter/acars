// Logging in (flows/acars.md ACR-3). Exactly the same login as Trailhead: the same
// endpoint, checks and messages. There's no separate ACARS password, token or login system.
//
// Remember me on this PC: the email and password are saved encrypted with Windows' own
// protection for the current Windows user (Electron safeStorage, which uses Windows DPAPI).
// They're never saved in plain text, never logged, and never sent anywhere but the login
// endpoint. A silent login is tried once; if it fails, the saved password is deleted and
// ACARS never retries on its own, so it can't trip the lockout (AUTH-5).
"use strict";

const SAVED_PASSWORD_FAILED = "Your saved password didn't work. It may have been changed on the website. Log in again.";

/**
 * deps:
 *   api      from api.js
 *   secrets  { isEncryptionAvailable(), encryptString(text) -> Buffer, decryptString(buffer) -> text } (safeStorage)
 *   prefs    { get(key), set(key, value), remove(key) } saved on disk
 *   locale   () => { timeZone, language } of the PC (AUTH-3 step 5)
 *   clearSession  () => Promise: deletes the session cookie
 */
function createAuth({ api, secrets, prefs, locale, clearSession }) {
  let pilot = null;

  function savedEmail() {
    return prefs.get("email") || "";
  }

  function rememberOn() {
    return prefs.get("rememberMe") === true;
  }

  function forgetPassword() {
    prefs.remove("savedLogin");
  }

  function savePassword(email, password) {
    if (!secrets.isEncryptionAvailable()) return false;
    const encrypted = secrets.encryptString(JSON.stringify({ email, password }));
    prefs.set("savedLogin", Buffer.from(encrypted).toString("base64"));
    return true;
  }

  function readSavedLogin() {
    const stored = prefs.get("savedLogin");
    if (!stored || !secrets.isEncryptionAvailable()) return null;
    try {
      return JSON.parse(secrets.decryptString(Buffer.from(stored, "base64")));
    } catch {
      forgetPassword();
      return null;
    }
  }

  async function loadPilot() {
    const me = await api.me();
    pilot = me.ok ? { ...me.data.pilot, permissions: me.data.permissions } : null;
    return pilot;
  }

  /** The login form. Returns { ok, pilot } or { ok: false, message, type, applyUrl, retryAfterSeconds }. */
  async function login(email, password, remember) {
    const { timeZone, language } = locale();
    const response = await api.login(email, password, timeZone, language);
    prefs.set("email", typeof email === "string" ? email.trim() : "");
    prefs.set("rememberMe", Boolean(remember));
    if (!response.ok) {
      forgetPassword();
      return {
        ok: false,
        message: response.status === 0 ? response.error : response.data.error || response.error,
        type: response.data.type || null,
        applyUrl: response.data.applyUrl || null,
        retryAfterSeconds: response.data.retryAfterSeconds || null,
      };
    }
    if (remember) savePassword(email, password);
    else forgetPassword();
    await loadPilot();
    return { ok: true, pilot };
  }

  /**
   * When ACARS opens, or after a 401: use the session if it's still good; otherwise, if
   * Remember me is on, log in again ONCE, silently, with the saved details.
   * Returns { ok, pilot } or { ok: false, message, email }.
   */
  async function resume() {
    if (await loadPilot()) return { ok: true, pilot };
    const saved = rememberOn() ? readSavedLogin() : null;
    if (!saved) return { ok: false, message: null, email: savedEmail() };
    const { timeZone, language } = locale();
    const response = await api.login(saved.email, saved.password, timeZone, language);
    if (response.ok) {
      await loadPilot();
      return { ok: true, pilot };
    }
    if (response.status === 0) return { ok: false, offline: true, message: response.error, email: saved.email };
    // A failed silent login: delete the saved password, keep the email, never retry
    forgetPassword();
    const message = response.data.type === "generic" || response.status === 401 ? SAVED_PASSWORD_FAILED : response.data.error || response.error;
    return { ok: false, message, email: saved.email };
  }

  /** Log out ends only this PC's session (AUTH-10) and deletes the saved password right away. */
  async function logout() {
    await api.logout();
    forgetPassword();
    await clearSession();
    pilot = null;
  }

  /** Unchecking Remember me deletes the saved password right away. */
  function setRememberMe(on) {
    prefs.set("rememberMe", Boolean(on));
    if (!on) forgetPassword();
  }

  return {
    login,
    resume,
    logout,
    setRememberMe,
    forgetPassword,
    get pilot() {
      return pilot;
    },
    get rememberMe() {
      return rememberOn();
    },
    get email() {
      return savedEmail();
    },
    hasSavedPassword: () => Boolean(prefs.get("savedLogin")),
  };
}

module.exports = { createAuth, SAVED_PASSWORD_FAILED };
