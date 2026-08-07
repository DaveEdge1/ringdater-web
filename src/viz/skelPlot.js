'use strict';
// skelPlot — two-series skeleton-plot crossdating overlay (dplR skel.plot,
// re-cast as a comparison like the heatmap). series_1 ("master") marks point
// DOWN; series_2 ("sample") marks point UP with its position shifted by `lag`.
// Each mark is a ring narrower than its immediate neighbours; taller = relatively
// narrower. When the two series crossdate at `lag`, the up- and down-marks line
// up vertically.
//
// WINDOW: only the interval where the two series' data OVERLAP (after the lag
// shift) is plotted, extended by 10% of the overlap length on either end —
// that's the region where marks can actually be compared.
//
// MARK SELECTION (a deliberate adjustment of dplR's rescale for the two-series
// comparison): dplR maps relative growth linearly from its own min..max and
// keeps values >= 3 of 10. That is fine for one raw series, but a single
// extreme value — e.g. a near-zero divisor epoch in a long mean chronology —
// compresses every other narrow ring below the threshold (observed: 1 mark in
// 1506 years). Here each series marks its top-k narrowest rings within the
// window, where k is the LARGER of the two series' dplR mark counts (so the
// sparser side is topped up to a comparable density), and heights are assigned
// by rank (narrowest -> 10 down to 3), which no outlier can flatten. The
// dplR-faithful per-ring values remain available via skelValues (spec.data).
//
// LAYOUT: like dplR (and paper skeleton plots), the window is wrapped into
// decade-aligned ROWS of `rowYears` (default 120, dplR's row width) at a fixed
// pixels-per-year scale, one panel per row.
//
// Frame convention matches linePlot/heatmapPlot: col 0 is the year/position axis,
// series columns by name; `lag` shifts series_2 onto the crossdate alignment.
//
// IMPORTANT: pass RAW measurements (ring widths, or a positive RWI chronology),
// not detrended series — the skeleton maths normalises internally by the
// hanning-smoothed local mean and assumes positive values (see analysis/skel.js).
// Callers holding only a detrended comparison frame should swap raw columns in
// (see appCore.skelFrame).

const C = require('../analysis/comb.js');
const { skelValues, skelGrowth } = require('../analysis/skel.js');
const { toSVG } = require('./render.js');

function seriesArray(frame, name) {
  const c = C.colByName(frame, name);
  if (c === undefined) throw new Error(`Error in skel_plot(). ${name} can not be found in the loaded data.`);
  return c.map(v => (C.isNA(v) ? NaN : +v));
}

// [min,max] x-positions where the series has data, or null if none.
function dataSpan(vals, yr, shift) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    if (Number.isNaN(vals[i])) continue;
    const x = yr[i] + shift;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return lo <= hi ? [lo, hi] : null;
}

// dplR's mark count over a candidate set: linear min..max rescale to 10..1,
// count values that survive the >= 3 threshold.
function dplrCount(cand) {
  if (!cand.length) return 0;
  let mn = Infinity, mx = -Infinity;
  for (const c of cand) { if (c.v < mn) mn = c.v; if (c.v > mx) mx = c.v; }
  const mult = (1 - 10) / ((mx - mn) || 1);
  let n = 0;
  for (const c of cand) if (10 + (c.v - mn) * mult >= 3) n++;
  return n;
}

// Top-k narrowest candidates with rank-based heights (narrowest -> 10 ... 3).
function topKMarks(cand, k) {
  if (k <= 0 || !cand.length) return [];
  const sorted = cand.slice().sort((a, b) => a.v - b.v).slice(0, Math.min(k, cand.length));
  const n = sorted.length;
  return sorted.map((c, r) => ({
    x: c.x,
    h: n === 1 ? 10 : Math.ceil(3 + 7 * (n - 1 - r) / (n - 1)),
  }));
}

