'use strict';
// Parity test for the six RingdateR plot builders (Phase 4 viz). For each plot
// we assert the builder reproduces the DATA R would plot (ground truth from
// tools/plots_ground_truth.R, which sources the real ringdater functions), and
// that toSVG() returns a well-formed non-empty <svg>. Layout/pixels are NOT
// checked — data + structure + colours are. Nonzero exit on failure.

const fs = require('fs');
const path = require('path');
const { linePlot } = require('../src/viz/linePlot.js');
const { datedLinePlot } = require('../src/viz/datedLinePlot.js');
const { allSeries } = require('../src/viz/allSeries.js');
const { heatmapPlot } = require('../src/viz/heatmapPlot.js');
const { detrendPlot } = require('../src/viz/detrendPlot.js');
const { leadLagBar } = require('../src/viz/leadLagBar.js');
const { toSVG } = require('../src/viz/render.js');
const { runningLeadLag } = require('../src/analysis/runningLeadLag.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'plots_gt.json'), 'utf8'));

let anyFail = false;
const num = v => (v === null || v === undefined ? NaN : +v);

// max abs diff of two numeric arrays (NA===null matches NA); Infinity on shape/NA mismatch.
function maxDiff(R, J) {
  if (R.length !== J.length) return Infinity;
  let m = 0;
  for (let i = 0; i < R.length; i++) {
    const a = num(R[i]), b = num(J[i]);
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (Number.isNaN(a) !== Number.isNaN(b)) return Infinity;
    const d = Math.abs(a - b);
    if (d > m) m = d;
  }
  return m;
}
function check(name, R, J, tol) {
  const d = maxDiff(R, J);
  const ok = d <= tol;
  if (!ok) anyFail = true;
  console.log('  ' + name.padEnd(34), (Number.isFinite(d) ? d.toExponential(3) : 'inf').padStart(12),
    ('n=' + J.length).padStart(8), ok ? 'PASS' : 'FAIL');
  return ok;
}
function checkStr(name, R, J) {
  const ok = JSON.stringify(R) === JSON.stringify(J);
  if (!ok) anyFail = true;
  console.log('  ' + name.padEnd(34), (ok ? 'match' : 'DIFFER').padStart(12), ' '.padStart(8), ok ? 'PASS' : 'FAIL');
  return ok;
}
function svgOk(name, spec) {
  const s = toSVG(spec);
  const ok = typeof s === 'string' && /^<svg[\s\S]*<\/svg>$/.test(s.trim()) && s.length > 100;
  if (!ok) anyFail = true;
  console.log('  ' + ('toSVG ' + name).padEnd(34), (s ? s.length + ' chars' : 'empty').padStart(12), ' '.padStart(8), ok ? 'PASS' : 'FAIL');
}
const TOL = 1e-9, TOL_DET = 1e-6;

// ---- line_plot --------------------------------------------------------------
console.log('linePlot:');
{
  const c = gt.line;
  const spec = linePlot(c.input, c.s1, c.s2, c.lag);
  check('series_1.x', c.series_1.x, spec.data.series_1.x, TOL);
  check('series_1.y', c.series_1.y, spec.data.series_1.y, TOL);
  check('series_2.x (shifted +lag)', c.series_2.x, spec.data.series_2.x, TOL);
  check('series_2.y', c.series_2.y, spec.data.series_2.y, TOL);
  svgOk('linePlot', spec);
}

// ---- dated_line_plot --------------------------------------------------------
console.log('datedLinePlot:');
{
  const c = gt.dated;
  const spec = datedLinePlot(c.input);
  checkStr('res.names', c.res.names, spec.data.res.names);
  checkStr('res.name.val', c.res.cols[0], spec.data.res.cols[0]);
  check('res.samp.val', c.res.cols[1], spec.data.res.cols[1], TOL);
  check('res.dates', c.res.cols[2], spec.data.res.cols[2], TOL);
  svgOk('datedLinePlot', spec);
}

// ---- plot_all_series --------------------------------------------------------
console.log('allSeries:');
{
  const c = gt.allseries;
  const spec = allSeries(c.input);
  check('mean chronology x', c.mean.x, spec.data.meanChronology.x, TOL);
  check('mean chronology y', c.mean.y, spec.data.meanChronology.y, TOL);
  for (let i = 0; i < c.series.length; i++) {
    check('series[' + i + '].x', c.series[i].x, spec.data.series[i].x, TOL);
    check('series[' + i + '].y', c.series[i].y, spec.data.series[i].y, TOL);
  }
  svgOk('allSeries', spec);
}

// ---- heatmap (running_lead_lag plot.data through the builder) ---------------
console.log('heatmapPlot:');
{
  const c = gt.heat;
  const J = runningLeadLag(c.input, { s1: c.s1, s2: c.s2, neg_lag: c.neg, pos_lag: c.pos, win: c.win, complete: c.complete });
  const spec = heatmapPlot(J, { s1: c.s1, s2: c.s2, sel_col_pal: 1 });
  const pd = c.plotdata;
  check('plot.data year (x)', pd.cols[0], spec.data.year, TOL);
  check('plot.data lag (y)', pd.cols[1], spec.data.lag, TOL);
  check('plot.data R (fill)', pd.cols[2], spec.data.R, TOL);
  // fill colours are non-null hex where R is present, and clamp-diverging
  const okColors = spec.marks[0].colors.every((col, i) => spec.data.R[i] == null || /^#[0-9a-f]{6}$/.test(col));
  if (!okColors) anyFail = true;
  console.log('  ' + 'raster colours (colPal hex)'.padEnd(34), (okColors ? 'ok' : 'bad').padStart(12), ' '.padStart(8), okColors ? 'PASS' : 'FAIL');
  svgOk('heatmapPlot', spec);
}

// ---- detrending plot (3 panels) ---------------------------------------------
console.log('detrendPlot:');
for (const c of gt.detrend) {
  const tag = 'm' + c.method;
  const spec = detrendPlot(c.input, c.series, { detrending_select: c.method, splinewindow: c.sw });
  check(tag + ' curve y', c.curve.cols[1], spec.data.curve.y, TOL_DET);
  check(tag + ' detrended y', c.detrended.cols[1], spec.data.detrended.y, TOL_DET);
  check(tag + ' rawAuto r (lag0..10)', c.rawAuto.cols[1], spec.data.rawAuto.r, TOL_DET);
  check(tag + ' detAuto r (lag0..10)', c.detAuto.cols[1], spec.data.detAuto.r, TOL_DET);
  check(tag + ' autocorr lag axis', c.rawAuto.cols[0], spec.data.rawAuto.lag, TOL);
  svgOk('detrendPlot ' + tag, spec);
}

// ---- lead_lag_bar -----------------------------------------------------------
console.log('leadLagBar:');
{
  const c = gt.bar;
  const spec = leadLagBar(c.master, c.s1, c.s2);
  check('selected lag', c.lag, spec.data.lag, TOL);
  check('selected T_val', c.T_val, spec.data.T_val, TOL);
  check('best lag (rank 1 -> red)', [c.best_lag], [spec.data.best.lag], TOL);
  check('second lag (rank 2 -> blue)', [c.second_lag], [spec.data.second.lag], TOL);
  check('third lag (rank 3 -> green)', [c.third_lag], [spec.data.third.lag], TOL);
  // colour assignment: best/2nd/3rd rows carry red/blue/green, rest black
  const cols = spec.data.colors;
  const okC = cols.filter(x => x === 'red').length === 1 && cols.filter(x => x === 'blue').length === 1 &&
    cols.filter(x => x === 'green').length === 1;
  if (!okC) anyFail = true;
  console.log('  ' + 'bar colours red/blue/green'.padEnd(34), (okC ? 'ok' : 'bad').padStart(12), ' '.padStart(8), okC ? 'PASS' : 'FAIL');
  svgOk('leadLagBar', spec);
}

console.log(anyFail ? '\nFAIL' : '\nPASS: all six plot builders reproduce R plot data + emit well-formed SVG.');
process.exit(anyFail ? 1 : 0);
