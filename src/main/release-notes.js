// The running commit and the "What changed" notes (flows/versions.md VER-1 to VER-4).
// - The commit comes from src/build-info.json, written by the release workflow from
//   GITHUB_SHA (VER-2). It isn't a secret, so "development" is shown when it's missing.
// - The notes come from release-notes.json, written in plain language with every change.
// The same safety checks as Trailhead's version.js: a note that names a file, a path, or
// anything about secrets or the database is never shown (VER-4).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const BUILD_INFO = path.join(__dirname, "..", "build-info.json");
const NOTES_FILE = path.join(ROOT, "release-notes.json");
const MAX_ENTRIES = 50;

const BLOCKED_WORDS = ["password", "secret", "token", "api key", "environment variable", "migration", "schema", "database", "column", "sql"];
const FILE_NAME = /\b[\w-]+\.(js|mjs|cjs|sql|css|html|json|yml|yaml|md|txt|env|ts)\b/i;
const PATH_LIKE = /(^|\s)(\.{0,2}\/|[A-Za-z]:\\)[\w./\\-]+/;

/** The 7-character commit ID, or null. */
function shortCommit(value) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7).toLowerCase() : null;
}

/** The commit this copy of ACARS was built from, or null on a developer's PC. */
function commit(file = BUILD_INFO) {
  try {
    return shortCommit(JSON.parse(fs.readFileSync(file, "utf8")).commit);
  } catch {
    return null;
  }
}

function noteProblems(note) {
  const problems = [];
  if (typeof note !== "string" || !note.trim()) return ["empty note"];
  for (const word of BLOCKED_WORDS) {
    if (new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "i").test(note)) problems.push(`mentions "${word}"`);
  }
  if (FILE_NAME.test(note)) problems.push("names a file");
  if (PATH_LIKE.test(note)) problems.push("contains a path");
  if (note.length > 300) problems.push("longer than 300 characters");
  return problems;
}

function validateNotes(entries) {
  const problems = [];
  if (!Array.isArray(entries)) return ["release notes must be a list"];
  let previous = null;
  entries.forEach((entry, i) => {
    if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date || "")) problems.push(`entry ${i}: date must be YYYY-MM-DD`);
    if (previous && entry && entry.date > previous) problems.push(`entry ${i}: entries must be newest first`);
    if (!entry || !Array.isArray(entry.notes) || entry.notes.length < 1 || entry.notes.length > 8) problems.push(`entry ${i}: 1 to 8 notes`);
    else entry.notes.forEach((note, j) => noteProblems(note).forEach((p) => problems.push(`entry ${i} note ${j}: ${p}`)));
    previous = entry && entry.date;
  });
  return problems;
}

/** The newest 50 entries, leaving out any note that fails the checks. */
function load(file = NOTES_FILE) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") && Array.isArray(e.notes))
    .map((e) => ({ date: e.date, notes: e.notes.filter((n) => noteProblems(n).length === 0) }))
    .filter((e) => e.notes.length > 0)
    .slice(0, MAX_ENTRIES);
}

module.exports = { commit, shortCommit, noteProblems, validateNotes, load, NOTES_FILE, BUILD_INFO, MAX_ENTRIES };
