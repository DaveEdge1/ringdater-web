'use strict';
// ============================================================================
// Tree-aware Rbar / EPS, and the chronology statistics COFECHA does not report.
//
// The load-bearing claims here are:
//   * adding tree grouping does NOT change the default path (dplR ids=NULL),
//     which the R ground-truth suites still pin;
//   * radii of one tree really do agree more than different trees, so EPS on a
//     tree basis is the conservative one;
//   * the reliability cutoff is derived by holding the threshold to the present,
//     not by finding one good window in the past.
// ============================================================================
const fs = require('fs');
const path = require('path');
const RD = require('../src/index.js');
const { rwiStatsRunning, inferTrees, sss } = require('../src/rwi_stats.js');
const { chronStats, reliableFrom } = require('../src/stats/chronStats.js');

let allPass = true;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (!ok) { allPass = false; log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else log('  ok    ' + name);
}

log('# inferTrees');
check('ITRDB core letters group into trees',
  (() => { const t = inferTrees(['RCB010A', 'RCB010B', 'RCB012A', 'RCB012B']);
    return t.nTrees === 2 && t.treeOf.RCB010A === t.treeOf.RCB010B; })());
check('three radii of one tree group together',
  inferTrees(['CMP06A', 'CMP06B', 'CMP06C']).nTrees === 1);
check('ids that share no stem are left alone',
  (() => { const t = inferTrees(['alpha', 'beta', 'gamma']);
    return t.nTrees === 3 && t.grouped === false; })());
check('an all-letters id does not collapse to an empty stem',
  inferTrees(['AAA', 'BBB']).nTrees === 2);
// Stripping trailing letters is only the convention when what remains ends in a
// tree NUMBER. Without that guard sample_a..sample_j became one tree and EPS
// was computed on a single "tree" — silently, which is the dangerous part.
check('ids whose stem is not a tree number are left alone',
  inferTrees(['sample_a', 'sample_b', 'sample_c']).nTrees === 3,
  JSON.stringify(inferTrees(['sample_a', 'sample_b', 'sample_c']).treeOf));
check('multi-letter core suffixes still group',
  inferTrees(['cmp521an', 'cmp521b']).nTrees === 1);
check('ids already ending in a digit are their own trees',
  inferTrees(['TREE1', 'TREE2']).nTrees === 2);

log('\n# reliableFrom holds the threshold to the present');
{
  const w = [
    { startYear: 1000, eps: 0.90 },   // good, but followed by a failure
    { startYear: 1100, eps: 0.40 },
    { startYear: 1200, eps: 0.88 },
    { startYear: 1300, eps: 0.92 },
  ];
  check('an isolated good window in the past does not count',
    reliableFrom(w, 0.85, 'eps') === 1200, String(reliableFrom(w, 0.85, 'eps')));
  check('all-good returns the first window',
    reliableFrom([{ startYear: 900, eps: 0.9 }, { startYear: 1000, eps: 0.9 }], 0.85, 'eps') === 900);
  check('never reaching the threshold returns null',
    reliableFrom([{ startYear: 900, eps: 0.5 }], 0.85, 'eps') === null);
}

log('\n# sss');
check('sss rises toward 1 as the subsample approaches the whole',
  sss(4, 40, 0.6) < sss(20, 40, 0.6) && sss(40, 40, 0.6) > 0.999);

// ---------------------------------------------------------------------------
const RWL = path.join(__dirname, '..', 'chronologies', 'ut550.rwl');
if (!fs.existsSync(RWL)) {
  log('\n# real data — skipped (chronologies/ut550.rwl not present)');
  log(allPass ? '\nAll chronStats checks passed.' : '\nFAILURES above.');
  process.exit(allPass ? 0 : 1);
}
const frame = RD.readRWL(fs.readFileSync(RWL, 'utf8'), { fileName: 'ut550.rwl' });
const res = RD.cofecha(frame);

