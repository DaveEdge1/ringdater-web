'use strict';
// Validate the analysis-layer ports against R ground truth (analysis_gt.json):
//   filter_crossdates, correl_replace, remove_series, RingdateR_error_message.
// Per-case diffs; nonzero exit on any failure.
const fs = require('fs');
const path = require('path');
const { filterCrossdates } = require('../src/analysis/filterCrossdates.js');
const { correlReplace } = require('../src/analysis/correlReplace.js');
const { removeSeries } = require('../src/analysis/removeSeries.js');
const { RingdateR_error_message } = require('../src/analysis/errorMessage.js');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'analysis_gt.json'), 'utf8'));

const num = v => (v === null || (typeof v === 'number' && Number.isNaN(v))) ? null : v;
// Build a Frame from an ordered names[] and a {name:[values]} object.
function frameFrom(names, obj) {
  return { names: names.slice(), cols: names.map(n => obj[n]) };
}
// Compare a scalar (string or number); numbers within relative/abs tol.
function scalarEq(a, b, tol) {
  a = num(a); b = num(b);
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const d = Math.abs(a - b);
  return d <= tol || d <= tol * Math.max(Math.abs(a), Math.abs(b));
}

let allPass = true;
const log = (...a) => console.log(...a);

// ---- helper: compare two frames column-by-column ----
function compareFrame(label, R, Jframe, tol) {
  let pass = true, maxDiff = 0;
  const Jobj = {};
  Jframe.names.forEach((n, i) => { Jobj[n] = Jframe.cols[i]; });
  for (const name of R.names) {
    const rc = R.data[name], jc = Jobj[name];
    if (!jc) { log(`  [${label}] missing column ${name}`); pass = false; continue; }
    if (rc.length !== jc.length) { log(`  [${label}] ${name} length R=${rc.length} JS=${jc.length}`); pass = false; continue; }
    for (let i = 0; i < rc.length; i++) {
      if (!scalarEq(rc[i], jc[i], tol)) {
        log(`  [${label}] ${name}[${i}] R=${rc[i]} JS=${jc[i]}`); pass = false;
      }
      const a = num(rc[i]), b = num(jc[i]);
      if (typeof a === 'number' && typeof b === 'number') maxDiff = Math.max(maxDiff, Math.abs(a - b));
    }
  }
  log(`  [${label}] rows=${Jframe.cols[0].length} maxNumDiff=${maxDiff.toExponential(3)} -> ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

// =====================================================================
log('--- filter_crossdates ---');
{
  const fc = gt.filter_crossdates;
  const inFrame = frameFrom(fc.names, fc.input);
  const res = filterCrossdates(inFrame, fc.params);
  const ok = compareFrame('filter_crossdates', { names: fc.names, data: fc.filtered }, res, 1e-9);
  allPass = allPass && ok;
}

// =====================================================================
log('--- correl_replace ---');
{
  const cr = gt.correl_replace;
  const inNames = Object.keys(cr.input);
  const inFrame = frameFrom(inNames, cr.input);
  const res = correlReplace(inFrame);
  const ok = compareFrame('correl_replace', { names: cr.names, data: cr.result }, res, 1e-8);
  allPass = allPass && ok;
}

// =====================================================================
log('--- remove_series ---');
{
  const rs = gt.remove_series;
  const inNames = Object.keys(rs.input);
  const inFrame = frameFrom(inNames, rs.input);
  const res = removeSeries(inFrame, rs.ids);
  let ok = JSON.stringify(res.names) === JSON.stringify(rs.result_names);
  if (!ok) log(`  names R=${JSON.stringify(rs.result_names)} JS=${JSON.stringify(res.names)}`);
  ok = compareFrame('remove_series', { names: rs.result_names, data: rs.result }, res, 0) && ok;
  allPass = allPass && ok;
}

// =====================================================================
log('--- RingdateR_error_message ---');
{
  const em = gt.error_message;
  let ok = true;
  if (RingdateR_error_message(undefined, false) !== em.default) {
    log(`  default R=${em.default} JS=${RingdateR_error_message(undefined, false)}`); ok = false;
  }
  for (let i = 0; i < em.messages.length; i++) {
    const js = RingdateR_error_message(em.messages[i], false);
    if (js !== em.returned[i]) { log(`  msg[${i}] R=${em.returned[i]} JS=${js}`); ok = false; }
    // plot.err TRUE branch: descriptor carries the same message text
    const desc = RingdateR_error_message(em.messages[i], true);
    if (!desc || desc.message !== em.returned[i]) { log(`  desc[${i}] mismatch`); ok = false; }
  }
  log(`  [error_message] cases=${em.messages.length + 1} -> ${ok ? 'PASS' : 'FAIL'}`);
  allPass = allPass && ok;
}

log(allPass ? '\nPASS: all analysis-layer ports match R.' : '\nFAIL');
process.exit(allPass ? 0 : 1);
