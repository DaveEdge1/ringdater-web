'use strict';
// ============================================================================
// Validation of the interactive chronology builder (src/engine/builder.js)
// against ringdater's own primitives (tools/builder_ground_truth.R) and against
// internal consistency. Nonzero exit on any failure.
//
//   1. CROSSDATE CORRECTNESS  builder.crossdate(id).suggestions[0] must equal
//      the First_lag/R/P that lead_lag_analysis(mode 2) gives on the SAME
//      comb.NA frame — matched to R (lag exact, R/P <= 1e-9) — and must recover
//      the known constructed offset K.
//   2. PLACEMENT CORRECTNESS  after approve(id, K) the merged member column must
//      land at the correct absolute years, element-wise equal to R's
//      align_series placement for that series + lag.
//   3. ITERATIVE CONSISTENCY  bootstrap from an anchor, add 4 shared-signal
//      series at their best lags; assert member set, recorded lags and the
//      final mean are stable, and that re-crossdating an included member
//      against the others recovers the lag it was placed at.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { createBuilder } = require('../src/engine/builder.js');
const C = require('../src/analysis/comb.js');
const { leadLag } = require('../src/analysis/leadLag.js');

// Load an undated CSV fixture (Year + Sample_* columns, 'NA' = missing) into a Frame.
function loadUndatedCsv(p) {
  const L = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const head = L[0].split(',');
  const cols = head.map(n => ({ name: n, values: [] }));
  for (let i = 1; i < L.length; i++) {
    const parts = L[i].split(',');
    for (let c = 0; c < head.length; c++) {
      const v = parts[c];
      cols[c].values.push(v === 'NA' || v === '' || v == null ? null : Number(v));
    }
  }
  return C.frame(cols);
}

// Best lag of member `id` against the mean of the OTHER members, on the shared
// working axis (col 0). A correctly-placed member must show lag 0 (no shift
// improves its fit) — the internal-consistency invariant for a built chronology.
function lagVsRest(chr, id) {
  const ci = chr.names.indexOf(id);
  const nr = chr.cols[0].length;
  const mean = new Array(nr);
  for (let r = 0; r < nr; r++) {
    let s = 0, n = 0;
    for (let c = 1; c < chr.cols.length; c++) {
      if (c === ci) continue;
      const v = chr.cols[c][r];
      if (!C.isNA(v)) { s += v; n++; }
    }
    mean[r] = n ? s / n : C.NA;
  }
  const fr = { names: ['year', 'mean_chronology', id], cols: [chr.cols[0].slice(), mean, chr.cols[ci].slice()] };
  const { crossDatRes } = leadLag(fr, { mode: 2, complete: true });
  const s1 = crossDatRes.cols[0], s2 = crossDatRes.cols[1];
  for (let r = 0; r < s1.length; r++) if (s1[r] === 'mean_chronology' && s2[r] === id) return crossDatRes.cols[5][r];
  return NaN;
}

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'builder_gt.json'), 'utf8'));
const RTOL = 1e-9;
let anyFail = false;
function check(label, ok, extra) {
  if (!ok) anyFail = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
}
const isNA = v => v == null || (typeof v === 'number' && Number.isNaN(v));

// ----------------------------------------------------------------------------
// 1 + 2 : crossdate + placement vs ringdater ground truth
// ----------------------------------------------------------------------------
console.log('== 1/2. crossdate + placement vs R (shared-signal scenario, K =', gt.K, ') ==');

const detrend = { detrending_select: 1 };          // raw -> identical numbers to R
const b = createBuilder({ undated: gt.undated, chron: gt.chron, detrend });

// seeded from the 5-member chronology, candidate 'cand' still in the pool.
const st0 = b.state();
check('seeded 5 members', st0.members.length === 5 && st0.hasChronology, `members=${st0.members.map(m => m.id).join(',')}`);
check('candidate in pool', st0.poolIds.length === 1 && st0.poolIds[0] === 'cand');

const cx = b.crossdate('cand', { neg_lag: -20, pos_lag: 20, complete: true });
const best = cx.suggestions[0];

