'use strict';
// Validate src/corr_rwl_seg.js against R (dplR::corr.rwl.seg) ground truth.
// Compares per-segment Spearman rho (tol ~1e-3) and requires the set of flagged
// segments to match R exactly.  PASS/FAIL summary + nonzero exit on failure.
const fs = require('fs');
const path = require('path');
const { corrRwlSeg } = require('../src/corr_rwl_seg.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'corr_gt.json'), 'utf8'));

const rwl = { years: gt.years, series: gt.series };
const res = corrRwlSeg(rwl, {
  segLength: gt.seg_length, binFloor: gt.bin_floor, pcrit: gt.pcrit, floorPlus1: false,
});

const RHO_TOL = 1e-3;
const num = v => (v === null || (typeof v === 'number' && Number.isNaN(v))) ? null : v;

// ---- 1. per-segment rho parity ----
let maxRhoDiff = 0, rhoMismatch = 0, cmp = 0, naMismatch = 0;
for (const id of gt.cnames) {
  const R = gt.spearman_rho[id], J = res.segRho[id];
  for (let j = 0; j < R.length; j++) {
    const r = num(R[j]), jj = num(J[j]);
    if (r === null && jj === null) continue;
    if (r === null || jj === null) { naMismatch++; continue; }
    cmp++;
    const d = Math.abs(r - jj);
    if (d > maxRhoDiff) maxRhoDiff = d;
    if (d > RHO_TOL) rhoMismatch++;
  }
}

// ---- 2. p-value parity (informational) ----
let maxPDiff = 0;
for (const id of gt.cnames) {
  const R = gt.p_val[id], J = res.pval[id];
  for (let j = 0; j < R.length; j++) {
    const r = num(R[j]), jj = num(J[j]);
    if (r === null || jj === null) continue;
    maxPDiff = Math.max(maxPDiff, Math.abs(r - jj));
  }
}

// ---- 3. overall rho parity (informational) ----
let maxOverallDiff = 0;
for (const id of gt.cnames) {
  const r = num(gt.overall[id][0]), jj = num(res.overall[id][0]);
  if (r !== null && jj !== null) maxOverallDiff = Math.max(maxOverallDiff, Math.abs(r - jj));
}

// ---- 4. flag-set exact match ----
const norm = obj => {
  const m = {};
  for (const k of Object.keys(obj)) m[k] = obj[k].split(',').map(s => s.trim()).sort().join('|');
  return m;
};
const Rf = norm(gt.flags), Jf = norm(res.flags);
const ids = new Set([...Object.keys(Rf), ...Object.keys(Jf)]);
let flagMismatch = 0;
const flagDetail = [];
for (const id of ids) {
  if (Rf[id] !== Jf[id]) {
    flagMismatch++;
    flagDetail.push(`  ${id}: R=[${Rf[id] || ''}] JS=[${Jf[id] || ''}]`);
  }
}

console.log('corr.rwl.seg parity vs dplR (ca533, seg.length=' + gt.seg_length + ')');
console.log('  segments compared     :', cmp, '(NA-pattern mismatches:', naMismatch + ')');
console.log('  max |rho diff|        :', maxRhoDiff.toExponential(3), '(tol', RHO_TOL + ')');
console.log('  segRho over tol       :', rhoMismatch);
console.log('  max |p diff|          :', maxPDiff.toExponential(3));
console.log('  max |overall rho diff|:', maxOverallDiff.toExponential(3));
console.log('  R flagged series      :', Object.keys(gt.flags).length,
            '| JS flagged series:', Object.keys(res.flags).length);
console.log('  flag-set mismatches   :', flagMismatch);
if (flagMismatch) console.log(flagDetail.join('\n'));

const pass = rhoMismatch === 0 && naMismatch === 0 && flagMismatch === 0;
console.log(pass ? '\nPASS: segment correlations within tol and flags match R exactly.'
                 : '\nFAIL');
process.exit(pass ? 0 : 1);
