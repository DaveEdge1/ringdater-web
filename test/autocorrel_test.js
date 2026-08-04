'use strict';
// Parity test for src/analysis/autoCorrel.js vs R ringdater::auto_correl.
const fs = require('fs');
const path = require('path');
const { autoCorrel } = require('../src/analysis/autoCorrel.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'autocorrel_gt.json'), 'utf8'));
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

// Rebuild the input Frame exactly as dumped by R.
const input = { names: gt.input.names, cols: gt.input.cols };
const got = autoCorrel(input);
const exp = gt.expected;

const TOL = 1e-9;
let allPass = true;
console.log('column'.padEnd(12), 'maxDiff'.padStart(14), 'result');

// Column 0 = lag; then one column per series. Compare by name/order.
if (JSON.stringify(got.names) !== JSON.stringify(exp.names)) {
  console.log('NAME MISMATCH got=', got.names, 'exp=', exp.names);
  allPass = false;
}
for (let c = 0; c < exp.names.length; c++) {
  const d = maxAbsDiff(got.cols[c], exp.cols[c]);
  const pass = d <= TOL;
  allPass = allPass && pass;
  console.log(String(exp.names[c]).padEnd(12), d.toExponential(3).padStart(14), pass ? 'PASS' : 'FAIL');
}
console.log(allPass ? '\nautoCorrel: ALL PASS' : '\nautoCorrel: FAIL');
process.exit(allPass ? 0 : 1);
