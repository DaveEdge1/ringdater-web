'use strict';
// Parity test for src/io/pos.js against R ringdater::load_pos.
// Ground truth: tools/pos_ground_truth.R -> test/pos_gt.json (synthesized .pos
// fixtures + expected reversed ring widths). load_pos is pure coordinate
// arithmetic, so parity is bit-close (EXACT_TOL). Each case embeds its raw .pos
// text; we parse it with loadPos and compare the increment + widths columns.
const fs = require('fs');
const path = require('path');
const { loadPos } = require('../src/io/pos.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'pos_gt.json'), 'utf8'));

const EXACT_TOL = 1e-12;

function colMaxDiff(a, b) {
  let m = 0, mismatch = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    const xn = x == null || Number.isNaN(x);
    const yn = y == null || Number.isNaN(y);
    if (xn && yn) continue;
    if (xn !== yn) { mismatch++; continue; }
    const d = Math.abs(x - y);
    if (d > m) m = d;
  }
  return { m, mismatch };
}

let allPass = true;
console.log('case'.padEnd(18), 'n'.padStart(4), 'maxDiff'.padStart(13), 'result');

for (const c of gt.cases) {
  const got = loadPos(c.pos);
  let casePass = true;

  // shape: 2 columns, n rows
  if (got.cols.length !== 2 || got.cols[1].length !== c.n) casePass = false;

  const d1 = colMaxDiff(got.cols[0], c.col1);   // increment index
  const d2 = colMaxDiff(got.cols[1], c.widths); // reversed ring widths
  if (d1.mismatch || d2.mismatch) casePass = false;
  if (d1.m > EXACT_TOL || d2.m > EXACT_TOL) casePass = false;

  const worst = Math.max(d1.m, d2.m);
  if (!casePass) allPass = false;
  console.log(
    c.name.padEnd(18),
    String(c.n).padStart(4),
    worst.toExponential(3).padStart(13),
    casePass ? 'PASS' : 'FAIL'
  );
}

console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(allPass ? 0 : 1);
