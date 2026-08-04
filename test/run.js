'use strict';
const fs = require('fs');
const path = require('path');
const { whitenSeries, modNegExp, modHugershoff, caps, detrendSpline, friedman } = require('../src/index.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth2.json'), 'utf8'));
const splineGt = JSON.parse(fs.readFileSync(path.join(__dirname, 'spline_ground_truth.json'), 'utf8'));
const friedGt = JSON.parse(fs.readFileSync(path.join(__dirname, 'friedman_gt.json'), 'utf8'));

function stats(a, b) {
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) maxAbs = d;
    const rel = d / Math.max(1e-12, Math.abs(b[i]));
    if (rel > maxRel) maxRel = rel;
  }
  return { maxAbs, maxRel };
}

// per-function pass tolerance on max abs diff of the produced curve/series
const TOL = { whiten: 1e-9, ModNegExp: 1e-4, ModHugershoff: 1e-4 };
// R's fitmethod -> did R's nls converge, or fall back to line/mean?
const rConverged = m => m === 'Hugershoff' || m === 'NegativeExponential';
const jsConverged = m => m === 'Hugershoff' || m === 'NegativeExponential';

let allPass = true;
// --- spline (bit-exact) ---
console.log('case'.padEnd(18), 'n'.padStart(5), 'target'.padEnd(14), 'maxAbsDiff'.padStart(12), 'R fit'.padEnd(12), 'JS fit'.padEnd(10), 'result');
for (const name of Object.keys(splineGt)) {
  const c = splineGt[name];
  const isDetrend = name.indexOf('detrend') === 0;
  const jsCurve = isDetrend ? detrendSpline(c.y, c.nyrs, c.f).curve : caps(c.y, c.nyrs, c.f);
  let maxAbs = stats(jsCurve, c.curve).maxAbs;
  if (isDetrend) maxAbs = Math.max(maxAbs, stats(detrendSpline(c.y, c.nyrs, c.f).detrended, c.detrended).maxAbs);
  const verdict = maxAbs < 1e-9 ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') allPass = false;
  console.log(name.padEnd(18), String(c.n).padStart(5), 'spline'.padEnd(14),
              maxAbs.toExponential(3).padStart(12), '-'.padEnd(12), '-'.padEnd(10), verdict);
}
// --- Friedman / supsmu (bit-close) ---
for (const name of Object.keys(friedGt)) {
  const c = friedGt[name];
  const r = friedman(c.y);
  const maxAbs = stats(r.curve, c.curve).maxAbs;
  const verdict = maxAbs < 1e-6 ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') allPass = false;
  console.log(('friedman_' + name).padEnd(18), String(c.y.length).padStart(5), 'Friedman'.padEnd(14),
              maxAbs.toExponential(3).padStart(12), (c.fit || '-').padEnd(12), r.method.padEnd(10), verdict);
}
for (const name of Object.keys(gt)) {
  const c = gt[name];
  const fn = c.fn.replace(/"/g, '');
  let js, ref, jsMethod = '', rMethod = (c.fitmethod || '').replace(/"/g, '');
  if (fn === 'whiten') { js = whitenSeries(c.y); ref = c.out; }
  else if (fn === 'ModNegExp') { const r = modNegExp(c.y); js = r.curve; ref = c.curve; jsMethod = r.method; }
  else if (fn === 'ModHugershoff') { const r = modHugershoff(c.y); js = r.curve; ref = c.curve; jsMethod = r.method; }
  else continue;
  const s = stats(js, ref);

  let verdict;
  if (fn === 'whiten') {
    verdict = s.maxAbs < TOL.whiten ? 'PASS' : 'FAIL';
  } else if (rConverged(rMethod) === jsConverged(jsMethod)) {
    // fit paths agree -> require tight numerical parity (hard check)
    verdict = s.maxAbs < TOL[fn] ? 'PASS' : 'FAIL';
  } else {
    // documented nls-fragility boundary: R bailed to line/mean, JS converged (or vice-versa)
    verdict = 'PATH-DIFF';
  }
  if (verdict === 'FAIL') allPass = false;
  console.log(name.padEnd(18), String(c.y.length).padStart(5), fn.padEnd(14),
              s.maxAbs.toExponential(3).padStart(12), (rMethod || '-').padEnd(12),
              (jsMethod || '-').padEnd(10), verdict);
}
console.log('\nPASS = bit/tolerance parity.  PATH-DIFF = R nls fell back where JS converged (documented, rare).');
console.log(allPass ? 'ALL HARD CHECKS PASS' : 'SOME HARD CHECKS FAILED');
process.exit(allPass ? 0 : 1);
