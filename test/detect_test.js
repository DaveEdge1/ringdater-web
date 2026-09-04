'use strict';
// ============================================================================
// detect_test.js — detectDetrended(): which columns are ALREADY indices?
//
// There is no R oracle for this: ringdateR detrends whatever it is given, and
// noticing that it should not is new behaviour. So these are BEHAVIOURAL checks
// of the rules in src/detrend/detect.js, run over real data wherever possible —
// the bundled example pool (raw widths in mm), the vignette series (raw widths
// in hundredths), and this app's own detrended output under every method.
//
// The asymmetry that shapes every rule: failing to notice an index costs a
// little signal, while mistaking ring widths for an index leaves a growth trend
// in the data and can cost the DATE. So the false-positive checks below matter
// more than the false-negative ones, and there are more of them.
// ============================================================================
const fs = require('fs');
const path = require('path');
const RD = require('../src/index.js');
const { detectDetrended, colStats } = require('../src/detrend/detect.js');
const { normalise } = require('../src/detrend/normalise.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const FIX = path.join(__dirname, 'fixtures');

// ---- the data ---------------------------------------------------------------
const EX = require('../web/exampleData.js');
const pool = RD.loadUndated([EX]);                                  // raw mm
const vign = RD.loadUndated([{
  name: 'UndatedSeries.csv',
  text: fs.readFileSync(path.join(FIX, 'vignettes/UndatedSeries.csv'), 'utf8'),
}]);                                                                // raw, 1/100 mm
const chron = RD.loadChron({
  name: 'ExampleChron.csv',
  text: fs.readFileSync(path.join(FIX, 'vignettes/chronologies/ExampleChron.csv'), 'utf8'),
});                                                                 // raw members

function names(frame) { return frame.names.slice(1); }
function reasonsOf(hit) {
  const set = {};
  hit.names.forEach(n => { set[hit.reasons[n]] = true; });
  return Object.keys(set).sort().join(' | ');
}

console.log('detectDetrended');

// ---- 1. raw ring widths are never flagged ----------------------------------
// The costly mistake, so it is checked on three real files and in two unit
// systems. The example pool averages 0.88 mm — individual series scatter around
// 1.0, which is exactly the coincidence the frame rule has to survive.
ok('the example pool (raw widths, mm) is left alone',
  detectDetrended(pool, { source: 'undated_example.csv' }).names.length === 0,
  JSON.stringify(detectDetrended(pool, {}).names));
ok('the vignette series (raw widths, 1/100 mm) are left alone',
  detectDetrended(vign, { source: 'UndatedSeries.csv' }).names.length === 0,
  JSON.stringify(detectDetrended(vign, {}).names));
ok('a chronology of raw members is left alone',
  detectDetrended(chron, { source: 'ExampleChron.csv' }).names.length === 0,
  JSON.stringify(detectDetrended(chron, {}).names));
ok('...and every series in the pool was actually judged, not skipped as too short',
  detectDetrended(pool, {}).judged === names(pool).length,
  detectDetrended(pool, {}).judged + ' of ' + names(pool).length);

// A single ring-width series that happens to average 1.00 mm is ORDINARY. The
// frame rule must not fire on it, which is why it is a rule about the file.
const one = (frame, i) => ({ names: [frame.names[0], frame.names[i]], cols: [frame.cols[0], frame.cols[i]] });
const scaled = (frame, i, f) => ({
  names: [frame.names[0], frame.names[i]],
  cols: [frame.cols[0], frame.cols[i].map(v => (v == null ? null : v * f))],
});
const s1 = colStats(pool.cols[1]);
const mm1 = scaled(pool, 1, 1 / s1.mean);            // same series, mean exactly 1
ok('one ring-width series averaging 1.0 mm is not called an index',
  detectDetrended(mm1, { source: 'core.rwl' }).names.length === 0,
  JSON.stringify(detectDetrended(mm1, {}).reasons));

// ---- 2. our own detrended output is always flagged -------------------------
// Every method but "none" ends in z-scores + 1, so the output goes negative and
// has mean 1 / SD 1. Reloading a detrended CSV and detrending it again is the
// mistake this rule exists to stop.
[2, 3, 4, 5, 6, 7].forEach(sel => {
  const det = normalise(pool, { detrending_select: sel, splinewindow: 11 });
  const hit = detectDetrended(det, { source: 'detrended.csv' });
  ok('detrended output (method ' + sel + ') is flagged, every series',
    hit.all && hit.names.length === names(det).length,
    hit.names.length + '/' + names(det).length + ' ' + reasonsOf(hit));
});
ok('...on evidence a width series cannot produce',
  ['negative values', 'z-scores (mean 1, SD 1)'].indexOf(
    reasonsOf(detectDetrended(normalise(pool, { detrending_select: 3, splinewindow: 11 }), {}))) >= 0,
  reasonsOf(detectDetrended(normalise(pool, { detrending_select: 3, splinewindow: 11 }), {})));
// "No detrending" leaves ring widths as ring widths — nothing to notice.
ok('...but method 1 output is still raw widths, and is left alone',
  detectDetrended(normalise(pool, { detrending_select: 1 }), {}).names.length === 0);

// A single negative value is enough on its own: a ring cannot be narrower than
// nothing, so whatever produced it was not a measurement.
const neg = { names: pool.names.slice(0, 2), cols: [pool.cols[0], pool.cols[1].slice()] };
neg.cols[1] = neg.cols[1].map((v, i) => (i === 40 && v != null ? -0.2 : v));
ok('one negative value flags a column on its own',
  detectDetrended(neg, {}).names.length === 1 &&
  detectDetrended(neg, {}).reasons[neg.names[1]] === 'negative values',
  JSON.stringify(detectDetrended(neg, {}).reasons));

// ---- 3. positive ratio indices: the frame rule ------------------------------
// dplR-style RWI never goes negative and is not z-scored, so neither per-column
// rule sees it. What gives it away is the FILE: a whole set of series averaging
// 1.0 is in index units, because ring widths do not agree on a mean like that.
const rwi = (function () {
  const det = normalise(pool, { detrending_select: 3, splinewindow: 11 });
  const out = { names: det.names.slice(), cols: [det.cols[0].slice()] };
  for (let i = 1; i < det.names.length; i++) {
    out.cols.push(det.cols[i].map(v => (v == null ? null : 1 + 0.25 * (v - 1))));
  }
  return out;
})();
ok('a file of positive ratio indices is flagged by the file rule',
  detectDetrended(rwi, { source: 'rwi.csv' }).all &&
  reasonsOf(detectDetrended(rwi, {})) === 'index units (the file averages 1.0)',
  reasonsOf(detectDetrended(rwi, {})));
ok('...and none of those values is negative, so no other rule could have',
  colStats(rwi.cols[1]).min > 0, String(colStats(rwi.cols[1]).min));
// One such column ALONE is indistinguishable from a 1 mm ring-width series.
// Conservative wins: say nothing.
ok('one index column on its own is not enough to say',
  detectDetrended(one(rwi, 1), {}).names.length === 0);
// A single index among raw widths does not make the file an index file.
const mixed = {
  names: pool.names.slice(0, 6).concat(['an_index']),
  cols: pool.cols.slice(0, 6).map(c => c.slice()).concat([rwi.cols[1].slice()]),
};
ok('one index among five raw series does not tip the file rule',
  detectDetrended(mixed, {}).names.length === 0,
  JSON.stringify(detectDetrended(mixed, {}).names));

// ---- 4. provenance ----------------------------------------------------------
// The Tucson chronology format holds standardised indices by definition, and
// our reader divides the x1000 back out. The extension is the evidence, so a
// single-column .crn — the common case — is caught where the values alone
// could not be.
ok('a single column from a .crn is flagged on the format alone',
  detectDetrended(one(rwi, 1), { source: 'site.crn' }).all &&
  reasonsOf(detectDetrended(one(rwi, 1), { source: 'site.crn' })) === 'standardised chronology (.crn)');
ok('...case and path do not matter',
  detectDetrended(one(rwi, 1), { source: 'C:/data/SITE.CRN' }).all);
ok('...and the same column from a .rwl is not',
  detectDetrended(one(rwi, 1), { source: 'site.rwl' }).names.length === 0);

// ---- 5. degenerate input ----------------------------------------------------
ok('a frame with no series returns nothing', detectDetrended({ names: ['year'], cols: [[1, 2]] }, {}).judged === 0);
ok('a null frame is not an error', detectDetrended(null, {}).names.length === 0);
ok('a series too short to judge is not judged',
  detectDetrended({ names: ['year', 's'], cols: [[1, 2, 3], [-1, 2, 3]] }, {}).judged === 0);
ok('an all-NA column is not judged',
  detectDetrended({ names: ['year', 's'], cols: [[1, 2, 3, 4, 5, 6], [null, null, null, null, null, null]] }, {}).judged === 0);

// ---- 6. normalise(skip) -----------------------------------------------------
// What the detection is FOR. A skipped column keeps its own shape — no curve
// fitted, no difference taken — but joins the frame's scale, so a mean
// chronology is not dominated by whichever members were detrended.
const half = names(pool).slice(0, 4);
const det = normalise(pool, { detrending_select: 3, splinewindow: 11, skip: half });
const plain = normalise(pool, { detrending_select: 3, splinewindow: 11 });
const col = (f, n) => f.cols[f.names.indexOf(n)];
const corr = (a, b) => {
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) { xs.push(a[i]); ys.push(b[i]); }
  const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
};
const rawCol = col(pool, half[0]).filter(v => v != null);
ok('a skipped column keeps the shape of the RAW series',
  Math.abs(corr(col(det, half[0]).filter(v => v != null), rawCol) - 1) < 1e-9,
  String(corr(col(det, half[0]).filter(v => v != null), rawCol)));
