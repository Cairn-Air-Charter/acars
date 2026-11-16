// Distances and runway geometry used by ACARS on the PC. The server does its own, final
// measurements (flows/acars.md FOQA-2); these are for live data and preliminary numbers.
"use strict";

const EARTH_RADIUS_FT = 20902231;
const FT_PER_NM = 6076.12;
const toRad = (d) => (d * Math.PI) / 180;

function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_FT * Math.asin(Math.min(1, Math.sqrt(a)))) / FT_PER_NM;
}

function headingDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Feet past a runway end (along) and from its centerline (cross), flat-earth around the end. */
function runwayFrame(end, lat, lon) {
  const dNorth = toRad(lat - end.lat) * EARTH_RADIUS_FT;
  const dEast = toRad(lon - end.lon) * EARTH_RADIUS_FT * Math.cos(toRad(end.lat));
  const h = toRad(end.headingTrue);
  return { along: dNorth * Math.cos(h) + dEast * Math.sin(h), cross: -dNorth * Math.sin(h) + dEast * Math.cos(h) };
}

/** The runway end best lined up with a heading at a position (for "Takeoff roll, runway 25."). */
function runwayFor(ends, lat, lon, heading) {
  let best = null;
  for (const end of ends || []) {
    const f = runwayFrame(end, lat, lon);
    if (f.along < -1000 || f.along > end.lengthFt + 500 || Math.abs(f.cross) > Math.max(300, end.widthFt)) continue;
    const score = headingDiff(heading, end.headingTrue) + Math.abs(f.cross) / 50;
    if (headingDiff(heading, end.headingTrue) < 30 && (!best || score < best.score)) best = { end, score };
  }
  return best ? best.end : null;
}

module.exports = { FT_PER_NM, distanceNm, headingDiff, runwayFrame, runwayFor };
