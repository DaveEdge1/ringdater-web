'use strict';
// heatmapPlot — running-correlation raster (port of R/plotting_sing_hm_function.R).
// Input `plotData` is the {year, lag, "R val"} Frame from runningLeadLag /
// heatmapAnalysis. x = year, y = lag, fill = R interpolated across col_pal(sel)
// clamped to [-1,1]. x breaks from x.scale.bar (rounded year range), y breaks
// from y.scale.bar (lag range).

const C = require('../analysis/comb.js');
const { xScaleBar, yScaleBar, colPal } = require('./chartUtils.js');
const { toSVG, roundR, valueToColor } = require('./render.js');

function extent(xs) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < xs.length; i++) { if (xs[i] < lo) lo = xs[i]; if (xs[i] > hi) hi = xs[i]; }
  return [lo, hi];
}

function heatmapPlot(plotData, opts = {}) {
  if (plotData == null) throw new Error('Insufficient overlap to perform running correlation analysis');
  const s1 = opts.s1, s2 = opts.s2;
  const selColPal = opts.sel_col_pal != null ? opts.sel_col_pal : 1;
  const colScale = colPal(selColPal);

  let year = C.col(plotData, 0).map(Number);
  let lag = C.col(plotData, 1).map(Number);
  let rval = C.col(plotData, 2).map(v => (C.isNA(v) ? null : +v));

  // opts.lagRange [lo, hi]: draw only the lags in that window, on a lag axis
  // that is exactly the window (not the lags in it that correlated). The year
  // axis follows the cells that are left: it is a zoom, and against a long
  // master a short series overlaps only a strip of the years at any one lag —
  // on the whole analysis's year axis that strip is a sliver.
  let lagLo = null, lagHi = null;
  if (opts.lagRange) {
    lagLo = Number(opts.lagRange[0]); lagHi = Number(opts.lagRange[1]);
    const keep = [];
    for (let i = 0; i < lag.length; i++) if (lag[i] >= lagLo && lag[i] <= lagHi) keep.push(i);
    if (!keep.length) throw new Error('No lag in ' + lagLo + '…' + lagHi + ' has enough overlap to correlate');
    year = keep.map(i => year[i]); lag = keep.map(i => lag[i]); rval = keep.map(i => rval[i]);
  }

  // A loop, not Math.min(...xs): a long chronology scanned over every lag is
  // millions of cells, and spreading that many arguments overflows the stack.
  const [yMin, yMax] = extent(year);
  let [lMin, lMax] = extent(lag);
  if (lagLo != null) { lMin = lagLo; lMax = lagHi; }
  const colors = rval.map(v => valueToColor(v, colScale, [-1, 1]));

  const spec = {
    type: 'heatmapPlot',
    width: opts.width || 760,
    height: opts.height || 340,
    title: `${s1} vs ${s2}`,
    xLabel: 'Year',
    yLabel: `lag (years from ${s1})`,
    scales: {
      x: { domain: [yMin, yMax], breaks: xScaleBar(roundR(yMin, -1), roundR(yMax, -1)) },
      y: { domain: [lMin, lMax], breaks: yScaleBar(lMin, lMax) },
    },
    marks: [{ type: 'raster', x: year, y: lag, fill: rval, colors }],
    legend: null,
    colourbar: { colors: colScale, limits: [-1, 1], label: 'Correl. (R)' },
    data: { year, lag, R: rval },
  };
  return spec;
}

module.exports = { heatmapPlot, toSVG };
