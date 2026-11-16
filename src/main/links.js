// Links ACARS may open in the pilot's web browser: only Cairn's own sites and the ACARS
// download page, always https (ACR-5: every airport code opens its Trailhead page).
"use strict";

const ALLOWED_HOSTS = new Set(["trailhead.cairncharter.org", "cairncharter.org", "www.cairncharter.org", "www.gdacs.org"]);

function isAllowedExternal(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    if (ALLOWED_HOSTS.has(u.hostname)) return true;
    return u.hostname === "github.com" && u.pathname.startsWith("/Cairn-Air-Charter/acars/releases");
  } catch {
    return false;
  }
}

module.exports = { isAllowedExternal, ALLOWED_HOSTS };
