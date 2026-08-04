'use strict';
// Validate src/analysis/align.js against R (ringdater::align_series,
// align_to_chron, onto_align_dated) ground truth. Element-wise comparison of
// the full aligned Frame (year/ring column + every series column), including
// column names, nrow, and NA placement. Nonzero exit on failure.
const fs = require('fs');
const path = require('path');
const { alignSeries, alignToChron, ontoAlignDated } = require('../src/analysis/align.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'align_gt.json'), 'utf8'));
const TOL = 1e-12;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
function cellEq(r, j) {
  if (r == null && j == null) return { ok: true, diff: 0 };
  if (r == null || j == null) return { ok: false, diff: Infinity };
  if (typeof r === 'string' || typeof j === 'string') return { ok: String(r) === String(j), diff: 0 };
  if (isNum(r) && isNum(j)) { const d = Math.abs(r - j); return { ok: d <= TOL, diff: d }; }
  return { ok: false, diff: Infinity };
}

let anyFail = false;

// Compare a produced Frame `J` against the R Frame `R`; report per-case stats.
function compare(label, R, J) {
  const nameOk = JSON.stringify(R.names) === JSON.stringify(J.names);
  const nrowR = R.cols.length ? R.cols[0].length : 0;
  const nrowJ = J.cols.length ? J.cols[0].length : 0;
  const ncolOk = R.names.length === J.names.length;
  const nrowOk = nrowR === nrowJ;
  let maxD = 0, mis = 0, cmp = 0;
  const detail = [];
  if (ncolOk && nrowOk) {
    for (let c = 0; c < R.cols.length; c++) {
      for (let r = 0; r < nrowR; r++) {
        const e = cellEq(R.cols[c][r], J.cols[c][r] === undefined ? null : J.cols[c][r]);
        cmp++;
        if (isFinite(e.diff)) maxD = Math.max(maxD, e.diff);
        if (!e.ok) { mis++; if (detail.length < 8) detail.push(`    [${R.names[c]} row ${r}] R=${R.cols[c][r]} JS=${J.cols[c][r]}`); }
      }
    }
  }
  const pass = nameOk && ncolOk && nrowOk && mis === 0;
  if (!pass) anyFail = true;
  console.log(`${label}`);
  console.log(`  names ${nameOk ? 'OK' : 'DIFF'}  dims R ${nrowR}x${R.names.length} / JS ${nrowJ}x${J.names.length} ${ncolOk && nrowOk ? 'OK' : 'DIFF'}  cmp ${cmp}  max|d| ${maxD.toExponential(3)}  mismatches ${mis}  => ${pass ? 'PASS' : 'FAIL'}`);
  if (detail.length) console.log(detail.join('\n'));
}

// ---- T1.8a align_series -----------------------------------------------------
compare('alignSeries  (scenario 1, mode-2 pipeline, Series_1==target, +lags)',
  gt.aligned, alignSeries(gt.chron_n_series, gt.filtered, gt.sel_target));
compare('alignSeries  (scenario 2, mode-1, else-branch + -lags + target front-pad)',
  gt.aligned2, alignSeries(gt.data2, gt.filtered2, 'S2'));

// ---- T1.8b align_to_chron ---------------------------------------------------
compare('alignToChron (scenario 1, equal ranges)',
  gt.to_chron, alignToChron(gt.aligned, gt.chrono_det));
compare('alignToChron (case A, chrono starts later -> chrono top-padded)',
  gt.toChronA, alignToChron(gt.tdA, gt.chA));
compare('alignToChron (case B, chrono starts earlier -> series top-padded)',
  gt.toChronB, alignToChron(gt.tdB, gt.chB));

// ---- T1.8c onto_align_dated -------------------------------------------------
compare('ontoAlignDated (scenario 1, from fully-aligned frame)',
  gt.onto, ontoAlignDated(gt.to_chron));
compare('ontoAlignDated (scenario 2, from aligned frame)',
  gt.onto2, ontoAlignDated(gt.aligned2));

console.log(anyFail ? '\nFAIL' : '\nPASS: alignSeries + alignToChron + ontoAlignDated match R element-wise.');
process.exit(anyFail ? 1 : 0);
