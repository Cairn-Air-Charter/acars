// The one shared date and time helper for every page (GEN-8).
// Identical copy in the website, Trailhead and ACARS (src/renderer/datetime.js).
// Change every copy at the same time.
//
// - Date-times from the server are ISO 8601 text in UTC (ending in "Z").
//   They are shown in the reader's own time zone and date/time format.
// - Date-only values ("YYYY-MM-DD", for example a date of birth) are shown in
//   the reader's date format WITHOUT time-zone conversion, so they never shift a day.
// - Pages never format dates themselves. Use window.CairnTime.
(function (root) {
  "use strict";

  const EMPTY = "—";

  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Local date and time, for example "Nov 15, 2026, 3:30 PM" (US) or "15 Nov 2026, 15:30" (UK)
  function formatDateTime(value) {
    const date = toDate(value);
    if (!date) return EMPTY;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  // Local date only, converted to the reader's time zone
  function formatDate(value) {
    const date = toDate(value);
    if (!date) return EMPTY;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  }

  // Local time of day only, for example "3:30 PM" (US) or "15:30" (UK)
  function formatTime(value) {
    const date = toDate(value);
    if (!date) return EMPTY;
    return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
  }

  // A date-only value ("YYYY-MM-DD"), shown without any time-zone conversion
  function formatDateOnly(value) {
    if (typeof value !== "string") return EMPTY;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!match) return EMPTY;
    const [y, m, d] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return EMPTY;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  // Time left until a date-time, in plain words: "2 days 4 hours left",
  // "3 hours 10 minutes left", "Less than a minute left", or "Overdue".
  function formatRelativeRemaining(value, nowMs) {
    const date = toDate(value);
    if (!date) return EMPTY;
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const ms = date.getTime() - now;
    if (ms <= 0) return "Overdue";

    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")} left` : `${plural(days, "day")} left`;
    if (hours > 0) return minutes > 0 ? `${plural(hours, "hour")} ${plural(minutes, "minute")} left` : `${plural(hours, "hour")} left`;
    if (minutes > 0) return `${plural(minutes, "minute")} left`;
    return "Less than a minute left";
  }

  // Turns an <input type="datetime-local"> value (the reader's local time) into
  // UTC ISO text ending in "Z", ready to send to the server. Returns null if invalid.
  function toUtcIso(localValue) {
    if (typeof localValue !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue.trim());
    if (!match) return null;
    const [y, mo, d, h, mi, s] = match.slice(1).map((part) => Number(part || 0));
    const date = new Date(y, mo - 1, d, h, mi, s); // read as the reader's local time
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  const CairnTime = { formatDateTime, formatDate, formatTime, formatDateOnly, formatRelativeRemaining, toUtcIso };

  if (typeof module !== "undefined" && module.exports) module.exports = CairnTime;
  if (root) root.CairnTime = CairnTime;
})(typeof window !== "undefined" ? window : null);
