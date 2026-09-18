'use strict';
// ============================================================================
// Validate src/stats/cofecha.js against the published COFECHA description in
// Grissino-Mayer (2001), Tree-Ring Research 57(2):205-221 (GrissinoCOFECHA.pdf).
//
// The paper IS the ground truth here: unlike the other ports there is no R
// oracle to diff against, so each case below cites the page / table it comes
// from. Three kinds of check:
//   1. Table 2 (p. 209)   — the critical correlation coefficients, exactly.
//   2. Tables 3, 5, 8     — the segment layouts implied by the worked examples.
//   3. Behavioural        — a ring deliberately removed from a correctly dated
//                           data set must reproduce the diagnostic signature the
//                           paper describes for a missing ring (pp. 218-221).
// Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { cofecha, criticalR, buildSegments, meanSensitivity } = require('../src/stats/cofecha.js');

let allPass = true;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (!ok) { allPass = false; log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else log('  ok    ' + name);
}

// ---------------------------------------------------------------------------
// 1. Table 2 (p. 209): critical correlation coefficients at the 99% confidence
//    level for selected segment lengths. Printed to 4 dp in the paper.
// ---------------------------------------------------------------------------
log('# Table 2 — critical correlation coefficients (99% one-tailed)');
const TABLE2 = {
  10: 0.7155, 15: 0.5923, 20: 0.5155, 25: 0.4622, 30: 0.4226, 35: 0.3916,
  40: 0.3665, 50: 0.3281, 60: 0.2997, 70: 0.2776, 80: 0.2597, 90: 0.2449,
  100: 0.2324, 120: 0.2122,
};
for (const n of Object.keys(TABLE2).map(Number)) {
  const r = criticalR(n, 0.01);
  check('n = ' + n + ' -> ' + TABLE2[n], Math.abs(r - TABLE2[n]) < 5e-5,
    'got ' + (Number.isFinite(r) ? r.toFixed(6) : r));
}

// ---------------------------------------------------------------------------
// 2. Segment layout (p. 211). The first segment begins at the series start, the
//    last ends at the series end, intermediate segments begin on years evenly
//    divisible by the lag, and every segment is the full selected length.
//    Series spans and segment counts read off Tables 3, 5 and 8.
// ---------------------------------------------------------------------------
log('# Segment layout — worked examples (Tables 3, 5, 8)');
const SEGCASES = [
  // [id, first, last, expected count, expected LAST segment]
  ['LLC001A', 1700, 1876, 7, [1827, 1876]],
  ['LLC001B', 1705, 1858, 6, [1809, 1858]],
  ['LLC002A', 1696, 1857, 7, [1808, 1857]],
  ['LLC003B', 1695, 1887, 8, [1838, 1887]],   // Table 8 header: "1695 to 1887", last 1838 1887
  ['LLC0038B', 1695, 1888, 8, [1839, 1888]],  // Table 5 header: "1695 to 1888", last 1839 1888
];
for (const [id, s, e, expN, expLast] of SEGCASES) {
  const segs = buildSegments(s, e, 50, 25);
  const last = segs[segs.length - 1] || [];
  check(id + ' ' + s + '-' + e + ': ' + expN + ' segments',
    segs.length === expN, 'got ' + segs.length);
  check(id + ' last segment ' + expLast.join('-'),
    last[0] === expLast[0] && last[1] === expLast[1], 'got ' + last.join('-'));
  check(id + ' all segments are 50 years',
    segs.every(g => g[1] - g[0] + 1 === 50), 'got ' + segs.map(g => g[1] - g[0] + 1).join(','));
}
// A series shorter than one segment yields no segments to test.
check('series shorter than the segment length yields none',
  buildSegments(1900, 1930, 50, 25).length === 0);