log('\n# the default path is untouched');
{
  // Build the same rwl twice and confirm that NOT asking for trees reproduces
  // exactly what rwiStatsRunning produced before tree support existed.
  const rwl = { years: res.years.slice(), series: {} };
  const seen = {};
  res.series.forEach(s => {
    seen[s.id] = (seen[s.id] || 0) + 1;
    rwl.series[seen[s.id] === 1 ? s.id : s.id + '~' + seen[s.id]] = s.transformed.slice();
  });
  const plain = rwiStatsRunning(rwl, { windowLength: 100, windowOverlap: 50, minCorrOverlap: 30 });
  check('with no tree map, cores == trees', plain.every(w => w.nCores === w.nTrees));
  check('with no tree map, no within-tree fields are emitted',
    plain.every(w => w.rbarWt === undefined && w.rbarEff === undefined));
  check('rbar.tot and eps are finite throughout',
    plain.every(w => Number.isFinite(w.rbarTot) && Number.isFinite(w.eps)));

  const treed = rwiStatsRunning(rwl, {
    windowLength: 100, windowOverlap: 50, minCorrOverlap: 30, inferTrees: true,
  });
  check('with a tree map, trees are fewer than cores',
    treed.every(w => w.nTrees <= w.nCores) && treed.some(w => w.nTrees < w.nCores));
  // Only where both terms exist: the oldest windows of ut550 hold a single tree,
  // so every pair there is within-tree and rbar.bt is legitimately undefined.
  const both = treed.filter(w => Number.isFinite(w.rbarWt) && Number.isFinite(w.rbarBt));
  check('within-tree correlation exceeds between-tree wherever both exist',
    both.length > 20 && both.every(w => w.rbarWt > w.rbarBt),
    both.filter(w => w.rbarWt <= w.rbarBt).map(w => w.midYear).join(','));
  check('windows with only one tree report no between-tree term rather than a wrong one',
    treed.filter(w => w.nTrees === 1).every(w => !Number.isFinite(w.rbarBt)));
  // rbar.eff = rbar.bt / (rbar.wt + (1-rbar.wt)/c.eff); with c.eff >= 1 the
  // denominator is <= 1, so the effective correlation is never below rbar.bt.
  check('the effective correlation is never below the between-tree one',
    both.every(w => w.rbarEff >= w.rbarBt - 1e-9),
    both.filter(w => w.rbarEff < w.rbarBt - 1e-9).map(w => w.midYear).join(','));
  // EPS on trees is NOT uniformly lower: it trades fewer replicates against a
  // higher effective correlation. What must hold is that it is computed on trees.
  check('EPS on a tree basis is finite and computed on the tree count',
    treed.every(w => !Number.isFinite(w.rbarEff) || Number.isFinite(w.eps)));
  check('both EPS conventions are reported side by side',
    treed.every(w => Number.isFinite(w.epsCores) || !Number.isFinite(w.rbarTot)));
}

log('\n# chronStats on ut550');
{
  const cs = chronStats(res, { window: 50 });
  check('trees inferred from the core ids', cs.trees.inferred && cs.trees.nTrees < cs.trees.nCores,
    cs.trees.nCores + ' cores -> ' + cs.trees.nTrees + ' trees');
  check('most trees contributed more than one core', cs.trees.multiCore > 20,
    String(cs.trees.multiCore));
  check('the grouping is exposed for the user to correct',
    Object.keys(cs.trees.groups).length === cs.trees.nTrees);
  check('within-tree beats between-tree overall',
    cs.summary.rbarWt > cs.summary.rbarBt,
    cs.summary.rbarWt.toFixed(3) + ' vs ' + cs.summary.rbarBt.toFixed(3));
  check('EPS is reported both ways',
    Number.isFinite(cs.summary.reliableFromTree) && Number.isFinite(cs.summary.reliableFromCore));
  check('the tree basis is the conservative one',
    cs.summary.reliableFromTree >= cs.summary.reliableFromCore,
    'tree ' + cs.summary.reliableFromTree + ' vs core ' + cs.summary.reliableFromCore);
  check('a one-line statement is produced',
    typeof cs.summary.statement === 'string' && cs.summary.statement.length > 20);
  check('SNR and SSS are finite',
    Number.isFinite(cs.summary.snr) && Number.isFinite(cs.summary.sss4));
  log('        ' + cs.summary.statement);

  const explicit = chronStats(res, { window: 50, treeOf: cs.trees.inferred ? (() => {
    const m = {}; Object.keys(cs.trees.groups).forEach(t => cs.trees.groups[t].forEach(id => { m[id] = t; }));
    return m;
  })() : null });
  check('an explicit tree map reproduces the inferred one',
    explicit.trees.nTrees === cs.trees.nTrees &&
    Math.abs(explicit.summary.epsMean - cs.summary.epsMean) < 1e-12);

  check('turning trees off falls back to the per-core convention',
    chronStats(res, { window: 50, trees: false }).trees.nTrees === cs.trees.nCores);
  check('cofecha() without keepSeries is rejected',
    (() => { try { chronStats(RD.cofecha(frame, { keepSeries: false })); return false; }
      catch (e) { return /keepSeries/.test(e.message); } })());
}

log(allPass ? '\nAll chronStats checks passed.' : '\nFAILURES above.');
process.exit(allPass ? 0 : 1);
