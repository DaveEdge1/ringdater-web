'use strict';
// Parity test for src/stats/probCheck.js against ringdater::prob_check.
// Ground truth: tools/probcheck_ground_truth.R -> test/probcheck_gt.json.
const fs = require('fs');
const path = require('path');
const { probCheck } = require('../src/stats/probCheck.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'probcheck_gt.json'), 'utf8'));

// Build a Frame { names, cols } from the GT input (years col + series cols).
function toFrame(input) {
  const names = ['years'].concat(input.ids);
  const cols = [input.years.slice()].concat(input.series.map(c => c.slice()));
  return { names, cols };
}
function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let allPass = true;
console.log('case'.padEnd(20), 'msg'.padEnd(22), 'nsamp'.padStart(6),
  'samples'.padStart(9), 'intervals'.padStart(10), 'result');

for (const c of gt) {
  const exp = c.expected;
  const got = probCheck(toFrame(c.input), { wind: exp.wind });

  const msgOk = (got.message || null) === (exp.message || null);
  const sampOk = arrEq(got.samples, exp.samples);
  const intOk = arrEq(got.intervals, exp.intervals);
  const ok = msgOk && sampOk && intOk;
  if (!ok) allPass = false;

  console.log(
    exp.name.padEnd(20),
    String(exp.message).padEnd(22),
    String(exp.samples.length).padStart(6),
    (sampOk ? 'ok' : 'DIFF').padStart(9),
    (intOk ? 'ok' : 'DIFF').padStart(10),
    (ok ? 'PASS' : 'FAIL'));

  if (!ok) {
    if (!msgOk) console.log('   message: R=', exp.message, 'JS=', got.message);
    if (!sampOk) console.log('   samples R=', exp.samples, '\n            JS=', got.samples);
    if (!intOk) {
      for (let i = 0; i < Math.max(exp.intervals.length, got.intervals.length); i++) {
        if (exp.intervals[i] !== got.intervals[i])
          console.log('   [' + i + '] R=', JSON.stringify(exp.intervals[i]),
            'JS=', JSON.stringify(got.intervals[i]));
      }
    }
  }
}

console.log(allPass ? '\nALL PROBCHECK CASES PASS' : '\nSOME PROBCHECK CASES FAILED');
process.exit(allPass ? 0 : 1);