// Per-panel mark order is FIXED (tests rely on it):
//   [0] decade grid, [1] baseline, [2] master (down), [3] sample (up)
function rowPanel(start, end, master, sample, first, opts) {
  const grid = [];
  for (let g = start; g <= end; g += 10) grid.push(g);
  const m = master.filter(p => p.x >= start && p.x < end);
  const s = sample.filter(p => p.x >= start && p.x < end);
  const breaks = [];
  for (let b = start; b <= end; b += 20) breaks.push(b);
  return {
    type: 'skelPlotRow',
    width: opts.width,
    height: first ? 150 : 120,
    title: first ? opts.title : null,
    xLabel: null,
    yLabel: first ? 'Skeleton height' : null,
    scales: {
      x: { domain: [start, end], breaks },
      y: { domain: [-10.5, 10.5], breaks: [-10, -5, 0, 5, 10] },
    },
    marks: [
      { type: 'segment', x0: grid, x1: grid.slice(), y0: grid.map(() => -10.5), y1: grid.map(() => 10.5), color: '#e4e4e4', width: 1 },
      { type: 'segment', x0: [start], x1: [end], y0: [0], y1: [0], color: '#bbb', width: 1 },
      { type: 'segment', x0: m.map(p => p.x), x1: m.map(p => p.x), y0: m.map(() => 0), y1: m.map(p => -p.h), color: '#2c7fb8', width: 2 },
      { type: 'segment', x0: s.map(p => p.x), x1: s.map(p => p.x), y0: s.map(() => 0), y1: s.map(p => p.h), color: '#c0392b', width: 2 },
    ],
    legend: first ? opts.legend : null,
    colourbar: null,
  };
}

function skelPlot(theData, series1Nm, series2Nm, lag = 0, opts = {}) {
  const f = C.asFrame(theData);
  if (C.ncol(f) <= 2) throw new Error('Error in skel_plot(). Insufficient data.');
  if (lag % 1 !== 0) throw new Error('Error in skel_plot(). lag should be a numeric integer.');
  const fw = opts.filt_weight != null ? opts.filt_weight : 9;
  const rowYears = opts.rowYears != null ? opts.rowYears : 120;   // dplR: 120 yr/row
  const width = opts.width || 760;
  const yr = C.col(f, 0).map(Number);
  const s1 = seriesArray(f, series1Nm);
  const s2 = seriesArray(f, series2Nm);
  const g1 = skelGrowth(s1, fw);
  const g2 = skelGrowth(s2, fw);

  // plot window: data overlap (after lag), extended 10% each side; if the two
  // series never overlap at this lag, fall back to the union of their spans.
  const sp1 = dataSpan(s1, yr, 0);
  const sp2 = dataSpan(s2, yr, lag);
  let lo = 0, hi = 1;
  if (sp1 && sp2) {
    lo = Math.max(sp1[0], sp2[0]); hi = Math.min(sp1[1], sp2[1]);
    if (lo > hi) { lo = Math.min(sp1[0], sp2[0]); hi = Math.max(sp1[1], sp2[1]); }
  } else if (sp1 || sp2) { [lo, hi] = sp1 || sp2; }
  const ext = Math.round(0.1 * (hi - lo + 1));
  const winLo = lo - ext, winHi = hi + ext;

  // candidate narrow rings inside the window
  const cand1 = [], cand2 = [];
  for (let i = 0; i < g1.length; i++) {
    if (!Number.isNaN(g1[i]) && yr[i] >= winLo && yr[i] <= winHi) cand1.push({ x: yr[i], v: g1[i] });
  }
  for (let i = 0; i < g2.length; i++) {
    const x = yr[i] + lag;
    if (!Number.isNaN(g2[i]) && x >= winLo && x <= winHi) cand2.push({ x, v: g2[i] });
  }

  // density matching: both series mark the larger of the two dplR mark counts
  const k = Math.max(dplrCount(cand1), dplrCount(cand2));
  const master = topKMarks(cand1, k);
  const sample = topKMarks(cand2, k);

  const row0 = Math.floor(winLo / 10) * 10;                        // pad down to the decade
  const nRows = Math.max(1, Math.ceil((winHi + 1 - row0) / rowYears));

  const rowOpts = {
    width,
    title: `${series1Nm} (down) vs ${series2Nm} (up) — skeleton plot, lag ${lag}`,
    legend: { entries: [{ label: `${series1Nm} (down)`, color: '#2c7fb8' }, { label: `${series2Nm} (up)`, color: '#c0392b' }] },
  };
  const panels = [];
  for (let p = 0; p < nRows; p++) {
    panels.push(rowPanel(row0 + p * rowYears, row0 + (p + 1) * rowYears, master, sample, p === 0, rowOpts));
  }

  return {
    type: 'skelPlot',
    width,
    height: panels.reduce((a, p) => a + p.height, 0),
    title: rowOpts.title,
    panels,
    data: {
      skel_1: skelValues(s1, fw), skel_2: skelValues(s2, fw), lag,
      overlap: [lo, hi], window: [winLo, winHi], marksPerSeries: k,
    },
  };
}

module.exports = { skelPlot, toSVG };
