'use strict';
// heatmapPlot — running-correlation raster (port of R/plotting_sing_hm_function.R).
// Input `plotData` is the {year, lag, "R val"} Frame from runningLeadLag /
// heatmapAnalysis. x = year, y = lag, fill = R interpolated across col_pal(sel)
// clamped to [-1,1]. x breaks from x.scale.bar (rounded year range), y breaks
// from y.scale.bar (lag range).

const C = require('../analysis/comb.js');
const { xScaleBar, yScaleBar, colPal } = require('./chartUtils.js');
const { toSVG, roundR, valueToColor } = require('./render.js');

function heatmapPlot(plotData, opts = {}) {
  if (plotData == null) throw new Error('Insufficient overlap to perform running correlation analysis');
  const s1 = opts.s1, s2 = opts.s2;
  const selColPal = opts.sel_col_pal != null ? opts.sel_col_pal : 1;
  const colScale = colPal(selColPal);

  const year = C.col(plotData, 0).map(Number);
  const lag = C.col(plotData, 1).map(Number);
  const rval = C.col(plotData, 2).map(v => (C.isNA(v) ? null : +v));
  const colors = rval.map(v => valueToColor(v, colScale, [-1, 1]));

  const yMin = Math.min(...year), yMax = Math.max(...year);
  const lMin = Math.min(...lag), lMax = Math.max(...lag);

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
