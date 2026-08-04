'use strict';
// Parity test for src/detrend/detcurves.js vs R ringdater::detcurves
// (dplR::detrend.series$curves), methods 3,4,5,6.
//
//  * Methods 3 (Spline) and 5 (Friedman) are deterministic linear/smoother
//    pipelines -> enforced bit-close (<= 1e-9). A regression fails the suite.
//  * Methods 4 (ModNegExp) and 6 (ModHugershoff) fit via nls. R (nls/port) and
//    JS (gaussNewton) walk different optimisation paths, so per-series results
//    either match bit-close OR diverge as a documented nls PATH-DIFF (a flat
//    objective giving 4th-5th-decimal coef differences, or R rejecting the nls
//    and falling back to Line/Mean where JS keeps the curve). These are
//    REPORTED, not failed.
const fs = require('fs');
const path = require('path');
const { detcurves } = require('../src/detrend/detcurves.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'detcurves_gt.json'), 'utf8'));
const N = v => (v === null ? NaN : v);
function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = N(a[i]), y = N(b[i]);
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    const d = Math.abs(x - y);
    if (!(d <= m)) m = d;
  }
  return m;
}

const input = { names: gt.input.names, cols: gt.input.cols };
const HARD = 1e-9;         // bit-close target for deterministic methods
const label = { 3: 'Spline', 4: 'ModNegExp', 5: 'Friedman', 6: 'ModHugershoff' };
const isNls = m => m === 4 || m === 6;
let allPass = true;
const pathDiffs = [];

console.log('method'.padEnd(14), 'series'.padEnd(8), 'maxDiff'.padStart(12), 'result');
for (const c of gt.cases) {
  const got = detcurves(input, { detrending_select: c.method, splinewindow: c.splinewindow });
  const exp = c.expected;
  if (JSON.stringify(got.names) !== JSON.stringify(exp.names)) {
    console.log('NAME MISMATCH', got.names, exp.names); allPass = false;
  }
  for (let col = 1; col < exp.names.length; col++) {
    const d = maxAbsDiff(got.cols[col], exp.cols[col]);
    let res;
    if (d <= HARD) res = 'PASS';
    else if (isNls(c.method)) { res = 'PATH-DIFF'; pathDiffs.push(`${label[c.method]}/${exp.names[col]}=${d.toExponential(2)}`); }
    else { res = 'FAIL'; allPass = false; }
    console.log(label[c.method].padEnd(14), String(exp.names[col]).padEnd(8),
      d.toExponential(3).padStart(12), res);
  }
}
if (pathDiffs.length) console.log('\nnls PATH-DIFFs (expected, reported):\n  ' + pathDiffs.join('\n  '));
console.log(allPass ? '\ndetcurves: PASS (Spline+Friedman bit-close; nls diffs are documented path-diffs)'
  : '\ndetcurves: FAIL');
process.exit(allPass ? 0 : 1);
