'use strict';
// ============================================================================
// Validation of the Quick Chronology Checker workflow (src/engine/chronoChecker.js)
// + the dplR::chron port (src/stats/chron.js) against R.
//
// tools/chrono_checker_ground_truth.R replicates the exact server computation of
// R/chrono_checker_app.R on inst/extdata/undated_example.csv for sample
// "Sample_C" at several lags and emits the plotted DATA as JSON. This test runs
// chronoCheck on the same input and diffs every artifact element-wise (<= 1e-9;
// no nls path is exercised — detrending_select = 3 is Spline).
//
// Also confirms the standalone page's bundle (web/ringdater.bundle.js) loads the
// library and that chronoCheck's specs feed renderSvg to well-formed SVG.
// Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const { parseDelimited } = require('../src/io/csv.js');
const { chronoCheck } = require('../src/engine/chronoChecker.js');

const EXT = '/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata';
const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'chrono_checker_gt.json'), 'utf8'));
const TOL = 1e-9;
let anyFail = false;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
function cellEq(r, j) {
  if (r == null && j == null) return { ok: true, diff: 0 };
  if (r == null || j == null) return { ok: false, diff: Infinity };
  if (typeof r === 'string' || typeof j === 'string') return { ok: String(r) === String(j), diff: 0 };
  if (isNum(r) && isNum(j)) { const d = Math.abs(r - j); return { ok: d <= TOL, diff: d }; }
  return { ok: false, diff: Infinity };
}