// ---------------------------------------------------------------------------
// 3. Mean sensitivity (p. 214) — the standard Douglass formula.
// ---------------------------------------------------------------------------
log('# Mean sensitivity');
// Alternating 1,2,1,2,...: every |2(x2-x1)/(x2+x1)| = 2/3.
check('alternating 1,2 -> 2/3',
  Math.abs(meanSensitivity([1, 2, 1, 2, 1, 2]) - 2 / 3) < 1e-12,
  String(meanSensitivity([1, 2, 1, 2, 1, 2])));
check('constant series -> 0', meanSensitivity([5, 5, 5, 5]) === 0);

// ---------------------------------------------------------------------------
// 4. Behavioural: a deliberately misdated series must show the signature the
//    paper describes (pp. 218-221, Tables 4 and 8) — segments before the error
//    stay significant and unflagged; every segment from the error onward is
//    flagged 'B' at a SYSTEMATIC +1 shift with a much higher correlation there.
// ---------------------------------------------------------------------------
log('# Behavioural — injected missing ring');
function loadFixture() {
  const p = path.join(__dirname, 'fixtures', 'vignettes', 'chronologies', 'ExampleChron.csv');
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const names = ['year'].concat(lines[0].split(',').slice(1));
  const cols = names.map(() => []);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    for (let c = 0; c < names.length; c++) {
      const v = f[c];
      cols[c].push(v === '' || v == null ? null : Number(v));
    }
  }
  return { names, cols };
}
// A ring missed during crossdating: from `atYear` on, every measurement is
// pulled one year earlier (the pith-to-bark case of p. 220).
function dropRing(frame, id, atYear) {
  const f = { names: frame.names.slice(), cols: frame.cols.map(c => c.slice()) };
  const ci = f.names.indexOf(id);
  const yi = f.cols[0].indexOf(atYear);
  for (let i = yi; i < f.cols[ci].length - 1; i++) f.cols[ci][i] = f.cols[ci][i + 1];
  f.cols[ci][f.cols[ci].length - 1] = null;
  return f;
}

const OPT = { segLength: 30, segLag: 15 };
const TARGET = 'X001a', ERR_YEAR = 1690;
const clean = loadFixture();

const cleanRes = cofecha(clean, OPT);
const cleanSer = cleanRes.series.find(s => s.id === TARGET);
check('correctly dated data: no flags across the whole run',
  cleanRes.summary.nFlags === 0, cleanRes.summary.nFlags + ' flags');
check('correctly dated ' + TARGET + ': correlates strongly with master',
  cleanSer.corrWithMaster > 0.6, String(cleanSer.corrWithMaster));
check('mean interseries correlation is reported',
  Number.isFinite(cleanRes.summary.meanCorr) && cleanRes.summary.meanCorr > 0.5,
  String(cleanRes.summary.meanCorr));

const dirty = dropRing(clean, TARGET, ERR_YEAR);
const dirtyRes = cofecha(dirty, OPT);
const dirtySer = dirtyRes.series.find(s => s.id === TARGET);

check('misdated ' + TARGET + ': whole-series correlation collapses',
  dirtySer.corrWithMaster < cleanSer.corrWithMaster - 0.25,
  cleanSer.corrWithMaster.toFixed(3) + ' -> ' + dirtySer.corrWithMaster.toFixed(3));
check('misdated ' + TARGET + ': segments are flagged',
  dirtySer.nFlags > 0, 'none flagged');

const flagged = dirtySer.segments.filter(g => g.flag);
check('every flag is a B flag (a better dating position exists)',
  flagged.every(g => g.flag === 'B'), flagged.map(g => g.flag).join(','));
check('every flagged segment points to the SAME +1 shift',
  flagged.length > 1 && flagged.every(g => g.high === 1),
  flagged.map(g => g.high).join(','));
check('the alternate position correlates far better than the dated one',
  flagged.every(g => g.rHigh > g.r + 0.2),
  flagged.map(g => g.r.toFixed(2) + '->' + g.rHigh.toFixed(2)).join(' '));