ok('...where the detrended one does not',
  Math.abs(corr(col(plain, half[0]).filter(v => v != null), rawCol)) < 0.95,
  String(corr(col(plain, half[0]).filter(v => v != null), rawCol)));
const stat = n => colStats(col(det, n));
ok('...but is on the same scale as its neighbours (mean 1, SD 1)',
  Math.abs(stat(half[0]).mean - 1) < 1e-9 && Math.abs(stat(half[0]).sd - 1) < 1e-9,
  stat(half[0]).mean + ' / ' + stat(half[0]).sd);
const untouched = names(pool).slice(4);
ok('...and the columns not named are detrended exactly as before',
  untouched.every(n => col(det, n).every((v, i) => v === col(plain, n)[i])));
ok('skipping every series still rescales, so nothing is left on a foreign scale',
  (function () {
    const all = normalise(pool, { detrending_select: 3, splinewindow: 11, skip: names(pool) });
    return names(pool).every(n => Math.abs(colStats(col(all, n)).mean - 1) < 1e-9);
  })());
ok('under "No detrending" skip changes nothing at all',
  (function () {
    const a = normalise(pool, { detrending_select: 1, skip: half });
    const b = normalise(pool, { detrending_select: 1 });
    return names(pool).every(n => col(a, n).every((v, i) => v === col(b, n)[i]));
  })());
ok('a skip naming a series that is not there is harmless',
  (function () {
    const a = normalise(pool, { detrending_select: 3, splinewindow: 11, skip: ['nope'] });
    return names(pool).every(n => col(a, n).every((v, i) => v === col(plain, n)[i]));
  })());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
