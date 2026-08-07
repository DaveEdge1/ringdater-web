'use strict';
// Series-naming behavior for RWL loading:
//  (a) a series with no ID in cols 1-8 is named after the file (basename, no ext);
//  (b) loaders guarantee unique series names, reporting renames via a
//      non-enumerable `warnings` array on the returned frame;
//  (c) nameCheckUnique closes nameCheck's duplicate edge cases and reports
//      exactly the names it had to invent.
// Exits nonzero on any mismatch.
const fs = require('fs');
const path = require('path');
const { readRWL } = require('../src/io/rwl.js');
const { loadUndated } = require('../src/io/load.js');
const { nameCheckUnique } = require('../src/analysis/checks.js');

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('ok   [' + label + ']');
  else { fails++; console.error('FAIL [' + label + '] ' + (detail || '')); }
}

// A minimal blank-ID Tucson file: no sample ID in cols 1-8, one series.
function blankIdRwl() {
  return '        1001   535   407   759   747   522   688   376   310   567\n' +
         '        1010   514   485   387   312 -9999\n';
}

// (a) blank ID + fileName -> file basename (extension stripped)
{
  const f = readRWL(blankIdRwl(), { fileName: 'CMP511.rwl' });
  check('noid/fileName', f.names.length === 2 && f.names[1] === 'CMP511',
    'names=' + JSON.stringify(f.names));
  check('noid/data', f.cols[0][0] === 1001 && Math.abs(f.cols[1][0] - 0.535) < 1e-12,
    'first row mismatch');
}
// path prefixes are stripped from the fallback name
{
  const f = readRWL(blankIdRwl(), { fileName: 'some/dir/CMP519A.rwl' });
  check('noid/basename', f.names[1] === 'CMP519A', 'names=' + JSON.stringify(f.names));
}
// without a fileName the blank ID is preserved (dplR parity path unchanged)
{
  const f = readRWL(blankIdRwl());
  check('noid/noFileName', f.names[1] === '', 'names=' + JSON.stringify(f.names));
}
// a file with real IDs is untouched by the fallback
{
  const txt = 'AAA01A  1001   535   407 -9999\n';
  const f = readRWL(txt, { fileName: 'CMP511.rwl' });
  check('id/kept', f.names[1] === 'AAA01A', 'names=' + JSON.stringify(f.names));
}

// (b) loadUndated: two blank-ID files -> named after their files, unique, no warnings
{
  const files = [
    { name: 'CMP511.rwl', text: blankIdRwl() },
    { name: 'CMP519A.rwl', text: blankIdRwl() },
  ];
  const f = loadUndated(files);
  check('load/two-files', JSON.stringify(f.names) === JSON.stringify(['ring', 'cmp511', 'cmp519a']),
    'names=' + JSON.stringify(f.names));
  check('load/no-warnings', f.warnings === undefined,
    'warnings=' + JSON.stringify(f.warnings));
}
// the same file loaded twice -> forced rename + a user-facing warning
{
  const files = [
    { name: 'CMP511.rwl', text: blankIdRwl() },
    { name: 'CMP511.rwl', text: blankIdRwl() },
  ];
  const f = loadUndated(files);
  const uniq = new Set(f.names);
  check('dup/unique', uniq.size === f.names.length, 'names=' + JSON.stringify(f.names));
  check('dup/renamed', f.names[2] === 'cmp511_1', 'names=' + JSON.stringify(f.names));
  check('dup/warned', Array.isArray(f.warnings) && f.warnings.length === 1 &&
    f.warnings[0].indexOf('cmp511_1') >= 0, 'warnings=' + JSON.stringify(f.warnings));
  check('dup/warnings-hidden', Object.keys(f).indexOf('warnings') < 0,
    'warnings must be non-enumerable');
}

// (c) nameCheckUnique: the "a.b" vs "a_b" gsub collision nameCheck leaves behind
{
  const res = nameCheckUnique({ names: ['year', 'a_b', 'a.b'], cols: [[1], [2], [3]] });
  check('ncu/gsub-collision', JSON.stringify(res.frame.names) === JSON.stringify(['year', 'a_b', 'a_b_1']),
    'names=' + JSON.stringify(res.frame.names));
  check('ncu/report', res.renames.length === 1 && res.renames[0].from === 'a.b' &&
    res.renames[0].to === 'a_b_1', 'renames=' + JSON.stringify(res.renames));
}
// unique inputs -> nothing reported
{
  const res = nameCheckUnique({ names: ['year', 'ser1', 'ser2'], cols: [[1], [2], [3]] });
  check('ncu/clean', res.renames.length === 0, 'renames=' + JSON.stringify(res.renames));
}

// integration: the real ut585 example files, if present in the repo
const UT = path.join(__dirname, '..', 'ut585');
if (fs.existsSync(UT)) {
  const names = ['CMP511.rwl', 'CMP519A.rwl', 'CMP523.rwl'];
  const files = names.map(n => ({ name: n, text: fs.readFileSync(path.join(UT, n), 'utf8') }));
  const f = loadUndated(files);
  check('ut585/names', JSON.stringify(f.names) === JSON.stringify(['ring', 'cmp511', 'cmp519a', 'cmp523']),
    'names=' + JSON.stringify(f.names));
  check('ut585/no-warnings', f.warnings === undefined, 'warnings=' + JSON.stringify(f.warnings));
} else {
  console.log('skip [ut585/*] fixture folder not present');
}

console.log(fails ? '\n' + fails + ' failure(s)' : '\nall passed');
if (fails) process.exit(1);
