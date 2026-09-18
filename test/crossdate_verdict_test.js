'use strict';
// ============================================================================
// crossdateVerdict — measured, not asserted.
//
// The point of the verdict layer is that it separates real dating errors from
// the noise COFECHA flags. That claim is only worth anything if it is measured
// both ways, so this suite does exactly that on real ITRDB data:
//
//   FALSE POSITIVES  every series of ut550 (published, already crossdated) must
//                    come back 'dated'. COFECHA raises 25 flags on this file,
//                    all of which fail its own p.215 test.
//   FALSE NEGATIVES  a ring removed from, or inserted into, a clean series must
//                    be detected, bracketed, and classified in the right
//                    direction — swept over several series, positions and both
//                    error types.
//
// The sweep is the slow part (each case re-runs cofecha over 114 series), so the
// breadth is tuned to stay near a minute. Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');
const RD = require('../src/index.js');
const { crossdateVerdict, traceRidge, verdictFrom } = require('../src/stats/crossdateVerdict.js');

let allPass = true;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (!ok) { allPass = false; log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else log('  ok    ' + name);
}

// ---------------------------------------------------------------------------
// Unit level: the ridge trace and the verdict rules, on synthetic ridges.
// ---------------------------------------------------------------------------
log('# ridge tracing and verdict rules');
{
  // a heatmap frame is {year, lag, R}; build one whose best lag steps at 1500
  const year = [], lag = [], r = [];
  for (let y = 1000; y <= 1999; y++) {
    for (let L = -3; L <= 3; L++) {
      const bestLag = y < 1500 ? 0 : 1;
      year.push(y); lag.push(L); r.push(L === bestLag ? 0.8 : 0.1);
    }
  }
  const hm = { names: ['year', 'lag', 'R val'], cols: [year, lag, r] };
  const opts = { minRun: 30, minRidgeR: 0.2 };
  const ridge = traceRidge(hm, opts);
  check('ridge compresses into two runs', ridge.runs.length === 2,
    JSON.stringify(ridge.runs.map(x => x.lag + ':' + x.from + '-' + x.to)));
  const v = verdictFrom(ridge, 51, Object.assign({ dominantFrac: 0.9 }, opts));
  check('a stepped ridge is a dating error', v.status === 'dating-error', v.status);
  check('the step is bracketed around the true year',
    v.bracket && 1500 >= v.bracket[0] && 1500 <= v.bracket[1], JSON.stringify(v.bracket));
  check('an upward step reads as a missing ring',
    v.problems[0].kind === 'missing-ring', v.problems[0].kind);

  // a flat ridge at lag 0 is a dated series
  const y2 = [], l2 = [], r2 = [];
  for (let y = 1000; y <= 1999; y++) for (let L = -3; L <= 3; L++) { y2.push(y); l2.push(L); r2.push(L === 0 ? 0.8 : 0.1); }
  const flat = traceRidge({ names: ['year', 'lag', 'R val'], cols: [y2, l2, r2] }, opts);
  check('a flat ridge at lag 0 is dated',
    verdictFrom(flat, 51, Object.assign({ dominantFrac: 0.9 }, opts)).status === 'dated');

  // a flat ridge at a non-zero lag is a whole-series offset, not a dating error
  const y3 = [], l3 = [], r3 = [];
  for (let y = 1000; y <= 1999; y++) for (let L = -3; L <= 3; L++) { y3.push(y); l3.push(L); r3.push(L === 2 ? 0.8 : 0.1); }
  const off = verdictFrom(traceRidge({ names: ['year', 'lag', 'R val'], cols: [y3, l3, r3] }, opts), 51,
    Object.assign({ dominantFrac: 0.9 }, opts));
  check('a flat ridge off zero is an offset, not a dating error', off.status === 'offset', off.status);
}

// ---------------------------------------------------------------------------
// The real data. Skipped when the ITRDB files are not present.
// ---------------------------------------------------------------------------
const RWL = path.join(__dirname, '..', 'chronologies', 'ut550.rwl');
if (!fs.existsSync(RWL)) {
  log('\n# real data — skipped (chronologies/ut550.rwl not present)');
  log(allPass ? '\nAll crossdateVerdict checks passed.' : '\nFAILURES above.');
  process.exit(allPass ? 0 : 1);
}

const frame = RD.readRWL(fs.readFileSync(RWL, 'utf8'), { fileName: 'ut550.rwl' });
const base = RD.cofecha(frame);

log('\n# false positives — ut550 is published and already crossdated');
{
  const v = crossdateVerdict(base);
  const notDated = v.series.filter(s => s.status !== 'dated');
  check('every one of the 114 series comes back dated',
    notDated.length === 0,
    notDated.map(s => s.id + ':' + s.status).join(', '));
  check('nothing is escalated for attention', v.summary.nAttention === 0,
    v.summary.attention.join(', '));
  log('        (COFECHA raises 25 flags on this same file; all 12 of its B flags');
  log('         have alternate/dated ratios of 1.0-1.3, failing its own p.215 test)');

  // the nine series that carry those twelve B flags must specifically be clean
  const noisy = ['RCB103C', 'RCB112B', 'RCB119A', 'RCB178B', 'RCB183A',
    'RCB188A', 'RCB194A', 'RCB194B', 'RCB195A'];
  const bad = noisy.filter(id => {
    const s = v.series.find(x => x.id === id);
    return s && s.status !== 'dated';
  });
  check('the series carrying COFECHA B flags are all dated', bad.length === 0, bad.join(', '));

  check('no spurious duplicate or inverted series reported',
    v.collection.length === 0, JSON.stringify(v.collection.map(c => c.kind)));
}

