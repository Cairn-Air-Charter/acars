// Flight report charts (flows/acars.md FR-6, ACR-7): the track map, the approach charts,
// and the runway drawing. Drawn as SVG from the report's data.
// Identical copy in Trailhead (public/flight-charts.js) and ACARS (src/renderer/flight-charts.js).
// Change both at the same time.
//
// Every chart shows one measure on one axis (no dual axes), with a 2 px Beacon Green line,
// quiet grid lines, and a hover readout. Text uses the text colors, never the line color.
(function (root) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const LINE = "var(--cairn-beacon-green)";
  const TEXT = "var(--color-text)";
  const MUTED = "var(--color-text-muted)";
  const GRID = "var(--color-border)";

  function svg(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(parent, x, y, content, attrs) {
    const t = svg("text", { x, y, fill: TEXT, "font-size": 12, ...(attrs || {}) }, parent);
    t.textContent = content;
    return t;
  }

  function canvas(container, width, height, label) {
    container.textContent = "";
    const box = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label, width: "100%" }, container);
    box.style.display = "block";
    box.style.maxWidth = "100%";
    box.style.height = "auto";
    return box;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });

  // ==========================================
  // TRACK MAP
  // ==========================================

  /**
   * track: [[lat, lon, alt], ...]; places: [{ code, lat, lon, label }] (departure, arrival...)
   */
  function track(container, points, places) {
    const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const marks = (places || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length < 2 && marks.length < 1) {
      container.textContent = "No track recorded for this flight.";
      return;
    }
    const all = pts.map((p) => ({ lat: p[0], lon: p[1] })).concat(marks);
    const midLat = all.reduce((s, p) => s + p.lat, 0) / all.length;
    const k = Math.cos((midLat * Math.PI) / 180);
    const xs = all.map((p) => p.lon * k);
    const ys = all.map((p) => p.lat);
    let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = Math.max(x1 - x0, y1 - y0) * 0.12 || 0.05;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const W = 640;
    const H = 360;
    const scale = Math.min(W / (x1 - x0), H / (y1 - y0));
    const ox = (W - (x1 - x0) * scale) / 2;
    const oy = (H - (y1 - y0) * scale) / 2;
    const px = (lat, lon) => [ox + (lon * k - x0) * scale, H - (oy + (lat - y0) * scale)];

    const box = canvas(container, W, H, `Track map from ${marks.map((m) => m.code).join(" to ")}`);
    svg("rect", { x: 0, y: 0, width: W, height: H, fill: "none", stroke: GRID }, box);
    if (pts.length >= 2) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${px(p[0], p[1]).map((v) => v.toFixed(1)).join(" ")}`).join(" ");
      svg("path", { d, fill: "none", stroke: LINE, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, box);
    }
    for (const place of marks) {
      const [x, y] = px(place.lat, place.lon);
      svg("circle", { cx: x, cy: y, r: 5, fill: TEXT, stroke: "var(--color-surface)", "stroke-width": 2 }, box);
      text(box, x + 8, y - 8, place.label || place.code, { "font-weight": 600 });
    }
  }

  // ==========================================
  // APPROACH CHARTS (one measure each)
  // ==========================================

  /**
   * points: [[distanceFt, value], ...] with distance to the landing threshold (negative = before).
   * opts: { label, unit, zeroLine }
   */
  function lineChart(container, points, opts) {
    const pts = (points || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 2) {
      container.textContent = `No ${opts.label.toLowerCase()} data.`;
      return;
    }
    const W = 640;
    const H = 220;
    const m = { l: 56, r: 16, t: 16, b: 34 };
    const xMin = Math.min(...pts.map((p) => p[0]));
    const xMax = Math.max(...pts.map((p) => p[0]));
    let yMin = Math.min(...pts.map((p) => p[1]));
    let yMax = Math.max(...pts.map((p) => p[1]));
    if (opts.zeroLine) { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
    if (yMax === yMin) { yMax += 1; yMin -= 1; }
    const sx = (v) => m.l + ((v - xMin) / (xMax - xMin || 1)) * (W - m.l - m.r);
    const sy = (v) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

    const box = canvas(container, W, H, `${opts.label} against distance to the threshold`);
    for (const t of niceTicks(yMin, yMax, 4)) {
      svg("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), stroke: GRID, "stroke-width": 1 }, box);
      text(box, m.l - 6, sy(t) + 4, fmt(t), { "text-anchor": "end", fill: MUTED, "font-size": 11 });
    }
    for (const t of niceTicks(xMin, xMax, 6)) {
      text(box, sx(t), H - m.b + 16, fmt(t), { "text-anchor": "middle", fill: MUTED, "font-size": 11 });
    }
    text(box, (m.l + W - m.r) / 2, H - 4, "Distance to threshold (ft)", { "text-anchor": "middle", fill: MUTED, "font-size": 11 });
    if (xMin <= 0 && xMax >= 0) {
      svg("line", { x1: sx(0), x2: sx(0), y1: m.t, y2: H - m.b, stroke: MUTED, "stroke-width": 1, "stroke-dasharray": "4 4" }, box);
      text(box, sx(0) + 4, m.t + 10, "Threshold", { fill: MUTED, "font-size": 11 });
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join(" ");
    svg("path", { d, fill: "none", stroke: LINE, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, box);

    // Hover: a crosshair and readout that follow the nearest point
    const cross = svg("line", { y1: m.t, y2: H - m.b, stroke: TEXT, "stroke-width": 1, visibility: "hidden" }, box);
    const dot = svg("circle", { r: 4, fill: LINE, stroke: "var(--color-surface)", "stroke-width": 2, visibility: "hidden" }, box);
    const tip = text(box, 0, m.t + 12, "", { visibility: "hidden", "font-weight": 600 });
    const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, box);
    const show = (event) => {
      const rect = box.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(sx(p[0]) - x) < Math.abs(sx(best[0]) - x)) best = p;
      cross.setAttribute("x1", sx(best[0]));
      cross.setAttribute("x2", sx(best[0]));
      dot.setAttribute("cx", sx(best[0]));
      dot.setAttribute("cy", sy(best[1]));
      tip.textContent = `${fmt(best[0])} ft: ${fmt(best[1])} ${opts.unit}`;
      tip.setAttribute("x", Math.min(sx(best[0]) + 8, W - 170));
      for (const n of [cross, dot, tip]) n.setAttribute("visibility", "visible");
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerleave", () => { for (const n of [cross, dot, tip]) n.setAttribute("visibility", "hidden"); });
  }

  // profile.points: [[distanceFt, heightAboveField, vs, ias], ...]. Reports analyzed before
  // the charts moved to feet have no unit and distances in nm; those are converted.
  function approach(containers, profile) {
    const raw = (profile && profile.points) || [];
    const toFt = profile && profile.unit === "ft" ? 1 : 6076.12;
    const p = raw.map((x) => [Math.round(x[0] * toFt), x[1], x[2], x[3]]);
    if (containers.altitude) lineChart(containers.altitude, p.map((x) => [x[0], x[1]]), { label: "Height above the field", unit: "ft" });
    if (containers.verticalSpeed) lineChart(containers.verticalSpeed, p.map((x) => [x[0], x[2]]), { label: "Vertical speed", unit: "fpm", zeroLine: true });
    if (containers.airspeed) lineChart(containers.airspeed, p.map((x) => [x[0], x[3]]), { label: "Indicated airspeed", unit: "kt" });
  }

  // ==========================================
  // THE WHOLE FLIGHT (against time)
  // ==========================================

  const SECOND_LINE = "var(--color-text)"; // the second series: a dashed Bone line, named in the legend

  /**
   * One chart against time. series: [{ label, points: [[seconds, value], ...], dashed }] — one
   * or two series sharing one unit (never two different units on one chart). start: the time
   * (ms) of second 0, shown in the reader's local time with the shared helper (GEN-8).
   */
  function timeChart(container, series, opts) {
    const all = series.map((s) => ({ ...s, points: (s.points || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) }));
    const pts = all.flatMap((s) => s.points);
    if (pts.length < 2) {
      container.textContent = `No ${opts.label.toLowerCase()} data.`;
      return;
    }
    const W = 640;
    const H = 220;
    const m = { l: 60, r: 16, t: series.length > 1 ? 30 : 16, b: 34 };
    const xMin = Math.min(...pts.map((p) => p[0]));
    const xMax = Math.max(...pts.map((p) => p[0]));
    let yMin = Math.min(0, ...pts.map((p) => p[1]));
    let yMax = Math.max(...pts.map((p) => p[1]));
    if (yMax === yMin) yMax += 1;
    const sx = (v) => m.l + ((v - xMin) / (xMax - xMin || 1)) * (W - m.l - m.r);
    const sy = (v) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
    const clock = (sec) => (root && root.CairnTime ? root.CairnTime.formatTime(opts.start + sec * 1000) : `${Math.round(sec / 60)} min`);

    const box = canvas(container, W, H, `${opts.label} over the whole flight`);
    for (const t of niceTicks(yMin, yMax, 4)) {
      svg("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), stroke: GRID, "stroke-width": 1 }, box);
      text(box, m.l - 6, sy(t) + 4, fmt(t), { "text-anchor": "end", fill: MUTED, "font-size": 11 });
    }
    for (const t of niceTicks(xMin, xMax, 5)) {
      text(box, sx(t), H - m.b + 16, clock(t), { "text-anchor": "middle", fill: MUTED, "font-size": 11 });
    }
    all.forEach((s, i) => {
      if (s.points.length < 2) return;
      const d = s.points.map((p, k) => `${k ? "L" : "M"}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join(" ");
      svg("path", { d, fill: "none", stroke: i === 0 ? LINE : SECOND_LINE, "stroke-width": 2, "stroke-dasharray": s.dashed ? "6 4" : "none", "stroke-linejoin": "round", "stroke-linecap": "round" }, box);
    });
    // Legend whenever there are two series, so a line is never told apart by color alone
    if (all.length > 1) {
      let x = m.l;
      all.forEach((s, i) => {
        svg("line", { x1: x, x2: x + 22, y1: 12, y2: 12, stroke: i === 0 ? LINE : SECOND_LINE, "stroke-width": 2, "stroke-dasharray": s.dashed ? "6 4" : "none" }, box);
        text(box, x + 28, 16, s.label, { "font-size": 12 });
        x += 40 + s.label.length * 7;
      });
    }

    // Hover: a crosshair and every series' value at that time
    const cross = svg("line", { y1: m.t, y2: H - m.b, stroke: TEXT, "stroke-width": 1, visibility: "hidden" }, box);
    const tip = text(box, 0, m.t + 12, "", { visibility: "hidden", "font-weight": 600 });
    const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, box);
    hit.addEventListener("pointermove", (event) => {
      const rect = box.getBoundingClientRect();
      const x = xMin + (((event.clientX - rect.left) / rect.width) * W - m.l) / (W - m.l - m.r) * (xMax - xMin);
      const values = all.map((s) => {
        let best = s.points[0];
        for (const p of s.points) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
        return best;
      }).filter(Boolean);
      if (!values.length) return;
      cross.setAttribute("x1", sx(values[0][0]));
      cross.setAttribute("x2", sx(values[0][0]));
      tip.textContent = `${clock(values[0][0])}: ${values.map((v, i) => `${all.length > 1 ? `${all[i].label} ` : ""}${fmt(v[1])} ${opts.unit}`).join(", ")}`;
      tip.setAttribute("x", Math.min(sx(values[0][0]) + 8, W - 260));
      cross.setAttribute("visibility", "visible");
      tip.setAttribute("visibility", "visible");
    });
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      tip.setAttribute("visibility", "hidden");
    });
  }

  /** flight: { start, points: [[seconds, altitudeFt, groundSpeedKt, indicatedKt], ...] } -> two charts */
  function flight(containers, profile) {
    if (!profile || !profile.points) {
      for (const c of [containers.altitude, containers.speed]) if (c) c.textContent = "The whole-flight charts come with the hourly check.";
      return;
    }
    const p = profile.points;
    if (containers.altitude) timeChart(containers.altitude, [{ label: "Altitude", points: p.map((x) => [x[0], x[1]]) }], { label: "Altitude", unit: "ft", start: profile.start });
    if (containers.speed) {
      timeChart(containers.speed, [
        { label: "Ground speed", points: p.map((x) => [x[0], x[2]]) },
        { label: "Indicated airspeed", points: p.map((x) => [x[0], x[3]]), dashed: true },
      ], { label: "Speed", unit: "kt", start: profile.start });
    }
  }

  // ==========================================
  // RUNWAY DRAWING
  // ==========================================

  /** runway: { ident, lengthFt, widthFt, displacedFt, tdzFt, touchdown: { along, cross }, slowAlong } */
  function runway(container, r) {
    if (!r || !Number.isFinite(r.lengthFt)) {
      container.textContent = "No runway data for this landing.";
      return;
    }
    const W = 640;
    const H = 170;
    const m = { l: 16, r: 16 };
    const top = 50;
    const height = 60;
    const sx = (ft) => m.l + (Math.max(-200, Math.min(r.lengthFt + 200, ft)) / r.lengthFt) * (W - m.l - m.r);
    const sy = (crossFt) => top + height / 2 + (crossFt / (r.widthFt || 100)) * height;
    const box = canvas(container, W, H, `Runway ${r.ident || ""} drawing with the touchdown point`);
    svg("rect", { x: sx(0), y: top, width: sx(r.lengthFt) - sx(0), height, fill: "var(--color-surface)", stroke: TEXT, "stroke-width": 1 }, box);
    const threshold = r.displacedFt || 0;
    if (threshold > 0) {
      svg("rect", { x: sx(0), y: top, width: sx(threshold) - sx(0), height, fill: GRID }, box);
      text(box, sx(0) + 4, top - 6, "Displaced threshold", { fill: MUTED, "font-size": 11 });
    }
    svg("rect", { x: sx(threshold), y: top, width: sx(threshold + (r.tdzFt || 0)) - sx(threshold), height, fill: "var(--cairn-tidewater-blue)", "fill-opacity": 0.45 }, box);
    text(box, sx(threshold) + 4, top + height + 16, "Touchdown zone", { fill: MUTED, "font-size": 11 });
    svg("line", { x1: sx(0), x2: sx(r.lengthFt), y1: top + height / 2, y2: top + height / 2, stroke: MUTED, "stroke-dasharray": "10 8" }, box);
    if (Number.isFinite(r.slowAlong)) {
      svg("line", { x1: sx(r.slowAlong), x2: sx(r.slowAlong), y1: top - 4, y2: top + height + 4, stroke: TEXT, "stroke-width": 2 }, box);
      text(box, sx(r.slowAlong), top + height + 32, "Slowed to 30 kt", { "text-anchor": "middle", "font-size": 11 });
    }
    if (r.touchdown && Number.isFinite(r.touchdown.along)) {
      const x = sx(r.touchdown.along);
      const y = Math.max(top - 10, Math.min(top + height + 10, sy(r.touchdown.cross || 0)));
      svg("circle", { cx: x, cy: y, r: 6, fill: LINE, stroke: "var(--color-surface)", "stroke-width": 2 }, box);
      text(box, x, top - 22, `Touchdown, ${fmt(r.touchdown.along - threshold)} ft past the threshold`, { "text-anchor": "middle", "font-weight": 600 });
    }
    if (r.ident) text(box, sx(0) + 4, top + height / 2 + 4, r.ident, { "font-weight": 600 });
  }

  const FlightCharts = { track, approach, lineChart, timeChart, flight, runway, niceTicks };
  if (typeof module !== "undefined" && module.exports) module.exports = FlightCharts;
  if (root) root.FlightCharts = FlightCharts;
})(typeof window !== "undefined" ? window : null);