// R's (mean_chronology, cand) row from cross_dat_res.
const cd = gt.cross_dat_res;
let rrow = -1;
for (let r = 0; r < cd.cols[0].length; r++) if (cd.cols[0][r] === 'mean_chronology' && cd.cols[1][r] === 'cand') { rrow = r; break; }
const rLag = cd.cols[5][rrow], rR = cd.cols[6][rrow], rP = cd.cols[7][rrow], rOv = cd.cols[8][rrow];

check('best lag == K', best.lag === gt.K, `builder=${best.lag} K=${gt.K}`);
check('best lag == R First_lag', best.lag === rLag, `builder=${best.lag} R=${rLag}`);
check('best R matches R', Math.abs(best.R - rR) <= RTOL, `|d|=${Math.abs(best.R - rR).toExponential(2)}`);
check('best P matches R', Math.abs(best.P - rP) <= RTOL, `|d|=${Math.abs(best.P - rP).toExponential(2)}`);
check('best overlap matches R', best.overlap === rOv, `builder=${best.overlap} R=${rOv}`);

// approve at K, then compare the placed 'cand' column to R's align_series output.
b.approve('cand', best.lag);
const chr = b.chronology();
const candIdx = chr.names.indexOf('cand');
const yearIdx = 0;

// R aligned: [Year, mean_chronology, cand]
const ra = gt.aligned;
const rYear = ra.cols[0], rCand = ra.cols[ra.names.indexOf('cand')];
const rMap = new Map();
for (let i = 0; i < rYear.length; i++) if (!isNA(rCand[i])) rMap.set(rYear[i], rCand[i]);

const jMap = new Map();
for (let r = 0; r < chr.cols[yearIdx].length; r++) {
  const v = chr.cols[candIdx][r];
  if (!isNA(v)) jMap.set(chr.cols[yearIdx][r], v);
}
let placeMax = 0, placeMis = 0, rFirst = Infinity, rLast = -Infinity;
for (const [y, rv] of rMap) { if (y < rFirst) rFirst = y; if (y > rLast) rLast = y; }
const allYears = new Set([...rMap.keys(), ...jMap.keys()]);
for (const y of allYears) {
  const rv = rMap.get(y), jv = jMap.get(y);
  if (rv == null || jv == null) { placeMis++; continue; }
  placeMax = Math.max(placeMax, Math.abs(rv - jv));
}
check('candidate placed at same absolute years as R', placeMis === 0 && rMap.size === jMap.size,
  `R-yrs ${rFirst}..${rLast} (n=${rMap.size}) JS n=${jMap.size} mismatchedYears=${placeMis}`);
check('candidate values equal R align_series', placeMax <= RTOL, `max|d|=${placeMax.toExponential(2)}`);
check('placement lands at expected absolute years (1531..1590)', rFirst === 1531 && rLast === 1590);

// ----------------------------------------------------------------------------
// 3 : iterative consistency — bootstrap from an anchor, add 4 series at known
//     relative offsets, verify stability and re-crossdate lag 0-equivalence.
// ----------------------------------------------------------------------------
console.log('== 3. iterative consistency (bootstrap anchor + add) ==');

// Build a fresh shared-signal pool with KNOWN row offsets. All raw (method 1),
// so the builder's row-space lags are exactly these offsets.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function zscore(v) { const m = v.reduce((a, x) => a + x, 0) / v.length; const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) * (x - m), 0) / (v.length - 1)); return v.map(x => (x - m) / sd); }
function noisyWindow(sig, from, len, seed) {
  const r = rng(seed); const w = [];
  for (let i = 0; i < len; i++) { let s = 0; for (let k = 0; k < 12; k++) s += r(); w.push(sig[from + i] + (s - 6) * 0.18); }
  return zscore(w);
}
const SIG_N = 140; const rr = rng(7);
const signal = []; for (let i = 0; i < SIG_N; i++) { let s = 0; for (let k = 0; k < 12; k++) s += rr(); signal.push(s - 6); }

