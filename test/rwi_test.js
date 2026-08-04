'use strict';
// Parity test for src/rwi_stats.js against R's rwi.stats.running.
// Ground truth produced by tools/rwi_ground_truth.R -> test/rwi_gt.json.
const fs = require('fs');
const path = require('path');
const { rBarEps } = require('../src/rwi_stats.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'rwi_gt.json'), 'utf8'));

// R emits null for NA; align with the module's NaN outputs for diffing.
const N = v => (v === null ? NaN : v);
function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = N(a[i]), y = N(b[i]);
    if (isNaN(x) && isNaN(y)) continue;
    const d = Math.abs(x - y);
    if (d > m) m = d;
  }
  return m;
}
function allEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (N(a[i]) !== N(b[i])) return false;
  return true;
}

// Rebuild the { years, series } input from the GT dump.
function toRwl(input) {
  const series = {};
  input.ids.forEach((id, j) => { series[id] = input.series[j]; });
  return { years: input.years, series };
}

const TOL = 1e-3; // R rounds rbar.tot / eps to 3 decimals
let allPass = true;

console.log('case'.padEnd(20), 'segs'.padStart(5),
  'mid'.padStart(5), 'ntree'.padStart(6), 'n'.padStart(4),
  'rbar dMax'.padStart(11), 'eps dMax'.padStart(11), 'result');

for (const c of gt) {
  const e = c.expected;
  const got = rBarEps(toRwl(c.input), e.window);

  const g = k => got.map(s => s[k]);
  const midOk = allEqual(g('midYear'), e.mid_year);
  const treeOk = allEqual(g('nTrees'), e.n_trees);
  const nOk = allEqual(g('n'), e.n);
  const rbarD = maxAbsDiff(g('rbarTot'), e.rbar_tot);
  const epsD = maxAbsDiff(g('eps'), e.eps);

  const segOk = got.length === e.mid_year.length;
  const pass = segOk && midOk && treeOk && nOk && rbarD <= TOL && epsD <= TOL;
  if (!pass) allPass = false;

  console.log(
    e.name.padEnd(20),
    (segOk ? String(got.length) : `${got.length}/${e.mid_year.length}`).padStart(5),
    (midOk ? 'ok' : 'X').padStart(5),
    (treeOk ? 'ok' : 'X').padStart(6),
    (nOk ? 'ok' : 'X').padStart(4),
    rbarD.toExponential(2).padStart(11),
    epsD.toExponential(2).padStart(11),
    pass ? 'PASS' : 'FAIL');
}

console.log('\n' + (allPass ? 'ALL PASS' : 'SOME FAILED'));
process.exit(allPass ? 0 : 1);
