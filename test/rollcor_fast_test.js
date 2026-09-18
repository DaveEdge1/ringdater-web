'use strict';
// rollcorFast must agree with rollcor — the R-validated reference — on every
// window, including the NA handling running_lead_lag relies on. Nonzero exit on
// any disagreement.
const { rollcor } = require('../src/analysis/rollcor.js');
const { rollcorFast } = require('../src/analysis/rollcorFast.js');

let allPass = true;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (!ok) { allPass = false; log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else log('  ok    ' + name);
}

// deterministic pseudo-random so a failure is reproducible
let seed = 20260918;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function compare(label, x, y, width, tol) {
  const a = rollcor(x, y, width);
  const b = rollcorFast(x, y, width);
  if (a.length !== b.length) {
    check(label + ' (length)', false, a.length + ' vs ' + b.length);
    return;
  }
  let worst = 0, mismatchNaN = 0;
  for (let i = 0; i < a.length; i++) {
    const na = Number.isNaN(a[i]), nb = Number.isNaN(b[i]);
    if (na !== nb) { mismatchNaN++; continue; }
    if (na) continue;
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  check(label, mismatchNaN === 0 && worst <= tol,
    'NaN mismatches ' + mismatchNaN + ', worst |d| ' + worst.toExponential(2));
}

log('# rollcorFast vs rollcor');

// 1. plain correlated series, several window widths
{
  const n = 800, x = [], y = [];
  for (let i = 0; i < n; i++) { const t = rnd(); x.push(t); y.push(0.7 * t + 0.3 * rnd()); }
  for (const w of [5, 11, 21, 51, 101]) compare('correlated, width ' + w, x, y, w, 1e-9);
}

// 2. detrended-index-like values (mean ~1) — the actual use case
{
  const n = 2500, x = [], y = [];
  for (let i = 0; i < n; i++) { const t = 1 + 0.35 * (rnd() - 0.5); x.push(t); y.push(t * (1 + 0.2 * (rnd() - 0.5))); }
  compare('index-like, n 2500, width 51', x, y, 51, 1e-9);
}

// 3. NA handling: a window containing ANY missing value must be NaN in both
{
  const n = 400, x = [], y = [];
  for (let i = 0; i < n; i++) { x.push(rnd()); y.push(rnd()); }
  x[50] = null; y[120] = null; x[121] = NaN;
  for (let i = 200; i < 215; i++) y[i] = null;          // a run of gaps
  compare('interior NAs, width 21', x, y, 21, 1e-9);
  const b = rollcorFast(x, y, 21);
  // every window overlapping index 50 must be NaN
  let ok = true;
  for (let w = Math.max(0, 50 - 20); w <= 50 && w < b.length; w++) if (!Number.isNaN(b[w])) ok = false;
  check('windows overlapping an NA are NaN', ok);
}

// 4. NA-padded shifted overlap, the shape running_lead_lag actually passes
{
  const n = 300, core = [];
  for (let i = 0; i < n; i++) core.push(rnd());
  const pad = k => Array(k).fill(null);
  const x = pad(7).concat(core);
  const y = core.concat(pad(7));
  compare('NA-padded shift, width 31', x, y, 31, 1e-9);
}

// 5. degenerate windows: a constant stretch has zero variance -> NaN in both
{
  const x = [], y = [];
  for (let i = 0; i < 120; i++) { x.push(i < 60 ? 1 : rnd()); y.push(rnd()); }
  compare('constant stretch, width 11', x, y, 11, 1e-9);
}

// 6. contract errors match
check('even width rejected',
  (() => { try { rollcorFast([1, 2, 3], [1, 2, 3], 2); return false; } catch (e) { return true; } })());
check('length mismatch rejected',
  (() => { try { rollcorFast([1, 2, 3], [1, 2], 3); return false; } catch (e) { return true; } })());
check('window longer than the series returns nothing',
  rollcorFast([1, 2, 3], [1, 2, 3], 5).length === 0);

// 7. it is actually faster (the only reason this module exists)
{
  const n = 2500, x = [], y = [];
  for (let i = 0; i < n; i++) { const t = rnd(); x.push(t); y.push(0.6 * t + 0.4 * rnd()); }
  const t0 = Date.now(); for (let k = 0; k < 20; k++) rollcor(x, y, 51); const slow = Date.now() - t0;
  const t1 = Date.now(); for (let k = 0; k < 20; k++) rollcorFast(x, y, 51); const fast = Date.now() - t1;
  check('faster than rollcor', fast <= slow, 'rollcor ' + slow + 'ms, rollcorFast ' + fast + 'ms');
  log('        (20 passes over 2500 points, width 51: rollcor ' + slow + 'ms, rollcorFast ' + fast + 'ms)');
}

log(allPass ? '\nAll rollcorFast checks passed.' : '\nFAILURES above.');
process.exit(allPass ? 0 : 1);
