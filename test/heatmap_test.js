'use strict';
// Parity test for the running-correlation heatmap data generators (T1.6):
//   src/analysis/runningLeadLag.js  vs R ringdater::running_lead_lag
//   src/analysis/heatmap.js         vs R heatmap_analysis data step (plot.data)
// Ground truth: tools/heatmap_ground_truth.R (sources the ACTUAL R functions +
// zoo::rollmean). Compares the {year, lag, "R val"} Frames element-wise, and
// checks the nrow<15 -> null guard. Nonzero exit on failure.

const fs = require('fs');
const path = require('path');
const { runningLeadLag } = require('../src/analysis/runningLeadLag.js');
const { heatmapAnalysis } = require('../src/analysis/heatmap.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'heatmap_gt.json'), 'utf8'));
const TOL = 1e-10;

const RLL_CASES = [
  { key: 'AB_cF',      s1: 'A', s2: 'B', neg_lag: -20, pos_lag: 20, win: 21, complete: false },
  { key: 'AB_cT',      s1: 'A', s2: 'B', neg_lag: -20, pos_lag: 20, win: 21, complete: true },
  { key: 'AC_cF_even', s1: 'A', s2: 'C', neg_lag: -15, pos_lag: 15, win: 20, complete: false },
  { key: 'BD_cT',      s1: 'B', s2: 'D', neg_lag: -30, pos_lag: 30, win: 31, complete: true },
  { key: 'AD_cF_asym', s1: 'A', s2: 'D', neg_lag: -10, pos_lag: 40, win: 15, complete: false },
  { key: 'AG_null',    s1: 'A', s2: 'G', neg_lag: -5,  pos_lag: 5,  win: 21, complete: false },
];
const HEAT_CASES = [
  { key: 'AB_c0',   s1: 'A', s2: 'B', neg_lag: -20, pos_lag: 20, win: 21, center: 0,   complete: false },
  { key: 'AB_c5',   s1: 'A', s2: 'B', neg_lag: -20, pos_lag: 20, win: 21, center: 5,   complete: false },
  { key: 'AC_cm10', s1: 'A', s2: 'C', neg_lag: -15, pos_lag: 15, win: 21, center: -10, complete: false },
  { key: 'BD_c0T',  s1: 'B', s2: 'D', neg_lag: -20, pos_lag: 20, win: 21, center: 0,   complete: true },
];

const num = v => (v === null ? NaN : v);

// Compare a JS Frame (or null) against an R Frame (or null). Element-wise over
// the {year, lag, "R val"} columns; returns {ok, nrow, maxDiff, note}.
function compareFrame(R, J) {
  if (R === null || J === null) {
    const ok = (R === null) === (J === null);
    return { ok, nrow: 0, maxDiff: 0, note: `R=${R === null ? 'null' : 'frame'} JS=${J === null ? 'null' : 'frame'}` };
  }
  if (JSON.stringify(R.names) !== JSON.stringify(J.names)) return { ok: false, nrow: 0, maxDiff: Infinity, note: 'names differ' };
  const nR = R.cols[0].length, nJ = J.cols[0].length;
  if (nR !== nJ) return { ok: false, nrow: `${nR}/${nJ}`, maxDiff: Infinity, note: 'nrow differ' };
  let maxDiff = 0, mism = 0;
  for (let c = 0; c < R.cols.length; c++) {
    for (let r = 0; r < nR; r++) {
      const a = num(R.cols[c][r]), b = num(J.cols[c][r]);
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      const d = Math.abs(a - b);
      if (!(d <= maxDiff)) maxDiff = d;
      if (!(d <= TOL)) mism++;
    }
  }
  return { ok: mism === 0, nrow: nR, maxDiff, note: mism ? `${mism} mismatches` : 'ok' };
}

let anyFail = false;
console.log('running_lead_lag:');
console.log('  case'.padEnd(16), 'nrow'.padStart(8), 'maxDiff'.padStart(14), 'result');
for (const cs of RLL_CASES) {
  const R = gt.rll[cs.key] === undefined ? null : gt.rll[cs.key];
  const J = runningLeadLag(gt.input, cs);
  const c = compareFrame(R, J);
  if (!c.ok) anyFail = true;
  console.log('  ' + cs.key.padEnd(14), String(c.nrow).padStart(8),
    (Number.isFinite(c.maxDiff) ? c.maxDiff.toExponential(3) : 'inf').padStart(14),
    (c.ok ? 'PASS' : 'FAIL') + ' ' + (c.ok ? '' : c.note));
}

console.log('heatmap_analysis (plot.data):');
console.log('  case'.padEnd(16), 'nrow'.padStart(8), 'maxDiff'.padStart(14), 'result');
for (const cs of HEAT_CASES) {
  const R = gt.heat[cs.key] === undefined ? null : gt.heat[cs.key];
  const J = heatmapAnalysis(gt.input, cs);
  const c = compareFrame(R, J);
  if (!c.ok) anyFail = true;
  console.log('  ' + cs.key.padEnd(14), String(c.nrow).padStart(8),
    (Number.isFinite(c.maxDiff) ? c.maxDiff.toExponential(3) : 'inf').padStart(14),
    (c.ok ? 'PASS' : 'FAIL') + ' ' + (c.ok ? '' : c.note));
}

console.log(anyFail ? '\nFAIL' : '\nPASS: runningLeadLag + heatmapAnalysis match R element-wise.');
process.exit(anyFail ? 1 : 0);
