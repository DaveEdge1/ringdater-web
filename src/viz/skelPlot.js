'use strict';
// skelPlot — two-series skeleton-plot crossdating overlay (dplR skel.plot,
// re-cast as a comparison like the heatmap). series_1 ("master") marks point
// DOWN; series_2 ("sample") marks point UP with its position shifted by `lag`.
// Each mark is a ring narrower than its immediate neighbours; taller = relatively
// narrower (integer heights 3..10 from skelValues). When the two series crossdate
// at `lag`, the up- and down-marks line up vertically.
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
const { toSVG, roundR } = require('./render.js');
const { xScaleBar } = require('./chartUtils.js');

function seriesArray(frame, name) {
  const c = C.colByName(frame, name);
  if (c === undefined) throw new Error(`Error in skel_plot(). ${name} can not be found in the loaded data.`);
  return c.map(v => (C.isNA(v) ? NaN : +v));
}

function skelPlot(theData, series1Nm, series2Nm, lag = 0, opts = {}) {
  const f = C.asFrame(theData);
  if (C.ncol(f) <= 2) throw new Error('Error in skel_plot(). Insufficient data.');
  if (lag % 1 !== 0) throw new Error('Error in skel_plot(). lag should be a numeric integer.');
  const fw = opts.filt_weight != null ? opts.filt_weight : 9;
  const yr = C.col(f, 0).map(Number);
  const sk1 = skelValues(seriesArray(f, series1Nm), fw);
  const sk2 = skelValues(seriesArray(f, series2Nm), fw);

  const mx0 = [], my1 = [], sx0 = [], sy1 = [];
  for (let i = 0; i < sk1.length; i++) if (!Number.isNaN(sk1[i])) { mx0.push(yr[i]); my1.push(-sk1[i]); }
  for (let i = 0; i < sk2.length; i++) if (!Number.isNaN(sk2[i])) { sx0.push(yr[i] + lag); sy1.push(sk2[i]); }

  const allX = mx0.concat(sx0);
  const xLo = allX.length ? Math.min(...allX) : 0;
  const xHi = allX.length ? Math.max(...allX) : 1;

  const spec = {
    type: 'skelPlot',
    width: opts.width || 760,
    height: opts.height || 230,
    title: `${series1Nm} (down) vs ${series2Nm} (up) — skeleton plot, lag ${lag}`,
    xLabel: 'Year / position',
    yLabel: 'Skeleton height',
    scales: {
      x: { domain: [xLo, xHi], breaks: xScaleBar(roundR(xLo, -1), roundR(xHi, -1)) },
      y: { domain: [-10.5, 10.5], breaks: [-10, -5, 0, 5, 10] },
    },
    marks: [
      { type: 'segment', x0: [xLo], x1: [xHi], y0: [0], y1: [0], color: '#bbb', width: 1 },
      { type: 'segment', x0: mx0, x1: mx0.slice(), y0: mx0.map(() => 0), y1: my1, color: '#2c7fb8', width: 2 },
      { type: 'segment', x0: sx0, x1: sx0.slice(), y0: sx0.map(() => 0), y1: sy1, color: '#c0392b', width: 2 },
    ],
    legend: { entries: [{ label: `${series1Nm} (down)`, color: '#2c7fb8' }, { label: `${series2Nm} (up)`, color: '#c0392b' }] },
    colourbar: null,
    data: { skel_1: sk1, skel_2: sk2, lag },
  };
  return spec;
}

module.exports = { skelPlot, toSVG };
