'use strict';
// Reader test for src/io/crn.js (ITRDB/Tucson chronology). No dplR oracle is
// available here, so we assert against a spec-built fixture (value 4 chars +
// sample depth 3 chars, 10 blocks/line, cols 11-80) — the downloads_test.js
// precedent. Also checks the loadChron dispatch accepts .crn end-to-end.
const { readCrn } = require('../src/io/crn.js');
const load = require('../src/io/load.js');

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(46), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}
function approx(a, b) { return a != null && b != null && Math.abs(a - b) < 1e-9; }

// ---- spec-compliant .crn builder --------------------------------------------
function val4(rwi) { const s = String(Math.round(rwi * 1000)); return s.length >= 4 ? s : ' '.repeat(4 - s.length) + s; }
function dep3(d) { const s = String(d); return ' '.repeat(3 - s.length) + s; }
function id6(id) { return (id + '      ').slice(0, 6); }
function yr4(y) { return ('    ' + y).slice(-4); }
function dataLine(id, year, pairs) {
  let s = id6(id) + yr4(year);
  for (let i = 0; i < pairs.length; i++) s += val4(pairs[i][0]) + dep3(pairs[i][1]);
  return s;
}

// chronology 1980..1994, index 0.900..1.040 step 0.010, sample depth 5
const rwi = []; for (let i = 0; i < 15; i++) rwi.push(0.900 + i * 0.010);
const line1 = dataLine('CA051', 1980, rwi.slice(0, 10).map(v => [v, 5]));                 // 1980-1989
const tail = rwi.slice(10, 15).map(v => [v, 5]).concat([[9.99, 0], [9.99, 0], [9.99, 0], [9.99, 0], [9.99, 0]]);
const line2 = dataLine('CA051', 1990, tail);                                              // 1990-1994 + 9990 padding

const HEADER = [
  'CA051 1 California Oak Site                          QUER',       // cols 7-10 non-numeric -> header
  'CA051 2 CALIF USA                                    1980 1994',
  'CA051 3 Smith D.E.                                   2026'
];
const CRN = HEADER.concat([line1, line2]).join('\n') + '\n';

// ---- reader ------------------------------------------------------------------
const f = readCrn(CRN);
check('names = [year, CA051]', f.names.join(',') === 'year,CA051', f.names.join(','));
check('year axis 1980..1994 (9990 padding stripped)', f.cols[0][0] === 1980 && f.cols[0][f.cols[0].length - 1] === 1994, f.cols[0].join(','));
check('length 15', f.cols[1].length === 15);
check('index scaled /1000 at start (0.900)', approx(f.cols[1][0], 0.900), f.cols[1][0]);
check('index at 1990 (0.999... = 1.000)', approx(f.cols[1][10], 1.000), f.cols[1][10]);
check('index at 1994 (1.040)', approx(f.cols[1][14], 1.040), f.cols[1][14]);
check('no spurious 9.99 tail', f.cols[1].every(v => v == null || v < 9), f.cols[1].join(','));

// ---- no-header variant + comment line ---------------------------------------
const noHdr = readCrn('# a comment\n' + line1 + '\n' + line2 + '\n');
check('no-header file parses', noHdr.names.join(',') === 'year,CA051' && noHdr.cols[1].length === 15);

// ---- loadChron dispatch accepts .crn ----------------------------------------
const viaLoad = load.loadChron({ name: 'CA051.crn', text: CRN });
check('loadChron accepts .crn', viaLoad.names.indexOf('CA051') >= 0 && viaLoad.cols[0].length === 15, viaLoad.names.join(','));
let rejected = false;
try { load.loadChron({ name: 'x.foo', text: 'nope' }); } catch (e) { rejected = /not supported/.test(e.message); }
check('loadChron still rejects unknown ext', rejected);

// ---- guard -------------------------------------------------------------------
let threw = false; try { readCrn('just some header text\nno data here\n'); } catch (e) { threw = /no chronology data/.test(e.message); }
check('no-data file throws', threw);

console.log(ok ? '\nCRN PASS' : '\nCRN FAIL');
process.exit(ok ? 0 : 1);
