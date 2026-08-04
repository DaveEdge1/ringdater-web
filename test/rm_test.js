'use strict';
// Parity test for src/io/ringMeasurer.js against R ground truth (rm_gt.json).
// Exits nonzero on any mismatch.
const fs = require('fs');
const path = require('path');
const { loadRingMeasurer, combineRMFiles } = require('../src/io/ringMeasurer');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'rm_gt.json'), 'utf8'));

// R serializes NA/NaN -> null, +Inf -> "Inf", -Inf -> "-Inf". Cells may be strings.
function cellEq(a, b) {
  if (b === 'Inf') return a === Infinity;
  if (b === '-Inf') return a === -Infinity;
  if (b === null) return a == null || (typeof a === 'number' && Number.isNaN(a));
  if (a == null) return false;
  if (typeof b === 'string') return String(a) === b;
  if (typeof a !== 'number') return false;
  return Math.abs(a - b) < 1e-12 || a === b;
}
function framesEq(got, exp) {
  if (!got) return 'got null frame';
  if (got.names.length !== exp.names.length) return `ncol JS=${got.names.length} R=${exp.names.length}`;
  for (let i = 0; i < exp.names.length; i++)
    if (got.names[i] !== exp.names[i]) return `name[${i}] JS=${JSON.stringify(got.names[i])} R=${JSON.stringify(exp.names[i])}`;
  for (let j = 0; j < exp.cols.length; j++) {
    if (got.cols[j].length !== exp.cols[j].length) return `nrow col${j} JS=${got.cols[j].length} R=${exp.cols[j].length}`;
    for (let r = 0; r < exp.cols[j].length; r++)
      if (!cellEq(got.cols[j][r], exp.cols[j][r]))
        return `cell[${r},${j}] JS=${JSON.stringify(got.cols[j][r])} R=${JSON.stringify(exp.cols[j][r])}`;
  }
  return null;
}

let fails = 0;
for (const cs of gt) {
  let detail = null;
  if (cs.kind === 'single') {
    let got, err = null;
    try { got = loadRingMeasurer(cs.csv, { avgSeries: cs.avgSeries }); }
    catch (e) { err = e.message; }
    if (cs.expected.kind === 'error') {
      if (err !== cs.expected.message) detail = `error mismatch: JS=${JSON.stringify(err)} R=${JSON.stringify(cs.expected.message)}`;
    } else if (err !== null) {
      detail = `unexpected JS error: ${err}`;
    } else {
      detail = framesEq(got, cs.expected.frame);
    }
  } else { // combine
    let got, err = null;
    try { got = combineRMFiles(cs.csvs); } catch (e) { err = e.message; }
    if (err !== null) detail = `unexpected JS error: ${err}`;
    else detail = framesEq(got, cs.expected.frame);
  }

  if (detail) { fails++; console.error(`FAIL [${cs.kind}/${cs.label}] ${detail}`); }
  else console.log(`ok   [${cs.kind}/${cs.label}]`);
}

console.log(`\n${gt.length - fails}/${gt.length} passed`);
if (fails) process.exit(1);
