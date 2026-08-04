'use strict';
// Parity test for src/stats/rBarEps.js against ringdater::R_bar_EPS.
// Ground truth: tools/rbareps_ground_truth.R -> test/rbareps_gt.json.
// R rounds rbar.tot / eps to 3 decimals (round.decimals=3); the wrapper does
// the same, so this test requires EXACT equality on the rounded values (and on
// the integer mid.year / n.trees / n columns).
const fs = require('fs');
const path = require('path');
const { rBarEps } = require('../src/stats/rBarEps.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'rbareps_gt.json'), 'utf8'));

const N = v => (v === null ? NaN : v);

function toFrame(input) {
  const names = ['years'].concat(input.ids);
  const cols = [input.years.slice()].concat(input.series.map(c => c.slice()));
  return { names, cols };
}

// Exact match, treating NaN==null(NA).
function eqExact(a, b) {
  const x = N(a), y = N(b);
  if (typeof x === 'number' && isNaN(x) && typeof y === 'number' && isNaN(y)) return true;
  return x === y;
}

let allPass = true;
console.log('case'.padEnd(20), 'segs'.padStart(5),
  'mid'.padStart(5), 'ntree'.padStart(6), 'n'.padStart(4),
  'rbar'.padStart(6), 'eps'.padStart(6), 'result');

for (const c of gt) {
  const exp = c.expected;
  const got = rBarEps(toFrame(c.input), { window: exp.window });

  let midOk = true, ntreeOk = true, nOk = true, rbarOk = true, epsOk = true;
  const lenOk = got.length === exp.mid_year.length;
  if (!lenOk) { allPass = false; }
  for (let i = 0; i < Math.min(got.length, exp.mid_year.length); i++) {
    if (!eqExact(got[i].midYear, exp.mid_year[i])) midOk = false;
    if (!eqExact(got[i].nTrees, exp.n_trees[i])) ntreeOk = false;
    if (!eqExact(got[i].n, exp.n[i])) nOk = false;
    if (!eqExact(got[i].rbarTot, exp.rbar_tot[i])) rbarOk = false;
    if (!eqExact(got[i].eps, exp.eps[i])) epsOk = false;
  }
  const ok = lenOk && midOk && ntreeOk && nOk && rbarOk && epsOk;
  if (!ok) allPass = false;

  console.log(
    exp.name.padEnd(20),
    String(exp.mid_year.length).padStart(5),
    (midOk ? 'ok' : 'X').padStart(5),
    (ntreeOk ? 'ok' : 'X').padStart(6),
    (nOk ? 'ok' : 'X').padStart(4),
    (rbarOk ? 'ok' : 'X').padStart(6),
    (epsOk ? 'ok' : 'X').padStart(6),
    (ok ? 'PASS' : 'FAIL'));

  if (!ok) {
    for (let i = 0; i < Math.min(got.length, exp.mid_year.length); i++) {
      if (!eqExact(got[i].rbarTot, exp.rbar_tot[i]) || !eqExact(got[i].eps, exp.eps[i]))
        console.log('   [' + i + '] mid=' + exp.mid_year[i] +
          ' rbar R=' + exp.rbar_tot[i] + ' JS=' + got[i].rbarTot +
          ' | eps R=' + exp.eps[i] + ' JS=' + got[i].eps);
    }
  }
}

console.log(allPass ? '\nALL RBAREPS CASES PASS' : '\nSOME RBAREPS CASES FAILED');
process.exit(allPass ? 0 : 1);
