'use strict';
// Parity test for src/io/rwl.js vs R dplR::read.rwl / write.rwl and ringdater::readRWL.
//  (a) readRwl on R-generated fixtures matches R's read.rwl data.frame element-wise.
//  (b) round-trip: writeRwl(readRwl(text)) re-read equals the frame; and for the
//      deterministic layout, writeRwl bytes equal write.rwl's bytes.
//  (c) wrapper: readRWL matches ringdater's readRWL, incl. malformed-header fallback.
const fs = require('fs');
const path = require('path');
const { readRwl, writeRwl, readRWL } = require('../src/io/rwl.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'rwl_gt.json'), 'utf8'));
const N = v => (v === null ? NaN : v);
let allPass = true;

function frameDiff(got, exp) {
  if (JSON.stringify(got.names) !== JSON.stringify(exp.names)) {
    return { ok: false, why: `names ${JSON.stringify(got.names)} != ${JSON.stringify(exp.names)}` };
  }
  let max = 0, naMism = 0;
  for (let c = 0; c < exp.cols.length; c++) {
    const a = got.cols[c], b = exp.cols[c];
    if (a.length !== b.length) return { ok: false, why: `col ${c} length ${a.length} != ${b.length}` };
    for (let i = 0; i < b.length; i++) {
      const x = N(a[i]), y = N(b[i]);
      if (Number.isNaN(x) !== Number.isNaN(y)) { naMism++; continue; }
      if (Number.isNaN(x)) continue;
      const d = Math.abs(x - y);
      if (d > max) max = d;
    }
  }
  return { ok: naMism === 0 && max <= 1e-12, max, naMism };
}

console.log('=== (a) read parity ===');
console.log('case'.padEnd(14), 'maxDiff'.padStart(12), 'naMism'.padStart(7), 'result');
for (const c of gt.cases) {
  const got = readRwl(c.rwl);
  const r = frameDiff(got, c.frame);
  const res = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) allPass = false;
  console.log(c.name.padEnd(14), (r.max != null ? r.max.toExponential(2) : '-').padStart(12),
              String(r.naMism != null ? r.naMism : (r.why || '')).padStart(7), res, r.why || '');
}

console.log('\n=== (b) round-trip (write -> read == frame) ===');
console.log('case'.padEnd(14), 'prec'.padStart(6), 'maxDiff'.padStart(12), 'result');
for (const c of gt.cases) {
  if (c.name === 'header') continue; // header block not reproduced on write (no header list)
  const f0 = readRwl(c.rwl);
  const txt = writeRwl(f0, { precision: c.prec });
  const f1 = readRwl(txt);
  const r = frameDiff(f1, c.frame);
  const res = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) allPass = false;
  console.log(c.name.padEnd(14), String(c.prec).padStart(6),
              (r.max != null ? r.max.toExponential(2) : '-').padStart(12), res, r.why || '');
}

console.log('\n=== (b2) writer byte-parity vs write.rwl ===');
console.log('case'.padEnd(14), 'result');
for (const name of Object.keys(gt.writeBytes)) {
  const c = gt.cases.find(x => x.name === name);
  const got = writeRwl(readRwl(c.rwl), { precision: c.prec });
  const exp = gt.writeBytes[name];
  const ok = got === exp;
  if (!ok) {
    allPass = false;
    // show first differing line for diagnostics
    const gl = got.split('\r\n'), el = exp.split('\r\n');
    let d = -1; for (let i = 0; i < Math.max(gl.length, el.length); i++) if (gl[i] !== el[i]) { d = i; break; }
    console.log(name.padEnd(14), 'FAIL  line', d, '\n  got: ' + JSON.stringify(gl[d]) + '\n  exp: ' + JSON.stringify(el[d]));
  } else {
    console.log(name.padEnd(14), 'PASS (' + got.length + ' bytes)');
  }
}

console.log('\n=== (c) ringdater readRWL wrapper parity ===');
console.log('case'.padEnd(18), 'maxDiff'.padStart(12), 'naMism'.padStart(7), 'result');
for (const w of gt.wrapper) {
  const got = readRWL(w.rwl);
  const r = frameDiff(got, w.frame);
  const res = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) allPass = false;
  console.log(w.name.padEnd(18), (r.max != null ? r.max.toExponential(2) : '-').padStart(12),
              String(r.naMism != null ? r.naMism : (r.why || '')).padStart(7), res, r.why || '');
}

console.log('\n' + (allPass ? 'ALL PASS' : 'FAILURES PRESENT'));
process.exit(allPass ? 0 : 1);
