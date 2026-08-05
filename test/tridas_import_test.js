'use strict';
// appCore-level TRiDaS import + auto-routing test (drives the browser bundle in
// Node, the same way frontend_test.js does). Covers loadTridas routing and the
// multi-file bind helpers that the DOM app.js relies on.
const AC = require('../web/appCore.js');

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(46), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}

const UNDATED_FILE =
'<tridas xmlns="http://www.tridas.org/1.2.2"><project><identifier domain="d">P</identifier>' +
'<object><identifier domain="d">O</identifier><element><identifier domain="d">E</identifier><taxon>Pinus</taxon>' +
'<sample><radius><measurementSeries><title>core-a</title><identifier domain="d">MS-A</identifier>' +
'<values><unit normalTridas="micrometres"/><value value="1000"/><value value="1100"/></values>' +
'</measurementSeries></radius></sample></element></object></project></tridas>';

const CHRON_FILE =
'<tridas xmlns="http://www.tridas.org/1.2.2"><project><identifier domain="d">P2</identifier>' +
'<derivedSeries><title>master</title><identifier domain="d">C</identifier>' +
'<interpretation><dating type="absolute"/><firstYear suffix="AD">1500</firstYear></interpretation>' +
'<values><unit normalTridas="micrometres"/><value value="800" count="4"/><value value="820" count="5"/></values>' +
'</derivedSeries></project></tridas>';

// mixed single file: one undated member + one dated chronology
const MIXED_FILE = UNDATED_FILE.replace('</project></tridas>',
  '<derivedSeries><title>ref</title><identifier domain="d">C2</identifier>' +
  '<interpretation><dating type="absolute"/><firstYear suffix="AD">2000</firstYear></interpretation>' +
  '<values><unit normalTridas="micrometres"/><value value="700"/><value value="710"/></values>' +
  '</derivedSeries></project></tridas>');

// --- isTridas -----------------------------------------------------------------
check('isTridas(.xml)', AC.isTridas('foo.xml') === true);
check('isTridas(.rwl) false', AC.isTridas('foo.rwl') === false);

// --- single mixed file auto-routes -------------------------------------------
const mixed = AC.loadTridas([{ name: 'mixed.xml', text: MIXED_FILE }]);
check('mixed: undated pool populated', mixed.undated && AC.seriesNames(mixed.undated).length === 1, mixed.undated && AC.seriesNames(mixed.undated).join(','));
check('mixed: chron populated', mixed.chron && AC.seriesNames(mixed.chron).length === 1);
check('mixed: chron on AD axis 2000..2001', mixed.chron && mixed.chron.cols[0].join(',') === '2000,2001');
check('mixed: meta covers both series',
  Object.keys(mixed.meta).length === 2);
check('mixed: undated member has taxon', (function () {
  const nm = AC.seriesNames(mixed.undated)[0];
  return mixed.meta[nm] && mixed.meta[nm].taxon === 'Pinus';
})());

// --- multi-file bind: two undated files column-bind on ring axis -------------
const twoUndated = AC.loadTridas([
  { name: 'a.xml', text: UNDATED_FILE },
  { name: 'b.xml', text: UNDATED_FILE.replace(/core-a/g, 'core-b').replace(/MS-A/g, 'MS-B') }
]);
check('two undated files -> 2 pool series', twoUndated.undated && AC.seriesNames(twoUndated.undated).length === 2, twoUndated.undated && AC.seriesNames(twoUndated.undated).join(','));
check('two undated files -> chron null', twoUndated.chron == null);

// --- multi-file bind: undated file + chron file ------------------------------
const split = AC.loadTridas([
  { name: 'u.xml', text: UNDATED_FILE },
  { name: 'c.xml', text: CHRON_FILE }
]);
check('split: pool from undated file', split.undated && AC.seriesNames(split.undated).length === 1);
check('split: chron from chron file', split.chron && AC.seriesNames(split.chron).length === 1);
check('split: chron AD 1500..1501', split.chron && split.chron.cols[0].join(',') === '1500,1501');
check('split: derived linkless still routed', split.chron != null);

// --- bindUndated helper directly ---------------------------------------------
const a = AC.loadTridas([{ name: 'a.xml', text: UNDATED_FILE }]).undated;
const b = AC.loadTridas([{ name: 'b.xml', text: UNDATED_FILE.replace(/core-a/g, 'zzz').replace(/MS-A/g, 'MS-Z') }]).undated;
const bound = AC.bindUndated(a, b);
check('bindUndated: ring axis reset + 2 series', bound.cols[0].join(',') === '1,2' && bound.names.length === 3, bound.names.join(','));

console.log(ok ? '\nTRIDAS IMPORT PASS' : '\nTRIDAS IMPORT FAIL');
process.exit(ok ? 0 : 1);