// Segments wholly before the error must be untouched by it.
const before = dirtySer.segments.filter(g => g.end < ERR_YEAR);
check('segments ending before the error stay unflagged',
  before.length > 0 && before.every(g => !g.flag),
  before.map(g => g.start + '-' + g.end + (g.flag || '')).join(' '));

// The error lies inside the FIRST flagged segment — the inference the paper
// walks through by hand on p. 220 ("the errant ring is located at some midpoint
// in this segment"), and the bracket a caller can rely on.
//
// Note it is NOT the overlap of the last clean segment with the first flagged
// one: a segment counts as clean whenever the shifted tail it contains is too
// short to push its correlation below the critical value, so a clean segment can
// and does straddle the error. On the real ut585 data below, the last clean
// segment ends at 1699 with the error at 1700, which an overlap bracket misses.
const firstFlag = dirtySer.segments.find(g => g.flag);
check('the error year falls inside the first flagged segment',
  firstFlag && ERR_YEAR >= firstFlag.start && ERR_YEAR <= firstFlag.end,
  'first flagged segment ' + (firstFlag && (firstFlag.start + '-' + firstFlag.end)) +
  ' does not contain ' + ERR_YEAR);

// Part 6[B]: the years that most lower the correlation should sit in the
// misdated stretch, not before it.
const lev = dirtySer.problems.leverage.entire;
check('Part 6[B] leverage profile is produced',
  lev && lev.lower.length > 0 && lev.higher.length > 0);
check('the most damaging years lie at or after the error',
  lev && lev.lower.some(y => y.year >= ERR_YEAR),
  lev ? lev.lower.map(y => y.year).join(',') : 'none');

// Other series must NOT be dragged into flagging by one bad member.
const others = dirtyRes.series.filter(s => s.id !== TARGET);
const otherFlags = others.reduce((a, s) => a + s.nFlags, 0);
check('one misdated series does not flag the rest of the collection',
  otherFlags === 0, otherFlags + ' flags on other series');

// ---------------------------------------------------------------------------
// 4b. The same behaviour at ITRDB scale, on real measurements rather than the
//     small vignette set. ut585 is 85 series of Utah pinyon, AD 509-2014; the
//     target is a 717-year series that is clean in the published data. This is
//     the case that caught the bad bracket above, so it is kept as a test.
// ---------------------------------------------------------------------------
log('# Behavioural — injected missing ring, real ITRDB data (ut585)');
{
  const RWL = path.join(__dirname, '..', 'chronologies', 'ut585.rwl');
  if (!fs.existsSync(RWL)) {
    log('  skip  chronologies/ut585.rwl not present');
  } else {
    const RD = require('../src/index.js');
    const fr = RD.readRWL(fs.readFileSync(RWL, 'utf8'), { fileName: 'ut585.rwl' });
    const base = RD.cofecha(fr);
    const tgt = base.series
      .filter(s => s.nYears > 400 && s.corrWithMaster > 0.7 && s.nFlags === 0)
      .sort((a, b) => b.nYears - a.nYears)[0];
    check('a long, clean, well-correlated series is available to corrupt', !!tgt);
    if (tgt) {
      const E = 1700;
      const f2 = { names: fr.names.slice(), cols: fr.cols.map(c => c.slice()) };
      const ci = f2.names.indexOf(tgt.id), yi = f2.cols[0].indexOf(E);
      for (let i = yi; i < f2.cols[ci].length - 1; i++) f2.cols[ci][i] = f2.cols[ci][i + 1];
      f2.cols[ci][f2.cols[ci].length - 1] = null;

      const r2 = RD.cofecha(f2);
      const s2 = r2.series.find(s => s.id === tgt.id);
      const fl = s2.segments.filter(g => g.flag);
      check(tgt.id + ': correlation collapses', s2.corrWithMaster < tgt.corrWithMaster - 0.25,
        tgt.corrWithMaster.toFixed(3) + ' -> ' + s2.corrWithMaster.toFixed(3));
      check(tgt.id + ': a run of segments flags', fl.length >= 5, fl.length + ' flagged');
      check(tgt.id + ': all B flags at a systematic +1',
        fl.every(g => g.flag === 'B' && g.high === 1),
        fl.map(g => (g.flag || '-') + g.high).join(' '));
      const ff = s2.segments.find(g => g.flag);
      check(tgt.id + ': the error lies in the first flagged segment',
        ff && E >= ff.start && E <= ff.end, ff && (ff.start + '-' + ff.end));
      const before = s2.segments.filter(g => g.end < E);
      check(tgt.id + ': every segment ending before the error stays clean',
        before.length > 10 && before.every(g => !g.flag),
        before.filter(g => g.flag).map(g => g.start + '-' + g.end).join(' '));
      const contam = r2.series.filter(s => s.id !== tgt.id).reduce((a, s) => a + s.nFlags, 0);
      const baseline = base.series.filter(s => s.id !== tgt.id).reduce((a, s) => a + s.nFlags, 0);
      check('one misdated series does not flag others at ITRDB scale',
        contam === baseline, contam + ' vs baseline ' + baseline);
    }
  }
}

