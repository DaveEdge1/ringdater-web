'use strict';
// Validate src/analysis/leadLag.js against R (ringdater::lead_lag_analysis)
// ground truth for all 4 param combos (mode 1/2 x complete T/F).
// Compares masterLeadLag (by prefixed column name) and crossDatRes (17-col
// layout incl. header/separator rows) element-wise. Requires the best/2nd/3rd
// match lag ordering to be identical to R. Nonzero exit on failure.
const fs = require('fs');
const path = require('path');
const { leadLag } = require('../src/analysis/leadLag.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'leadlag_gt.json'), 'utf8'));
const TOL = 1e-10;   // absolute tolerance
const RTOL = 1e-11;  // relative tolerance (P_Val = p*correction inflates the abs
                     // diff of a p-value that itself matches R's pt to ~1e-12 rel)

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const cellEq = (r, j) => {
  // both null/NA
  if (r == null && j == null) return { ok: true, diff: 0 };
  if (r == null || j == null) return { ok: false, diff: Infinity, kind: 'na' };
  if (typeof r === 'string' || typeof j === 'string') return { ok: String(r) === String(j), diff: 0, kind: 'str' };
  if (isNum(r) && isNum(j)) {
    const d = Math.abs(r - j);
    const ok = d <= TOL || d <= RTOL * Math.max(Math.abs(r), Math.abs(j));
    return { ok, diff: d };
  }
  return { ok: false, diff: Infinity, kind: 'type' };
};
// normalise a gt cell: "null" already parsed to null; numbers stay numbers.
const norm = v => (v === null ? null : v);

const CASES = [
  { key: 'm1_cT', mode: 1, complete: true },
  { key: 'm1_cF', mode: 1, complete: false },
  { key: 'm2_cT', mode: 2, complete: true },
  { key: 'm2_cF', mode: 2, complete: false },
];

let anyFail = false;

for (const cs of CASES) {
  const R = gt.cases[cs.key];
  const res = leadLag(gt.input, { mode: cs.mode, neg_lag: -20, pos_lag: 20, complete: cs.complete });

  // ---- masterLeadLag: compare by prefixed column name -----------------------
  const Rm = R.master_lead_lag, Jm = res.masterLeadLag;
  const Jindex = {}; Jm.names.forEach((n, i) => { if (n) Jindex[n] = i; });
  let mMax = 0, mMis = 0, mCmp = 0, mMissingCol = 0;
  for (let jc = 0; jc < Rm.names.length; jc++) {
    const name = Rm.names[jc];
    if (name === 'rep.NA..1.') continue;                 // R's leading placeholder col
    const ji = Jindex[name];
    if (ji === undefined) { mMissingCol++; continue; }
    const Rc = Rm.cols[jc], Jc = Jm.cols[ji];
    const n = Math.max(Rc.length, Jc.length);
    for (let r = 0; r < n; r++) {
      const c = cellEq(norm(Rc[r]), norm(Jc[r] === undefined ? null : Jc[r]));
      mCmp++;
      if (isFinite(c.diff)) mMax = Math.max(mMax, c.diff);
      if (!c.ok) mMis++;
    }
  }

  // ---- crossDatRes: full 17-col layout, element-wise ------------------------
  const Rc = R.cross_dat_res, Jc = res.crossDatRes;
  let cMax = 0, cMis = 0, cCmp = 0;
  const nameOk = JSON.stringify(Rc.names) === JSON.stringify(Jc.names);
  const nrowOk = Rc.cols[0].length === Jc.cols[0].length;
  const detail = [];
  if (nrowOk) {
    for (let j = 0; j < Rc.names.length; j++) {
      const RcCol = Rc.cols[j], JcCol = Jc.cols[j];
      for (let r = 0; r < RcCol.length; r++) {
        const c = cellEq(norm(RcCol[r]), norm(JcCol[r] === undefined ? null : JcCol[r]));
        cCmp++;
        if (isFinite(c.diff)) cMax = Math.max(cMax, c.diff);
        if (!c.ok) { cMis++; if (detail.length < 6) detail.push(`    [${Rc.names[j]} row ${r}] R=${RcCol[r]} JS=${JcCol[r]}`); }
      }
    }
  }

  const pass = mMis === 0 && mMissingCol === 0 && cMis === 0 && nameOk && nrowOk;
  if (!pass) anyFail = true;
  console.log(`case ${cs.key}  (mode ${cs.mode}, complete ${cs.complete})`);
  console.log(`  master : cols ${Rm.names.length - 1} cmp ${mCmp}  max|d| ${mMax.toExponential(3)}  mismatches ${mMis}  missingCols ${mMissingCol}`);
  console.log(`  cross  : names ${nameOk ? 'OK' : 'DIFF'}  nrow ${Rc.cols[0].length}/${Jc.cols[0].length} ${nrowOk ? 'OK' : 'DIFF'}  cmp ${cCmp}  max|d| ${cMax.toExponential(3)}  mismatches ${cMis}`);
  if (detail.length) console.log(detail.join('\n'));
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}`);
}

console.log(anyFail ? '\nFAIL' : '\nPASS: lead_lag_analysis matches R for all 4 cases (masterLeadLag + crossDatRes).');
process.exit(anyFail ? 1 : 0);
