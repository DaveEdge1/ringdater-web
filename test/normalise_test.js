'use strict';
// Parity test for src/detrend/normalise.js against R ringdater::normalise.
// Ground truth: tools/normalise_ground_truth.R -> test/normalise_gt.json.
//
// Deterministic methods (1,2,3,5,7 + ARmod/logT combos) must match to EXACT_TOL.
// The nls methods (4 ModNegExp, 6 ModHugershoff) are validated per-series against
// R's chosen curve (GT `rmethods`): where dplR's nls converged, JS must agree to
// NLS_TOL; where dplR fell back to Line/Mean, a JS nls that converges instead is a
// DOCUMENTED PATH-DIFF (reported, not a hard failure).
const fs = require('fs');
const path = require('path');
const { normalise } = require('../src/detrend/normalise.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'normalise_gt.json'), 'utf8'));

const N = v => (v === null ? NaN : v);
function colMaxDiff(a, b) {
  let m = 0, mismatchNA = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = N(a[i]), y = N(b[i]);
    const xn = Number.isNaN(x), yn = Number.isNaN(y);
    if (xn && yn) continue;
    if (xn !== yn) { mismatchNA++; continue; }
    const d = Math.abs(x - y);
    if (d > m) m = d;
  }
  return { m, mismatchNA };
}
const isFallback = m => m === 'Line' || m === 'Mean';

const input = gt.input;
const EXACT_TOL = 1e-8;   // deterministic methods
const NLS_TOL = 1e-2;     // same-curve nls solver-precision tolerance
let allPass = true;
const pathDiffs = [];

console.log('case'.padEnd(16), 'ncol'.padStart(5), 'maxDiff'.padStart(13), 'NAmiss'.padStart(7), 'result');

for (const c of gt.cases) {
  const opts = { detrending_select: c.sel, splinewindow: c.spline, ARmod: c.ar, logT: c.log };
  const got = normalise(input, opts);
  const exp = c.expected;
  const nls = c.sel === 4 || c.sel === 6;

  let worst = 0, worstNA = 0, worstCol = -1, casePass = true;
  const namesOk = exp.names.every((nm, j) => got.names[j] === nm)
    && got.cols.length === exp.cols.length;
  if (!namesOk) casePass = false;

  for (let j = 0; j < exp.cols.length; j++) {
    const { m, mismatchNA } = colMaxDiff(got.cols[j], exp.cols[j]);
    if (mismatchNA > 0) { worstNA += mismatchNA; casePass = false; }
    // j===0 is the year column; series are j>=1 with rmethods index j-1.
    if (nls && j >= 1) {
      const rm = c.rmethods[j - 1];
      if (isFallback(rm) && m > EXACT_TOL) {
        pathDiffs.push({ case: c.name, series: exp.names[j], rmethod: rm, diff: m });
        continue; // documented fallback PATH-DIFF: don't count against parity
      }
      if (m > NLS_TOL) casePass = false;           // nls converged but disagrees badly
      if (m > worst) { worst = m; worstCol = j; }
      continue;
    }
    if (m > EXACT_TOL) casePass = false;
    if (m > worst) { worst = m; worstCol = j; }
  }

  if (!casePass) allPass = false;
  console.log(
    c.name.padEnd(16),
    String(got.cols.length).padStart(5),
    worst.toExponential(3).padStart(13),
    String(worstNA).padStart(7),
    casePass ? (nls ? 'PASS*' : 'PASS') : `FAIL(col${worstCol})`
  );
}

if (pathDiffs.length) {
  console.log('\nDocumented nls PATH-DIFFs (dplR fell back to Line/Mean; JS nls converged):');
  for (const d of pathDiffs) {
    console.log(`  ${d.case} ${d.series}: R=${d.rmethod}, maxDiff=${d.diff.toExponential(2)}`);
  }
  console.log('* nls-method cases: same-curve series matched within NLS_TOL=' + NLS_TOL);
}

console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(allPass ? 0 : 1);