// ---------------------------------------------------------------------------
// 4c. Against the REAL COFECHA. UT550COF.OUT is the listing produced by
//     Cofecha_MRWE.exe (COFECHA 6.06) on chronologies/ut550.rwl with every Main
//     Menu default accepted. Runs only when both files are present.
//
//     These thresholds are deliberately set at the level established when the
//     comparison was first made, so a regression shows up as a drop. Exact
//     agreement is neither expected nor achievable — COFECHA computes in
//     single-precision Fortran and prints two decimals — so what is pinned is
//     the structural agreement (same series, same intervals, same segments,
//     same sample depth) and the verdict agreement on each segment.
// ---------------------------------------------------------------------------
log('# Against real COFECHA output (ut550)');
{
  const OUT = path.join(__dirname, '..', 'UT550COF.OUT');
  const RWL = path.join(__dirname, '..', 'chronologies', 'ut550.rwl');
  if (!fs.existsSync(OUT) || !fs.existsSync(RWL)) {
    log('  skip  UT550COF.OUT / chronologies/ut550.rwl not present');
  } else {
    const RD = require('../src/index.js');
    const { parse } = require('../tools/cofecha_compare.js');
    const cof = parse(OUT);
    const fr = RD.readRWL(fs.readFileSync(RWL, 'utf8'), { fileName: 'ut550.rwl' });
    const res = RD.cofecha(fr, {});
    const byKey = {};
    res.series.forEach(s => { byKey[s.id + '|' + s.first + '|' + s.last] = s; });

    check('same number of series (114)',
      cof.part7.length === res.series.length && res.series.length === 114,
      'COFECHA ' + cof.part7.length + ', ours ' + res.series.length);
    const matched = cof.part7.filter(c => byKey[c.id + '|' + c.first + '|' + c.last]);
    check('every series matches on id + interval',
      matched.length === cof.part7.length, matched.length + '/' + cof.part7.length);

    const seg = cof.part7.reduce((a, b) => a + b.nSegments, 0);
    check('same total segments tested (3037)',
      seg === res.summary.nSegments, 'COFECHA ' + seg + ', ours ' + res.summary.nSegments);

    // unfiltered statistics are computed from the measurements alone, so these
    // should agree to COFECHA's printed precision
    const near = (f, g, tol) => matched.filter(c => {
      const m = byKey[c.id + '|' + c.first + '|' + c.last];
      return Math.abs(f(c) - g(m)) <= tol;
    }).length;
    check('mean measurement exact', near(c => c.meanMsmt, m => m.stats.meanMsmt, 0.005) === 114);
    check('std dev exact', near(c => c.sdMsmt, m => m.stats.sdMsmt, 0.0005) === 114);
    check('autocorrelation exact', near(c => c.acMsmt, m => m.stats.ac1Msmt, 0.0005) === 114);
    check('mean sensitivity within 0.005',
      near(c => c.meanSens, m => m.stats.meanSens, 0.005) === 114,
      near(c => c.meanSens, m => m.stats.meanSens, 0.005) + '/114');
    check('years exact', near(c => c.nYears, m => m.nYears, 0) === 114);
    check('segments per series exact', near(c => c.nSegments, m => m.nSegments, 0) === 114);

    // sample depth and absent-ring counts are pure counting: they must be exact
    let nD = 0, okD = 0, okA = 0;
    for (let i = 0; i < res.years.length; i++) {
      const c = cof.part3[res.years[i]];
      if (!c) continue;
      nD++;
      if (c.n === res.master.sampleDepth[i]) okD++;
      if (c.ab === res.master.absent[i]) okA++;
    }
    check('sample depth exact on every year', okD === nD, okD + '/' + nD);
    check('absent-ring count exact on every year', okA === nD, okA + '/' + nD);

    // segment-by-segment verdict
    let n = 0, same = 0, within10 = 0;
    for (const k of Object.keys(cof.part5)) {
      const m = byKey[k];
      if (!m) continue;
      const cells = cof.part5[k];
      for (let i = 0; i < Math.min(cells.length, m.segments.length); i++) {
        const c = cells[i], g = m.segments[i];
        if (!Number.isFinite(c.r) || !Number.isFinite(g.r)) continue;
        n++;
        if (Math.abs(c.r - g.r) <= 0.10) within10++;
        if (!!c.flag === !!g.flag && (!c.flag || c.flag === g.flag)) same++;
      }
    }
    check('segment correlations within 0.10 on >=80%',
      100 * within10 / n >= 80, (100 * within10 / n).toFixed(1) + '%');
    check('same flag verdict on >=98% of segments',
      100 * same / n >= 98, (100 * same / n).toFixed(1) + '% of ' + n);

    const cs = cof.part7.reduce((a, b) => a + b.meanSens, 0) / cof.part7.length;
    check('run mean sensitivity within 0.005',
      Math.abs(cs - res.summary.meanSens) <= 0.005,
      'COFECHA ' + cs.toFixed(4) + ', ours ' + res.summary.meanSens.toFixed(4));
    const cc = cof.part7.reduce((a, b) => a + b.corr, 0) / cof.part7.length;
    check('run mean interseries correlation within 0.03',
      Math.abs(cc - res.summary.meanCorr) <= 0.03,
      'COFECHA ' + cc.toFixed(4) + ', ours ' + res.summary.meanCorr.toFixed(4));
  }
}