// A short but well-dated series must not be escalated just for being short:
// the sustained-run threshold scales to the ridge available, and a series
// shorter than the window gets a narrower window rather than no verdict.
{
  const RWL585 = path.join(__dirname, '..', 'chronologies', 'ut585.rwl');
  if (fs.existsSync(RWL585)) {
    const f585 = RD.readRWL(fs.readFileSync(RWL585, 'utf8'), { fileName: 'ut585.rwl' });
    const v585 = crossdateVerdict(RD.cofecha(f585));
    const short = v585.series.filter(s => (s.last - s.first) < 100 && s.corrWithMaster > 0.7);
    check('short but well-correlated series are still dated',
      short.length > 0 && short.every(s => s.status === 'dated'),
      short.map(s => s.id + ' ' + (s.last - s.first + 1) + 'y r=' +
        s.corrWithMaster.toFixed(2) + ' -> ' + s.status).join(', '));
    check('a series shorter than the window gets a narrower one, not a shrug',
      v585.series.filter(s => s.win < v585.options.win && s.status !== 'too-short').length > 0);
  }
}

log('\n# false negatives — injected errors must be caught, bracketed and classified');
{
  // a ring missed during crossdating pulls every later ring one year earlier;
  // a false ring counted pushes them one year later
  function inject(id, atYear, extra) {
    const f = { names: frame.names.slice(), cols: frame.cols.map(c => c.slice()) };
    const ci = f.names.indexOf(id), yi = f.cols[0].indexOf(atYear);
    if (ci < 0 || yi < 0) return null;
    if (extra) {
      for (let i = f.cols[ci].length - 1; i > yi; i--) f.cols[ci][i] = f.cols[ci][i - 1];
    } else {
      for (let i = yi; i < f.cols[ci].length - 1; i++) f.cols[ci][i] = f.cols[ci][i + 1];
      f.cols[ci][f.cols[ci].length - 1] = null;
    }
    return f;
  }

  const cand = base.series
    .filter(s => s.nYears > 450 && s.corrWithMaster > 0.7)
    .sort((a, b) => b.nYears - a.nYears).slice(0, 6);
  check('long, well-correlated series available to corrupt', cand.length === 6, String(cand.length));

  let n = 0, caught = 0, bracketed = 0, classified = 0, contaminated = 0;
  const misses = [];
  for (const c of cand) {
    for (const frac of [0.35, 0.65]) {
      const E = Math.round(c.first + frac * (c.last - c.first));
      for (const extra of [false, true]) {
        const f = inject(c.id, E, extra);
        if (!f) continue;
        const v = crossdateVerdict(RD.cofecha(f));
        const s = v.series.find(x => x.id === c.id);
        n++;
        if (s.status === 'dating-error') caught++; else misses.push(c.id + '@' + E + ' -> ' + s.status);
        if (s.bracket && E >= s.bracket[0] && E <= s.bracket[1]) bracketed++;
        const want = extra ? 'extra-ring' : 'missing-ring';
        if (s.problems && s.problems[0] && s.problems[0].kind === want) classified++;
        // one bad series must not drag the others into a verdict
        const others = v.series.filter(x => x.id !== c.id && x.status !== 'dated');
        if (others.length) contaminated++;
      }
    }
  }
  check('every injected error is detected', caught === n, caught + '/' + n +
    (misses.length ? '  missed: ' + misses.join(', ') : ''));
  check('every bracket contains the true error year', bracketed === n, bracketed + '/' + n);
  check('missing vs extra ring classified correctly', classified === n, classified + '/' + n);
  check('one bad series does not contaminate the rest', contaminated === 0,
    contaminated + ' of ' + n + ' cases escalated another series');
  log('        (' + n + ' cases: ' + cand.length + ' series x 2 positions x missing/extra)');
}

log('\n# contract');
{
  check('cofecha() run without keepSeries is rejected with a clear message',
    (() => {
      try { crossdateVerdict(RD.cofecha(frame, { keepSeries: false })); return false; }
      catch (e) { return /keepSeries/.test(e.message); }
    })());
  check('a non-cofecha argument is rejected',
    (() => { try { crossdateVerdict({}); return false; } catch (e) { return true; } })());
  const v = crossdateVerdict(base);
  check('every series carries a heatmap and a ridge for the report',
    v.series.every(s => s.ridge && Array.isArray(s.ridge.runs)));
  check('series are ranked by severity',
    v.series.every((s, i, a) => i === 0 || a[i - 1].severity >= s.severity));
}

log(allPass ? '\nAll crossdateVerdict checks passed.' : '\nFAILURES above.');
process.exit(allPass ? 0 : 1);
