'use strict';
// Parity test for src/analysis/rollcor.js vs R ringdater::rollcor.
const fs = require('fs');
const path = require('path');
const { rollcor } = require('../src/analysis/rollcor.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'rollcor_gt.json'), 'utf8'));
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

const TOL = 1e-9;
let allPass = true;
console.log('case'.padEnd(20), 'width'.padStart(6), 'len'.padStart(5), 'maxDiff'.padStart(14), 'result');
for (const c of gt) {
  const got = rollcor(c.x, c.y, c.width);
  const d = maxAbsDiff(got, c.cc);
  const lenOk = got.length === c.cc.length;
  const pass = lenOk && d <= TOL;
  allPass = allPass && pass;
  console.log(c.name.padEnd(20), String(c.width).padStart(6), String(got.length).padStart(5),
    d.toExponential(3).padStart(14), pass ? 'PASS' : `FAIL${lenOk ? '' : '(len)'}`);
}
console.log(allPass ? '\nrollcor: ALL PASS' : '\nrollcor: FAIL');
process.exit(allPass ? 0 : 1);
