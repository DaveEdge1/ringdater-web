'use strict';
// ============================================================================
// End-to-end validation of the orchestration engine (src/engine/*) against R.
// Loads the SAME bundled example data as tools/engine_ground_truth.R, runs
// pairwiseWorkflow + chronologyWorkflow with identical options, and diffs every
// artifact (detrended, cross_dat_res, filtered, aligned, prob_check, R_bar_EPS)
// element-wise. Also smoke-tests the store + actions reactive graph reproduce
// the workflow outputs. Nonzero exit on any mismatch.
//
// Acceptance: numeric artifacts match R to <= 1e-6; crossdate/flag/selection
// sets exact. (detrending_select = 3 is Spline — no nls path-diffs.)
// ============================================================================
const fs = require('fs');
const path = require('path');

const C = require('../src/analysis/comb.js');
const io = require('../src/io/load.js');
const { pairwiseWorkflow, chronologyWorkflow } = require('../src/engine/workflows.js');
const { createStore } = require('../src/engine/store.js');
const actions = require('../src/engine/actions.js');

const EXT = '/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata';
const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'engine_gt.json'), 'utf8'));
const TOL = 1e-6;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
let anyFail = false;

function cellEq(r, j) {
  if (r == null && j == null) return { ok: true, diff: 0 };
  if (r == null || j == null) return { ok: false, diff: Infinity };
  if (typeof r === 'string' || typeof j === 'string') return { ok: String(r) === String(j), diff: 0 };
  if (isNum(r) && isNum(j)) { const d = Math.abs(r - j); return { ok: d <= TOL, diff: d }; }
  return { ok: false, diff: Infinity };
}

// Element-wise Frame comparison (names + dims + every cell).
function compareFrame(label, R, J) {
  const nameOk = JSON.stringify(R.names) === JSON.stringify(J.names);
  const nrowR = R.cols.length ? R.cols[0].length : 0;
  const nrowJ = J.cols.length ? J.cols[0].length : 0;
  const dimOk = R.names.length === J.names.length && nrowR === nrowJ;
  let maxD = 0, mis = 0, cmp = 0;
  const detail = [];
  if (dimOk) {
    for (let c = 0; c < R.cols.length; c++) {
      for (let r = 0; r < nrowR; r++) {
        const e = cellEq(R.cols[c][r], J.cols[c][r] === undefined ? null : J.cols[c][r]);
        cmp++;
        if (isFinite(e.diff)) maxD = Math.max(maxD, e.diff);
        if (!e.ok) { mis++; if (detail.length < 6) detail.push(`    [${R.names[c]} row ${r}] R=${R.cols[c][r]} JS=${J.cols[c][r]}`); }
      }
    }
  }
  const pass = nameOk && dimOk && mis === 0;
  if (!pass) anyFail = true;
  console.log(`  ${label}: names ${nameOk ? 'OK' : 'DIFF'}  dims R ${nrowR}x${R.names.length}/JS ${nrowJ}x${J.names.length} ${dimOk ? 'OK' : 'DIFF'}  cmp ${cmp}  max|d| ${maxD.toExponential(2)}  mism ${mis}  => ${pass ? 'PASS' : 'FAIL'}`);
  if (detail.length) console.log(detail.join('\n'));
}

