'use strict';
// Validate src/analysis/align.js against R (ringdater::align_series,
// align_to_chron, onto_align_dated) ground truth. Element-wise comparison of
// the full aligned Frame (year/ring column + every series column), including
// column names, nrow, and NA placement. Nonzero exit on failure.
const fs = require('fs');
const path = require('path');
const { alignSeries, alignToChron, ontoAlignDated, rawAligned } = require('../src/analysis/align.js');

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

// ---- rawAligned -------------------------------------------------------------
// No R oracle: R's app wrote a raw aligned chronology (initiate.chrono.raw) but
// the ground-truth capture does not carry it, so these are behavioural checks of
// the contract the exports depend on — a series keeps the placement crossdating
// gave it and gets its own measured widths back.
console.log('\n== rawAligned (behavioural — no R ground truth) ==');
function ok(name, cond, extra) {
  if (!cond) anyFail = true;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}
{
  // A is placed at row 2 of the aligned frame, B at row 0; the raw frame holds
  // the same two series on their own axis, A starting at row 1.
  const aligned = {
    names: ['Year', 'A', 'B'],
    cols: [[1000, 1001, 1002, 1003, 1004],
           [null, null, 1.10, 0.90, 1.20],
           [0.80, 1.30, 0.70, null, null]],
  };
  const rawSrc = {
    names: ['ring', 'A', 'B'],
    cols: [[1, 2, 3, 4, 5],
           [null, 0.42, 0.51, 0.60, null],
           [0.11, 0.22, 0.31, null, null]],
  };
  const out = rawAligned(aligned, [rawSrc]);
  ok('every column with a raw source is re-valued',
    out.substituted.join(',') === 'A,B' && out.kept.length === 0,
    out.substituted.join(',') + ' | kept ' + out.kept.join(','));
  ok('the placement the crossdate found is kept',
    out.frame.cols[1][0] == null && out.frame.cols[1][1] == null && out.frame.cols[1][2] === 0.42,
    JSON.stringify(out.frame.cols[1]));
  ok('...for every series, not just the first',
    JSON.stringify(out.frame.cols[2]) === JSON.stringify([0.11, 0.22, 0.31, null, null]),
    JSON.stringify(out.frame.cols[2]));
  ok('the year axis is untouched',
    JSON.stringify(out.frame.cols[0]) === JSON.stringify([1000, 1001, 1002, 1003, 1004]));
  ok('the values are the measurements, not the indices',
    out.frame.cols[1].filter(function (v) { return v != null; }).join(',') === '0.42,0.51,0.6',
    out.frame.cols[1].filter(function (v) { return v != null; }).join(','));
}
{
  // First-difference detrending loses the LAST ring, so a raw series can outrun
  // the column it replaces: the axis has to grow rather than drop the ring.
  const aligned = { names: ['Year', 'A'], cols: [[1000, 1001, 1002], [1.0, 1.1, null]] };
  const rawSrc = { names: ['ring', 'A'], cols: [[1, 2, 3], [0.5, 0.6, 0.7]] };
  const out = rawAligned(aligned, [rawSrc]);
  ok('a raw series longer than its detrended column keeps its last ring',
    out.frame.cols[0].length === 3 && JSON.stringify(out.frame.cols[1]) === JSON.stringify([0.5, 0.6, 0.7]),
    JSON.stringify(out.frame.cols[1]));
  const aligned2 = { names: ['Year', 'A'], cols: [[1000, 1001], [1.0, 1.1]] };
  const rawSrc2 = { names: ['ring', 'A'], cols: [[1, 2, 3], [0.5, 0.6, 0.7]] };
  const out2 = rawAligned(aligned2, [rawSrc2]);
  ok('...growing the year axis when it runs past the frame',
    JSON.stringify(out2.frame.cols[0]) === JSON.stringify([1000, 1001, 1002]) &&
    JSON.stringify(out2.frame.cols[1]) === JSON.stringify([0.5, 0.6, 0.7]),
    JSON.stringify(out2.frame.cols[0]) + ' ' + JSON.stringify(out2.frame.cols[1]));
}
{
  // A mean chronology, or a composite's members, have no raw form. Keeping them
  // as they are and NAMING them beats quietly mixing indices among widths.
  const aligned = { names: ['Year', 'A', 'mean_chronology'], cols: [[1, 2], [1.0, 1.1], [0.99, 1.01]] };
  const rawSrc = { names: ['ring', 'A'], cols: [[1, 2], [0.5, 0.6]] };
  const out = rawAligned(aligned, [rawSrc]);
  ok('a column with no raw source is kept as it is, and reported',
    out.kept.join(',') === 'mean_chronology' && out.substituted.join(',') === 'A' &&
    JSON.stringify(out.frame.cols[2]) === JSON.stringify([0.99, 1.01]),
    'kept ' + out.kept.join(',') + ' | ' + JSON.stringify(out.frame.cols[2]));
  ok('with no sources at all, nothing is substituted',
    rawAligned(aligned, []).substituted.length === 0);
}

console.log(anyFail ? '\nFAIL' : '\nPASS: alignSeries + alignToChron + ontoAlignDated match R element-wise; rawAligned re-values in place.');
process.exit(anyFail ? 1 : 0);
