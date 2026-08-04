'use strict';
// detrendPlot — 3 stacked panels (port of R/detrending_plot_function.R):
//   1. raw series (alpha 0.75) + the fitted detrending curve (thick black)
//   2. detrended series (red)
//   3. autocorrelation of raw (black) vs detrended (red), lags 0..10
// Reuses the already-R-validated analysis: normalise, detcurves, autoCorrel.
// Composes three sub-specs vertically via the shared renderer.

const C = require('../analysis/comb.js');
const { normalise } = require('../detrend/normalise.js');
const { detcurves } = require('../detrend/detcurves.js');
const { autoCorrel } = require('../analysis/autoCorrel.js');
const { xScaleBar } = require('./chartUtils.js');
const { toSVG } = require('./render.js');

function completeXY(xs, ys) {
  const x = [], y = [];
  for (let i = 0; i < xs.length; i++) if (!C.isNA(xs[i]) && !C.isNA(ys[i])) { x.push(+xs[i]); y.push(+ys[i]); }
  return { x, y };
}
function rangeOf(a) { return [Math.min(...a), Math.max(...a)]; }

function detrendPlot(undetData, firstSeries, opts = {}) {
  const detrending_select = opts.detrending_select != null ? opts.detrending_select : 3;
  const splinewindow = opts.splinewindow != null ? opts.splinewindow : 21;
  const ARmod = !!opts.ARmod, logT = !!opts.logT;

  const f = C.asFrame(undetData);
  const years = C.col(f, 0);
  const vals = C.colByName(f, firstSeries);
  if (vals === undefined) throw new Error('Error in detrending.plot.fun: first_series must be a valid sample ID');

  // undet.data = complete cases of (year, value)  -> a 2-column Frame
  const cc = completeXY(years, vals);
  const undet = { names: [f.names[0], firstSeries], cols: [cc.x.slice(), cc.y.slice()] };

  const detNd = normalise(undet, { detrending_select, splinewindow, ARmod, logT });
  const curve = detcurves(undet, { detrending_select, splinewindow });
  const rawAuto = autoCorrel(undet);
  const detAut = autoCorrel(detNd);

  const detX = C.col(detNd, 0).map(Number), detY = C.col(detNd, 1);
  const curveX = C.col(curve, 0).map(Number), curveY = C.col(curve, 1);
  const acLag = C.col(rawAuto, 0).map(Number);
  const rawAc = C.col(rawAuto, 1), detAc = C.col(detAut, 1);

  const W = opts.width || 760, H = opts.panelHeight || 200;
  const xBreaks = xScaleBar(Math.min(...cc.x), Math.max(...cc.x));
  const xDom = rangeOf(cc.x);

  const p1 = {
    type: 'detrend_raw', width: W, height: H,
    title: `${firstSeries} raw data. Thick black line = the detrending curve applied`,
    xLabel: 'Increment number', yLabel: 'Increment width',
    scales: { x: { domain: xDom, breaks: xBreaks }, y: { domain: rangeOf(cc.y.concat(curveY.filter(v => !C.isNA(v)))), breaks: null } },
    marks: [
      { type: 'line', x: cc.x, y: cc.y, color: 'black', width: opts.plot_line || 1, alpha: 0.75 },
      { type: 'line', x: curveX, y: curveY, color: 'black', width: (opts.plot_line || 1) + 0.5 },
    ],
    legend: null, colourbar: null,
  };
  const detYnum = detY.filter(v => !C.isNA(v)).map(Number);
  const p2 = {
    type: 'detrend_detrended', width: W, height: H,
    title: 'Detrended data', xLabel: 'Increment number', yLabel: 'Increment width',
    scales: { x: { domain: xDom, breaks: xBreaks }, y: { domain: rangeOf(detYnum), breaks: null } },
    marks: [{ type: 'line', x: detX, y: detY, color: 'red', width: opts.plot_line || 1 }],
    legend: null, colourbar: null,
  };
  const acAll = rawAc.concat(detAc).filter(v => !C.isNA(v)).map(Number);
  const p3 = {
    type: 'detrend_autocorr', width: W, height: H,
    title: 'Black line = raw data auto correlation; Red line = detrended data autocorrelation',
    xLabel: 'lag (Year)', yLabel: 'Correl. (R)',
    scales: { x: { domain: [0, 10], breaks: Array.from({ length: 11 }, (_, i) => i) }, y: { domain: rangeOf(acAll), breaks: null } },
    marks: [
      { type: 'line', x: acLag, y: rawAc, color: 'black', width: opts.plot_line || 1 },
      { type: 'line', x: acLag, y: detAc, color: 'red', width: opts.plot_line || 1 },
    ],
    legend: null, colourbar: null,
  };

  return {
    type: 'detrendPlot',
    width: W,
    height: H * 3,
    panels: [p1, p2, p3],
    data: {
      curve: { x: curveX, y: curveY },
      detrended: { x: detX, y: detY },
      rawAuto: { lag: acLag, r: rawAc },
      detAuto: { lag: acLag, r: detAc },
    },
  };
}

module.exports = { detrendPlot, toSVG };