function compareProb(label, R, J) {
  const msgOk = (R.message == null ? null : R.message) === (J.message == null ? null : J.message);
  const sampOk = JSON.stringify(R.samples) === JSON.stringify(J.samples);
  const intOk = JSON.stringify(R.intervals) === JSON.stringify(J.intervals);
  const pass = msgOk && sampOk && intOk;
  if (!pass) anyFail = true;
  console.log(`  ${label}: message ${msgOk ? 'OK' : 'DIFF'}  samples ${sampOk ? 'OK' : 'DIFF'}  intervals ${intOk ? 'OK' : 'DIFF'}  => ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) console.log(`    R=${JSON.stringify(R)}\n    J=${JSON.stringify(J)}`);
}

// R R_bar_EPS frame cols: [mid.year, n.trees, n, rbar.tot, eps]; JS: array of objs.
function compareRbar(label, Rframe, Jrows) {
  const cols = Rframe.cols;
  const nrowR = cols.length ? cols[0].length : 0;
  const keys = ['midYear', 'nTrees', 'n', 'rbarTot', 'eps'];
  let mis = 0, maxD = 0;
  const dimOk = nrowR === Jrows.length && Rframe.names.length === 5;
  if (dimOk) {
    for (let r = 0; r < nrowR; r++) {
      for (let k = 0; k < 5; k++) {
        const e = cellEq(cols[k][r], Jrows[r][keys[k]]);
        if (isFinite(e.diff)) maxD = Math.max(maxD, e.diff);
        if (!e.ok) { mis++; if (mis <= 4) console.log(`    [${keys[k]} row ${r}] R=${cols[k][r]} JS=${Jrows[r][keys[k]]}`); }
      }
    }
  }
  const pass = dimOk && mis === 0;
  if (!pass) anyFail = true;
  console.log(`  ${label}: rows R ${nrowR}/JS ${Jrows.length} ${dimOk ? 'OK' : 'DIFF'}  max|d| ${maxD.toExponential(2)}  mism ${mis}  => ${pass ? 'PASS' : 'FAIL'}`);
}

// ---- load bundled example data via the JS loaders (same files as R) --------
const undated = io.loadUndated([{ name: 'undated_example.csv', text: fs.readFileSync(path.join(EXT, 'undated_example.csv'), 'utf8') }]);
const chron = io.loadChron({ name: 'dated_example_excel.xlsx', buffer: fs.readFileSync(path.join(EXT, 'dated_example_excel.xlsx')) });

const detrend = { detrending_select: 3, splinewindow: 21 };

// ============================================================================
// PAIRWISE
// ============================================================================
console.log('== pairwiseWorkflow (mode 1) ==');
const pw = pairwiseWorkflow({
  undated, detrend,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: 'sample_a' },
  probWind: 30, rbarWindow: 30,
});
compareFrame('detrended', gt.pairwise.detrended, pw.detrended);
compareFrame('crossDatRes', gt.pairwise.crossDatRes, pw.crossDatRes);
compareFrame('filtered', gt.pairwise.filtered, pw.filtered);
compareFrame('aligned', gt.pairwise.aligned, pw.aligned);
compareProb('probCheck', gt.pairwise.probCheck, pw.probCheck);
compareRbar('rBarEps', gt.pairwise.rBarEps, pw.rBarEps);

// ============================================================================
// CHRONOLOGY
// ============================================================================
console.log('== chronologyWorkflow (mode 2) ==');
const ch = chronologyWorkflow({
  undated, chron, detrend,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: false },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 40, target: 'mean_chronology' },
  probWind: 40, rbarWindow: 40,
});
compareFrame('detrended', gt.chronology.detrended, ch.detrended);
compareFrame('chronDetrended', gt.chronology.chronDetrended, ch.chronDetrended);
compareFrame('chronNSeries', gt.chronology.chronNSeries, ch.chronNSeries);
compareFrame('crossDatRes', gt.chronology.crossDatRes, ch.crossDatRes);
compareFrame('filtered', gt.chronology.filtered, ch.filtered);
compareFrame('alignedSeries', gt.chronology.alignedSeries, ch.alignedSeries);
compareFrame('aligned', gt.chronology.aligned, ch.aligned);
compareProb('probCheck', gt.chronology.probCheck, ch.probCheck);
compareRbar('rBarEps', gt.chronology.rBarEps, ch.rBarEps);

// ============================================================================
// STORE + ACTIONS reactive-graph smoke test: driving the store through the same
// sequence must reproduce the pure-workflow artifacts, and invalidation must
// null downstream slots.
// ============================================================================
console.log('== store + actions (reactive graph) ==');
const store = createStore({ actions });
store.dispatch('loadUndatedData', { files: [{ name: 'undated_example.csv', text: fs.readFileSync(path.join(EXT, 'undated_example.csv'), 'utf8') }] });
store.dispatch('loadChronData', { file: { name: 'dated_example_excel.xlsx', buffer: fs.readFileSync(path.join(EXT, 'dated_example_excel.xlsx')) } });
store.dispatch('runChronology', { detrend });                       // mode-2 detrend + chron_n_undated
const llRes = store.dispatch('runPairwise', { mode: 2, leadlag: { neg_lag: -20, pos_lag: 20, complete: false } });
const fa = store.dispatch('filterAndAlign', { mode: 2, filter: { r_val: 0.5, p_val: 0.05, overlap: 40, target: 'mean_chronology' } });
const sProb = store.dispatch('runProbCheck', { wind: 40 });
compareFrame('store chron_n_undated == workflow chronNSeries', ch.chronNSeries, store.getState().chron_n_undated);
compareFrame('store pairwise_res == workflow crossDatRes', ch.crossDatRes, llRes.crossDatRes);
compareFrame('store aligned == workflow aligned', ch.aligned, fa.aligned);
compareProb('store probCheck == workflow probCheck', ch.probCheck, sProb);

// invalidation: re-detrending mode 1 must null the mode-2 downstream slots.
store.dispatch('runDetrend', { detrend, mode: 1 });
const st = store.getState();
const invalOk = st.chron_n_undated === null && st.pairwise_res === null && st.quick_chron_aligned === null;
if (!invalOk) anyFail = true;
console.log(`  invalidation on re-detrend nulls downstream => ${invalOk ? 'PASS' : 'FAIL'}`);

console.log(anyFail ? '\nFAIL' : '\nPASS: engine workflows + store/actions match R end-to-end.');
process.exit(anyFail ? 1 : 0);