// ---------------------------------------------------------------------------
// 5. Output contract — the pieces the report renderer depends on.
// ---------------------------------------------------------------------------
log('# Output contract');
check('master carries index, z, sample depth and absent counts',
  cleanRes.master.index.length === cleanRes.years.length &&
  cleanRes.master.z.length === cleanRes.years.length &&
  cleanRes.master.sampleDepth.length === cleanRes.years.length &&
  cleanRes.master.absent.length === cleanRes.years.length);
check('time spans are reported for Part 2',
  cleanRes.timeSpans.length === cleanRes.series.length);
check('the Part 5 display grid steps by the lag',
  cleanRes.grid.binStarts.every((b, i, a) => i === 0 || b - a[i - 1] === cleanRes.grid.segLag));
check('every segment is assigned a grid column',
  cleanRes.series.every(s => s.segments.every(g => Number.isInteger(g.col))));
check('per-series descriptive statistics are present',
  cleanRes.series.every(s => Number.isFinite(s.stats.meanMsmt) &&
    Number.isFinite(s.stats.sdMsmt) && Number.isFinite(s.stats.meanSens)));
check('fewer than two series is rejected',
  (() => { try { cofecha({ names: ['year', 'a'], cols: [[1, 2], [1, 2]] }); return false; } catch (e) { return true; } })());

log(allPass ? '\nAll COFECHA checks passed.' : '\nFAILURES above.');
process.exit(allPass ? 0 : 1);