// anchor A: rows 0..99 (offset 0); B: 20..99; C: 40..119; D: 10..109.
const specs = { A: [0, 100], B: [20, 80], C: [40, 80], D: [10, 100] };
const expectLag = { A: 0, B: 20, C: 40, D: 10 };
const undatedCols = [{ name: 'increment', values: [] }];
const maxLen = Math.max(...Object.values(specs).map(s => s[1]));
undatedCols[0].values = Array.from({ length: maxLen }, (_, i) => i + 1);
let seed = 500;
for (const id of ['A', 'B', 'C', 'D']) {
  const [from, len] = specs[id];
  const vals = noisyWindow(signal, from, len, seed += 13);
  const padded = vals.concat(Array(maxLen - len).fill(null));
  undatedCols.push({ name: id, values: padded });
}
const undated2 = require('../src/analysis/comb.js').frame(undatedCols);

const b2 = createBuilder({ undated: undated2, detrend: { detrending_select: 1 } });
b2.setAnchor('A');
const addLags = { A: 0 };
for (const id of ['B', 'C', 'D']) {
  const s = b2.crossdate(id);
  addLags[id] = s.suggestions[0].lag;
  b2.approve(id, s.suggestions[0].lag);
}
const st = b2.state();
check('member set is A,B,C,D', st.members.map(m => m.id).sort().join(',') === 'A,B,C,D');
check('pool empty after adding all', st.poolIds.length === 0);
for (const id of ['A', 'B', 'C', 'D']) {
  check(`recorded lag for ${id} == expected ${expectLag[id]}`, addLags[id] === expectLag[id], `got ${addLags[id]}`);
}

// final mean determinism: two independent builds produce an identical mean.
function buildOnce() {
  const bb = createBuilder({ undated: undated2, detrend: { detrending_select: 1 } });
  bb.setAnchor('A');
  for (const id of ['B', 'C', 'D']) { const s = bb.crossdate(id); bb.approve(id, s.suggestions[0].lag); }
  return bb.meanChronology();
}
const m1 = buildOnce(), m2 = buildOnce();
const meanStable = JSON.stringify(m1) === JSON.stringify(m2);
check('final mean chronology is deterministic across rebuilds', meanStable);

// re-crossdate an included member: remove D, crossdate it vs A,B,C -> same lag.
b2.remove('D');
check('D returned to pool by remove()', b2.state().poolIds.includes('D') && b2.state().members.length === 3);
const reD = b2.crossdate('D').suggestions[0].lag;
check('re-crossdating removed member D recovers its placement lag', reD === expectLag.D, `got ${reD} expected ${expectLag.D}`);

// a series IDENTICAL to the anchor window (offset 0) must crossdate at lag 0.
const frame = require('../src/analysis/comb.js').frame;
const anchorWin = noisyWindow(signal, 0, 100, 3);
const combFrame = frame([
  { name: 'increment', values: Array.from({ length: 100 }, (_, i) => i + 1) },
  { name: 'A0', values: anchorWin.slice() },
  { name: 'E0', values: noisyWindow(signal, 0, 100, 777) },   // same span, offset 0
]);
const b6 = createBuilder({ undated: combFrame, detrend: { detrending_select: 1 } });
b6.setAnchor('A0');
const e0 = b6.crossdate('E0').suggestions[0].lag;
check('series sharing the anchor span (offset 0) crossdates at lag 0', e0 === 0, `got ${e0}`);

// ----------------------------------------------------------------------------
// 4 : calendar dating by pinning a known member's ring (feature 1)
// ----------------------------------------------------------------------------
console.log('== 4. calendar dating (setDatum / calendarYear / datedChronology) ==');

function buildABCD() {
  const bb = createBuilder({ undated: undated2, detrend: { detrending_select: 1 } });
  bb.setAnchor('A');
  for (const id of ['B', 'C', 'D']) { const s = bb.crossdate(id); bb.approve(id, s.suggestions[0].lag); }
  return bb;
}
const b4 = buildABCD();
const memA = b4.summary().members.find(m => m.id === 'A');
const memB = b4.summary().members.find(m => m.id === 'B');
const firstPosA = memA.firstPos, lastPosA = memA.lastPos, firstPosB = memB.firstPos;

