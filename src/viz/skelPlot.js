'use strict';
// skelPlot — two-series skeleton-plot crossdating overlay (dplR skel.plot,
// re-cast as a comparison like the heatmap). series_1 ("master") marks point
// DOWN; series_2 ("sample") marks point UP with its position shifted by `lag`.
// Each mark is a ring narrower than its immediate neighbours; taller = relatively
// narrower (integer heights 3..10 from skelValues). When the two series crossdate
// at `lag`, the up- and down-marks line up vertically.
//
// LAYOUT: like dplR (and paper skeleton plots), the year axis is wrapped into
// decade-aligned ROWS of `rowYears` (default 120, dplR's row width) at a fixed
// pixels-per-year scale, one panel per row — a multi-century series stays
// readable instead of compressing ~300 years into one strip. Panel k spans
// [row0 + k*rowYears, row0 + (k+1)*rowYears), row0 padded down to the decade.
//
// Frame convention matches linePlot/heatmapPlot: col 0 is the year/position axis,
// series columns by name; `lag` shifts series_2 onto the crossdate alignment.
//
// IMPORTANT: pass RAW measurements (ring widths, or a positive RWI chronology),
// not detrended series — dplR's skeleton maths normalises internally by the
// hanning-smoothed local mean and assumes positive values (see analysis/skel.js).
// Callers holding only a detrended comparison frame should swap raw columns in
// (see appCore.skelFrame).

const C = require('../analysis/comb.js');
const { skelValues } = require('../analysis/skel.js');
const { toSVG } = require('./render.js');

function seriesArray(frame, name) {
  const c = C.colByName(frame, name);
  if (c === undefined) throw new Error(`Error in skel_plot(). ${name} can not be found in the loaded data.`);
  return c.map(v => (C.isNA(v) ? NaN : +v));
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
  const sk1 = skelValues(seriesArray(f, series1Nm), fw);
  const sk2 = skelValues(seriesArray(f, series2Nm), fw);

  const master = [], sample = [];
  for (let i = 0; i < sk1.length; i++) if (!Number.isNaN(sk1[i])) master.push({ x: yr[i], h: sk1[i] });
  for (let i = 0; i < sk2.length; i++) if (!Number.isNaN(sk2[i])) sample.push({ x: yr[i] + lag, h: sk2[i] });

  const allX = master.concat(sample).map(p => p.x);
  const xLo = allX.length ? Math.min(...allX) : 0;
  const xHi = allX.length ? Math.max(...allX) : 1;
  const row0 = Math.floor(xLo / 10) * 10;                          // pad down to the decade
  const nRows = Math.max(1, Math.ceil((xHi + 1 - row0) / rowYears));

  const rowOpts = {
    width,
    title: `${series1Nm} (down) vs ${series2Nm} (up) — skeleton plot, lag ${lag}`,
    legend: { entries: [{ label: `${series1Nm} (down)`, color: '#2c7fb8' }, { label: `${series2Nm} (up)`, color: '#c0392b' }] },
  };
  const panels = [];
  for (let k = 0; k < nRows; k++) {
    panels.push(rowPanel(row0 + k * rowYears, row0 + (k + 1) * rowYears, master, sample, k === 0, rowOpts));
  }

  return {
    type: 'skelPlot',
    width,
    height: panels.reduce((a, p) => a + p.height, 0),
    title: rowOpts.title,
    panels,
    data: { skel_1: sk1, skel_2: sk2, lag },
  };
}

module.exports = { skelPlot, toSVG };
