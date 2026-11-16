// When to send a position report (flows/acars.md ACR-12). Pure.
//   - parked and not moving (on the ground, under 1 kt): every 120 seconds
//   - moving (1 kt or more, or airborne): every 60 seconds
//   - plus one right away at every phase change and every OOOI time
//   - while paused, no timed reports; one marks the pause and one the resume
"use strict";

const DEFAULT_INTERVALS = { parked_s: 120, moving_s: 60 };

function createReportClock(intervals) {
  const iv = { ...DEFAULT_INTERVALS, ...(intervals || {}) };
  let lastSent = null;
  let paused = false;

  /**
   * sample: the latest reading; changed: true when a phase changed or an OOOI time happened.
   * Returns the reason to send now ("first", "phase", "timed", "pause", "resume") or null.
   */
  function due(sample, changed) {
    const t = sample.t;
    if (sample.paused === true) {
      if (!paused) {
        paused = true;
        lastSent = t;
        return "pause";
      }
      return null;
    }
    if (paused) {
      paused = false;
      lastSent = t;
      return "resume";
    }
    if (lastSent === null) {
      lastSent = t;
      return "first";
    }
    if (changed) {
      lastSent = t;
      return "phase";
    }
    const parked = sample.gnd === true && (sample.gs || 0) < 1;
    const every = (parked ? iv.parked_s : iv.moving_s) * 1000;
    if (t - lastSent >= every) {
      lastSent = t;
      return "timed";
    }
    return null;
  }

  return { due, setIntervals: (next) => Object.assign(iv, next || {}) };
}

module.exports = { createReportClock, DEFAULT_INTERVALS };