check('undated before setDatum', !b4.isDated() && b4.datum() === null);
b4.setDatum({ seriesId: 'A', edge: 'first', year: 800 });
check('isDated() true after setDatum', b4.isDated() && b4.datum().seriesId === 'A');
check("pinned series' first ring calendarYear == 800", b4.calendarYear(firstPosA) === 800, `got ${b4.calendarYear(firstPosA)}`);
check('a ring 25 positions later dates to 825', b4.calendarYear(firstPosA + 25) === 825, `got ${b4.calendarYear(firstPosA + 25)}`);
check('member B first ring dates to 800 + (posB - posA)', b4.calendarYear(firstPosB) === 800 + (firstPosB - firstPosA),
  `got ${b4.calendarYear(firstPosB)} expected ${800 + (firstPosB - firstPosA)}`);

// datedChronology col 0 == relative axis + offset
const rel = b4.chronology(), dcy = b4.datedChronology();
const off = 800 - firstPosA;
let colMax = 0;
for (let r = 0; r < rel.cols[0].length; r++) colMax = Math.max(colMax, Math.abs(dcy.cols[0][r] - (rel.cols[0][r] + off)));
check('datedChronology() col 0 == calendar years (relative + offset)', colMax === 0 && dcy.cols[0][0] === rel.cols[0][0] + off);

// edge:'last' pins the most recent ring
b4.setDatum({ seriesId: 'A', edge: 'last', year: 900 });
check("edge:'last' sets the last ring correctly", b4.calendarYear(lastPosA) === 900, `got ${b4.calendarYear(lastPosA)}`);

// members report calendar first/last year when dated
const smA = b4.summary().members.find(m => m.id === 'A');
check('dated member reports calendar first/last year', smA.firstYear === b4.calendarYear(firstPosA) && smA.lastYear === 900);

// removing the datum's series invalidates the datum
b4.setDatum({ seriesId: 'A', edge: 'first', year: 800 });
const stRm = b4.remove('A');
check('removing datum series clears the datum', !b4.isDated() && b4.datum() === null && stRm.datumInvalidated === true);
check('datedChronology() returns relative frame when undated', JSON.stringify(b4.datedChronology().cols[0]) === JSON.stringify(b4.chronology().cols[0]));

// guards
let g1 = false; try { b4.setDatum({ seriesId: 'A', edge: 'first', year: 800 }); } catch (e) { g1 = true; }  // A no longer a member
check('setDatum rejects a non-member seriesId', g1);
let g2 = false; try { buildABCD().setDatum({ seriesId: 'A', edge: 'first', year: 1.5 }); } catch (e) { g2 = true; }
check('setDatum rejects a non-integer year', g2);

// ----------------------------------------------------------------------------
// 5 : per-series disposition + notes (feature 2)
// ----------------------------------------------------------------------------
console.log('== 5. dispositions (skip / flagReview / restore / notes) ==');

const bp = createBuilder({ undated: undated2, detrend: { detrending_select: 1 } });
bp.setAnchor('A');
bp.skip('B', 'bad correlation');
bp.flagReview('C', 'check by eye');
const sp = bp.state();
const aB = sp.setAside.find(x => x.id === 'B');
const aC = sp.setAside.find(x => x.id === 'C');
check('skip moves B aside with status+note', aB && aB.status === 'skipped' && aB.note === 'bad correlation');
check('flagReview moves C aside with status+note', aC && aC.status === 'review' && aC.note === 'check by eye');
check('set-aside series drop out of the live pool', sp.poolIds.includes('D') && !sp.poolIds.includes('B') && !sp.poolIds.includes('C'));
check('statusOf reflects dispositions', bp.statusOf('B') === 'skipped' && bp.statusOf('C') === 'review' && bp.statusOf('A') === 'member' && bp.statusOf('D') === 'pool');