function pass(label, ok, extra) {
  if (!ok) anyFail = true;
  console.log(`  ${label}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
}

// Compare two numeric arrays.
function cmpVec(label, R, J) {
  if (!Array.isArray(R) || !Array.isArray(J) || R.length !== J.length) {
    return pass(label, false, `len R ${R && R.length}/JS ${J && J.length}`);
  }
  let maxD = 0, mis = 0, first = '';
  for (let i = 0; i < R.length; i++) {
    const e = cellEq(R[i], J[i] === undefined ? null : J[i]);
    if (isFinite(e.diff)) maxD = Math.max(maxD, e.diff);
    if (!e.ok) { mis++; if (!first) first = `[${i}] R=${R[i]} JS=${J[i]}`; }
  }
  pass(label, mis === 0, `n ${R.length}  max|d| ${maxD.toExponential(2)}  mism ${mis}${first ? '  ' + first : ''}`);
}

// Compare a JS Frame against an R Frame, only for R columns whose name matches a
// JS column. Both sides carry an ignorable leading comb.NA placeholder column
// (R "rep.NA..1.", JS ""), skipped by name. P_Val columns use a looser tolerance
// (1e-6, as engine_test.js does): P_Val = cor.test p-value * correction, whose
// distribution-tail (pt) evaluation differs from R at the ~1e-12 relative level.
function cmpFrameByName(label, Rf, Jf) {
  let mis = 0, maxD = 0, detail = '';
  for (let jc = 0; jc < Jf.names.length; jc++) {
    const nm = Jf.names[jc];
    if (nm === '') continue;                        // combNA placeholder column
    const rc = Rf.names.indexOf(nm);
    if (rc < 0) { mis++; detail = detail || `JS col "${nm}" missing in R`; continue; }
    const tol = /P_Val$/.test(nm) ? 1e-6 : TOL;
    const Rcol = Rf.cols[rc], Jcol = Jf.cols[jc];
    if (Rcol.length !== Jcol.length) { mis++; detail = detail || `col "${nm}" len R ${Rcol.length}/JS ${Jcol.length}`; continue; }
    for (let r = 0; r < Rcol.length; r++) {
      const rv = Rcol[r], jv = Jcol[r] === undefined ? null : Jcol[r];
      let ok, diff;
      if (rv == null || jv == null) { ok = (rv == null && jv == null); diff = ok ? 0 : Infinity; }
      else if (isNum(rv) && isNum(jv)) { diff = Math.abs(rv - jv); ok = diff <= tol; }
      else { ok = String(rv) === String(jv); diff = 0; }
      if (isFinite(diff)) maxD = Math.max(maxD, diff);
      if (!ok) { mis++; if (!detail) detail = `[${nm} row ${r}] R=${rv} JS=${jv}`; }
    }
  }
  pass(label, mis === 0, `cols ${Jf.names.length}  max|d| ${maxD.toExponential(2)}  mism ${mis}${detail ? '  ' + detail : ''}`);
}

// ---- load the SAME CSV chronology as R (read.csv -> matching column names) ---
const csvText = fs.readFileSync(path.join(EXT, 'undated_example.csv'), 'utf8');
const frame = parseDelimited(csvText, { sep: ',', header: true });
const SELECTED = gt.selected;

// ---- summary table -----------------------------------------------------------
console.log('== summary table ==');
{
  const res = chronoCheck({ frame, selected: SELECTED, lag: 0, splinewindow: 21 });
  const st = res.summaryTable, gtS = gt.summary;
  pass('summary names', JSON.stringify(gtS.names) === JSON.stringify(st.names));
  cmpVec('summary Column_Name', gtS.cols[0], st.cols[0]);
  cmpVec('summary Start_Year', gtS.cols[1], st.cols[1]);
  cmpVec('summary End_Year', gtS.cols[2], st.cols[2]);
}

// ---- per-lag artifacts -------------------------------------------------------
for (const c of gt.cases) {
  console.log(`== lag ${c.lag} ==`);
  const res = chronoCheck({ frame, selected: SELECTED, lag: c.lag, splinewindow: 21 });

  // combined = cbind(chronology, detrended sample) — covers chronology mean + sample
  cmpFrameByName('combined', c.combined, res.combined);
  // detrended sample (sel_sample[,2]) and dplR::chron samp.depth (chron.js port)
  cmpVec('detrended_sample', c.detrended_sample, res.detrendedSample.cols[1]);
  cmpVec('chron samp.depth', c.chrono_depth, res.chronoDepth);

  // master lead-lag grid (compare the 7 named prefixed columns)
  cmpFrameByName('masterLeadLag', c.master, res.masterLeadLag);

  // running-correlation heatmap data {year, lag, "R val"}
  if (c.heat == null) {
    pass('heatmapData', res.heatmapData == null);
  } else {
    cmpFrameByName('heatmapData', c.heat, res.heatmapData);
  }

  // line plot data (series_1 black chronology, series_2 red lagged sample)
  cmpVec('line s1_x', c.line.s1_x, res.linePlotSpec.data.series_1.x);
  cmpVec('line s1_y', c.line.s1_y, res.linePlotSpec.data.series_1.y);
  cmpVec('line s2_x', c.line.s2_x, res.linePlotSpec.data.series_2.x);
  cmpVec('line s2_y', c.line.s2_y, res.linePlotSpec.data.series_2.y);

  // lead-lag bar data (T-values + best/2nd/3rd lags)
  cmpVec('bar lag', c.bar.lag, res.leadLagBarSpec.data.lag);
  cmpVec('bar T_val', c.bar.T_val, res.leadLagBarSpec.data.T_val);
  const bb = res.leadLagBarSpec.data;
  pass('bar best/2nd/3rd lag',
    (bb.best ? bb.best.lag : null) === c.bar.best_lag &&
    (bb.second ? bb.second.lag : null) === c.bar.second_lag &&
    (bb.third ? bb.third.lag : null) === c.bar.third_lag,
    `best ${bb.best && bb.best.lag}/${c.bar.best_lag}`);
}

// ---- standalone page: bundle loads + specs render to well-formed SVG ---------
console.log('== standalone bundle + renderSvg ==');
{
  const bundlePath = path.join(__dirname, '..', 'web', 'ringdater.bundle.js');
  const code = fs.readFileSync(bundlePath, 'utf8');
  const g = {};
  new Function('window', code)(g);           // emulate <script> load (window global)
  const RD = g.RD;
  const bframe = RD.parseDelimited(csvText, { sep: ',', header: true });
  const bres = RD.chronoCheck({ frame: bframe, selected: SELECTED, lag: 0, splinewindow: 21 });
  const svgs = [RD.renderSvg(bres.linePlotSpec), RD.renderSvg(bres.heatmapSpec), RD.renderSvg(bres.leadLagBarSpec)];
  const wellFormed = svgs.every(s => typeof s === 'string' && s.trim().startsWith('<svg') && s.trim().endsWith('</svg>') && s.length > 200);
  pass('bundle exposes chronoCheck + renderSvg -> 3 well-formed SVGs', wellFormed,
    `lens ${svgs.map(s => s.length).join('/')}`);
}

console.log(anyFail ? '\nFAIL' : '\nPASS: chronoCheck + chron() match R; standalone bundle renders SVG.');
process.exit(anyFail ? 1 : 0);
