'use strict';
// Parity test for src/analysis/checks.js against R ground truth (checks_gt.json).
// Exits nonzero on any mismatch.
const fs = require('fs');
const path = require('path');
const { nameCheck, loadedDataCheck, pairwiseDataCheck } = require('../src/analysis/checks');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'checks_gt.json'), 'utf8'));

function toFrame(inp) { return { names: inp.names.slice(), cols: inp.cols.map(c => c.slice()) }; }

// R serializes NA -> null, +Inf -> "Inf", -Inf -> "-Inf"
function numEq(a, b) {
  if (b === 'Inf') return a === Infinity;
  if (b === '-Inf') return a === -Infinity;
  if (b === null) return a == null || (typeof a === 'number' && Number.isNaN(a));
  if (a == null) return false;
  return Math.abs(a - b) < 1e-12 || a === b;
}
function colsEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (!numEq(a[i][j], b[i][j])) return false;
  }
  return true;
}
function strArrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let fails = 0;
for (const cs of gt) {
  const { fn, label, input, expected } = cs;
  const frame = input.nonframe ? [1, 2, 3, 4, 5] : toFrame(input);
  let got, err = null;
  try {
    if (fn === 'nameCheck') got = nameCheck(frame);
    else if (fn === 'loadedDataCheck') got = loadedDataCheck(frame);
    else got = pairwiseDataCheck(frame);
  } catch (e) { err = e.message; }

  let ok = true, detail = '';
  if (expected.kind === 'error') {
    if (err !== expected.message) { ok = false; detail = `error mismatch: JS=${JSON.stringify(err)} R=${JSON.stringify(expected.message)}`; }
  } else if (err !== null) {
    ok = false; detail = `unexpected JS error: ${err}`;
  } else if (expected.kind === 'names') {
    if (!strArrEq(got.names, expected.names)) { ok = false; detail = `names: JS=${JSON.stringify(got.names)} R=${JSON.stringify(expected.names)}`; }
  } else if (expected.kind === 'code') {
    if (got !== expected.code) { ok = false; detail = `code: JS=${got} R=${expected.code}`; }
  } else if (expected.kind === 'pw') {
    if (expected.data === null) {
      if (got.data !== null) { ok = false; detail = `expected null data, got frame`; }
      if (got.title !== expected.title) { ok = false; detail += ` title: JS=${JSON.stringify(got.title)} R=${JSON.stringify(expected.title)}`; }
      if (got.message !== expected.text) { ok = false; detail += ` text: JS=${JSON.stringify(got.message)} R=${JSON.stringify(expected.text)}`; }
    } else {
      if (got.data === null) { ok = false; detail = `expected frame, got null`; }
      else {
        if (!strArrEq(got.data.names, expected.data.names)) { ok = false; detail += ` names: JS=${JSON.stringify(got.data.names)} R=${JSON.stringify(expected.data.names)}`; }
        if (!colsEq(got.data.cols, expected.data.cols)) { ok = false; detail += ` cols mismatch`; }
      }
      if (got.title !== null || got.message !== null) { ok = false; detail += ` expected no alert`; }
    }
  }

  if (!ok) { fails++; console.error(`FAIL [${fn}/${label}] ${detail}`); }
  else console.log(`ok   [${fn}/${label}]`);
}

console.log(`\n${gt.length - fails}/${gt.length} passed`);
if (fails) process.exit(1);