let cxThrew = false; try { bp.crossdate('B'); } catch (e) { cxThrew = true; }
check('a skipped series cannot be crossdated until restored', cxThrew);

bp.setNote('B', 'reassessed');
check('setNote updates a set-aside note', bp.state().setAside.find(x => x.id === 'B').note === 'reassessed');

bp.restore('B');
check('restore returns B to the live pool', bp.state().poolIds.includes('B') && !bp.state().setAside.find(x => x.id === 'B'));
const lagB = bp.crossdate('B').suggestions[0].lag;
check('restored series can be crossdated again', Number.isInteger(lagB));

// ----------------------------------------------------------------------------
// 6 : automated build (feature 3) on the shipped example data
// ----------------------------------------------------------------------------
console.log('== 6. autoBuild on undated_example.csv ==');

const undEx = loadUndatedCsv(path.join(__dirname, 'fixtures', 'extdata', 'undated_example.csv'));
const ba = createBuilder({ undated: undEx, detrend: { detrending_select: 1 } });
const auto = ba.autoBuild({ r_val: 0.5, p_val: 0.05, overlap: 30 });
check('autoBuild adds >= 2 series', auto.added.length >= 2, `added=${auto.added.map(a => a.id).join(',')}`);
let allPass = auto.added.length > 0;
for (const a of auto.added) if (!(a.R >= 0.5 && a.P <= 0.05)) allPass = false;
check('every added member passes the R/P thresholds', allPass);
check('members recorded with lag + stats', auto.added.every(a => Number.isInteger(a.lag) && typeof a.R === 'number'));

// internal consistency: an added member sits at lag 0 vs the mean of the rest
const chrA = ba.chronology();
const someMember = auto.added[0].id;
check('re-crossdating an added member vs the rest gives lag 0', lagVsRest(chrA, someMember) === 0, `got ${lagVsRest(chrA, someMember)}`);

// autoBuild leaves the builder in a normal editable state
const nMembersBefore = ba.state().members.length;
ba.remove(someMember);
check('members remain editable after autoBuild (remove works)',
  ba.state().members.length === nMembersBefore - 1 && ba.state().poolIds.includes(someMember));
// determinism
const ba2 = createBuilder({ undated: loadUndatedCsv(path.join(__dirname, 'fixtures', 'extdata', 'undated_example.csv')), detrend: { detrending_select: 1 } });
const auto2 = ba2.autoBuild({ r_val: 0.5, p_val: 0.05, overlap: 30 });
check('autoBuild is deterministic', JSON.stringify(auto.added) === JSON.stringify(auto2.added));

// ----------------------------------------------------------------------------
// 7 : report summary (feature 4)
// ----------------------------------------------------------------------------
console.log('== 7. summary() ==');

const smUndated = ba2.summary();
check('summary members carry id + lag + positions', smUndated.members.length > 0 && smUndated.members.every(m => Number.isInteger(m.firstPos) && Number.isInteger(m.lastPos)));
check('undated summary: dated=false, positional span, null years', smUndated.dated === false && smUndated.span.firstPos != null && smUndated.members[0].firstYear === null);
check('summary stats do not throw and yield numeric rbar/eps', smUndated.stats && !('error' in smUndated.stats)
  && typeof smUndated.stats.rbar === 'number' && typeof smUndated.stats.eps === 'number' && smUndated.stats.sampleDepth >= 1,
  `stats=${JSON.stringify(smUndated.stats)}`);

const b7 = buildABCD();
b7.setDatum({ seriesId: 'A', edge: 'first', year: 800 });
const smDated = b7.summary();
check('dated summary: dated=true, calendar span + member years', smDated.dated === true
  && smDated.span.firstYear != null && smDated.members.every(m => Number.isInteger(m.firstYear)));
check('dated summary carries the datum', smDated.datum && smDated.datum.seriesId === 'A' && smDated.datum.offset === 800 - firstPosA);

console.log(anyFail ? '\nFAIL' : '\nPASS: builder crossdate/placement match R; iterative build consistent; dating, dispositions, autoBuild, summary OK.');
process.exit(anyFail ? 1 : 0);
