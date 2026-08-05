'use strict';
// Reader tests for src/io/tridas.js against hand-authored TRiDaS 1.2.2 fixtures
// (no dplR oracle exists for TRiDaS — see WORKPLAN / plan). The round-trip test
// against writeTridas is added with the writer.
const { readTridas, writeTridas } = require('../src/io/tridas.js');

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(46), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}
function approx(a, b) { return a != null && b != null && Math.abs(a - b) < 1e-9; }

// --- Fixture A: two undated measurementSeries (micrometres) + taxon/pith -----
const FIX_A =
'<?xml version="1.0" encoding="UTF-8"?>' +
'<tridas xmlns="http://www.tridas.org/1.2.2">' +
' <project>' +
'  <title>Test Project</title><identifier domain="lab.demo">P1</identifier>' +
'  <object>' +
'   <title>Site Alpha</title><identifier domain="lab.demo">OBJ-A</identifier>' +
'   <element>' +
'    <title>Tree 1</title><identifier domain="lab.demo">EL-1</identifier><taxon>Quercus robur</taxon>' +
'    <sample>' +
'     <title>Core 1A</title><identifier domain="lab.demo">SMP-1A</identifier>' +
'     <radius>' +
'      <identifier domain="lab.demo">RAD-1A</identifier>' +
'      <measurementSeries>' +
'       <title>oak-1a</title><identifier domain="lab.demo">MS-1A</identifier>' +
'       <woodCompleteness><pith presence="complete"/><bark presence="absent"/></woodCompleteness>' +
'       <values><variable normalTridas="ring width"/><unit normalTridas="micrometres"/>' +
'        <value value="1200"/><value value="1350"/><value value="1100"/></values>' +
'      </measurementSeries>' +
'     </radius>' +
'    </sample>' +
'   </element>' +
'   <element>' +
'    <title>Tree 2</title><identifier domain="lab.demo">EL-2</identifier><taxon>Fagus sylvatica</taxon>' +
'    <sample><title>Core 2A</title>' +
'     <radius><measurementSeries><title>beech-2a</title><identifier domain="lab.demo">MS-2A</identifier>' +
'      <values><variable normalTridas="ring width"/><unit normalTridas="1/100th millimetres"/>' +
'       <value value="150"/><value value="140"/><value value="160"/><value value="155"/></values>' +
'     </measurementSeries></radius></sample>' +
'   </element>' +
'  </object>' +
' </project>' +
'</tridas>';

const A = readTridas(FIX_A);
check('A: chron slot empty (all undated)', A.chron == null);
check('A: undated frame has 2 series + ring', A.undated && A.undated.names.length === 3, A.undated && A.undated.names.join(','));
check('A: ring axis 1..4', A.undated && A.undated.cols[0].join(',') === '1,2,3,4');
// oak: micrometres -> mm (÷1000); bottom-padded to length 4
const oakCol = A.undated.cols[1];
check('A: oak values micrometres->mm', approx(oakCol[0], 1.2) && approx(oakCol[1], 1.35) && approx(oakCol[2], 1.1));
check('A: oak padded with NA', oakCol[3] == null);
// beech: 1/100 mm -> mm (÷100)
const beechCol = A.undated.cols[2];
check('A: beech values 1/100mm->mm', approx(beechCol[0], 1.5) && approx(beechCol[3], 1.55));
const oakMeta = A.meta[A.undated.names[1]];
check('A: taxon captured', oakMeta.taxon === 'Quercus robur', oakMeta.taxon);
check('A: pith present, bark absent', oakMeta.pith === true && oakMeta.bark === false);
check('A: identifiers captured', oakMeta.tridas.seriesId === 'MS-1A' && oakMeta.tridas.sampleId === 'SMP-1A' && oakMeta.tridas.objectId === 'OBJ-A');
check('A: unit + variable captured', oakMeta.unit === 'micrometres' && /ring width/.test(oakMeta.variable));
check('A: undated meta dated=null', oakMeta.dated == null);

// --- Fixture B: an absolutely-dated derivedSeries spanning BC/AD -------------
// firstYear 2 BC (internal -1) ... 3 values -> 2BC,1BC,1AD (internal -1,0,1).
const FIX_B =
'<tridas xmlns="http://www.tridas.org/1.2.2"><project>' +
' <title>Chrono Project</title><identifier domain="lab.demo">P2</identifier>' +
' <derivedSeries>' +
'  <title>Master BCAD</title><identifier domain="lab.demo">CHRON-1</identifier>' +
'  <linkSeries><series><identifier domain="lab.demo">MS-1A</identifier></series>' +
'   <series><identifier domain="lab.demo">MS-2A</identifier></series></linkSeries>' +
'  <interpretation><dating type="absolute"/><firstYear suffix="BC">2</firstYear><lastYear suffix="AD">1</lastYear></interpretation>' +
'  <values><variable normalTridas="ring width"/><unit normalTridas="1/1000th millimetres"/>' +
'   <value value="1000" count="3"/><value value="1100" count="5"/><value value="1200" count="4"/></values>' +
' </derivedSeries>' +
'</project></tridas>';

const B = readTridas(FIX_B);
check('B: undated slot empty', B.undated == null);
check('B: chron frame has 1 series', B.chron && B.chron.names.length === 2, B.chron && B.chron.names.join(','));
check('B: internal year axis -1,0,1 (2BC..1AD)', B.chron && B.chron.cols[0].join(',') === '-1,0,1', B.chron && B.chron.cols[0].join(','));
check('B: values 1/1000mm->mm', approx(B.chron.cols[1][0], 1.0) && approx(B.chron.cols[1][2], 1.2));
check('B: dating.anyAbsolute + firstYearInternal', B.dating && B.dating.anyAbsolute === true && B.dating.firstYearInternal === -1);
const chMeta = B.meta[B.chron.names[1]];
check('B: chronology dated=absolute', chMeta.dated === 'absolute' && chMeta.firstYearInternal === -1);
check('B: linkSeries members captured', JSON.stringify(B.links[B.chron.names[1]]) === JSON.stringify(['MS-1A', 'MS-2A']));
check('B: sample depth counts on meta', JSON.stringify(chMeta.sampleDepth) === JSON.stringify([3, 5, 4]));

// --- Fixture C: mixed file (undated members + dated chronology) --------------
const FIX_C2 =
'<tridas xmlns="http://www.tridas.org/1.2.2"><project><identifier domain="d">P3</identifier>' +
'<object><identifier domain="d">O</identifier><element><identifier domain="d">E</identifier>' +
'<sample><radius><measurementSeries><title>new-core</title><identifier domain="d">MS-N</identifier>' +
'<values><unit normalTridas="micrometres"/><value value="900"/><value value="950"/></values>' +
'</measurementSeries></radius></sample></element></object>' +
'<derivedSeries><title>ref-chron</title><identifier domain="d">C</identifier>' +
'<interpretation><dating type="absolute"/><firstYear suffix="AD">1990</firstYear></interpretation>' +
'<values><unit normalTridas="micrometres"/><value value="800"/><value value="820"/><value value="810"/></values>' +
'</derivedSeries></project></tridas>';
const C = readTridas(FIX_C2);
check('C: routes undated member to pool', C.undated && C.undated.names.length === 2 && /new_core/.test(C.undated.names[1]), C.undated && C.undated.names.join(','));
check('C: routes dated chronology to chron', C.chron && C.chron.names.length === 2 && /ref_chron/.test(C.chron.names[1]), C.chron && C.chron.names.join(','));
check('C: chron axis is AD years 1990..1992', C.chron && C.chron.cols[0].join(',') === '1990,1991,1992');

// --- guard --------------------------------------------------------------------
let threw = false; try { readTridas('<tridas></tridas>'); } catch (e) { threw = true; }
check('empty tridas throws', threw);

// ============================================================================
// Writer + round-trip (write -> read reproduces the data). Mirrors the RWL/CSV
// round-trip precedent in test/downloads_test.js.
// ============================================================================
const { normalizeSeriesMeta } = require('../src/io/meta.js');

const memberMeta = normalizeSeriesMeta('oak_1a', {
  title: 'oak-1a', labCode: 'MS-1A', taxon: 'Quercus robur', pith: true, bark: false,
  tridas: { objectId: 'OBJ-A', elementId: 'EL-1', sampleId: 'SMP-1A', radiusId: 'RAD-1A', seriesId: 'MS-1A', identifierDomain: 'lab.demo' }
});
const member2Meta = normalizeSeriesMeta('oak_2a', {
  title: 'oak-2a', taxon: 'Quercus robur',
  tridas: { objectId: 'OBJ-A', elementId: 'EL-2', sampleId: 'SMP-2A', radiusId: 'RAD-2A', seriesId: 'MS-2A', identifierDomain: 'lab.demo' }
});
const chronMeta = normalizeSeriesMeta('master', { title: 'master', tridas: { seriesId: 'CHRON-1', identifierDomain: 'lab.demo' } });

const spec = {
  mode: 'selfContained',
  chronology: { name: 'master', valuesMm: [1.0, 1.1, 1.2], firstYearInternal: -1, sampleDepth: [2, 2, 1], meta: chronMeta },
  members: [
    { name: 'oak_1a', valuesMm: [1.2, 1.35, 1.1], firstYearInternal: -1, meta: memberMeta },
    { name: 'oak_2a', valuesMm: [1.3, 1.4], firstYearInternal: 0, meta: member2Meta }
  ],
  unit: '1/1000th millimetres',
  project: { title: 'RT Project', identifier: 'RT', domain: 'lab.demo' }
};

const xml = writeTridas(spec);
check('W: emits a tridas root + derivedSeries', /<tridas/.test(xml) && /<derivedSeries>/.test(xml));
check('W: selfContained emits measurementSeries', (xml.match(/<measurementSeries>/g) || []).length === 2);
check('W: derivedSeries linkSeries references member ids', /<identifier domain="lab.demo">MS-1A<\/identifier>/.test(xml) && /MS-2A/.test(xml));
check('W: BC firstYear rendered with suffix', /<firstYear suffix="BC">2<\/firstYear>/.test(xml), xml.match(/<firstYear[^>]*>[^<]*<\/firstYear>/g));
check('W: sample depth count on chronology values', /count="2"/.test(xml));

// read it back
const RT = readTridas(xml);
check('RT: chronology recovered on internal axis -1..1', RT.chron && RT.chron.cols[0].join(',') === '-1,0,1', RT.chron && RT.chron.cols[0].join(','));
const rtChronCol = RT.chron.cols[RT.chron.names.length - 1];
check('RT: chronology values reproduced', approx(rtChronCol[0], 1.0) && approx(rtChronCol[1], 1.1) && approx(rtChronCol[2], 1.2));
check('RT: two members recovered as dated series', RT.chron.names.length >= 3);   // 2 members + chronology all absolutely dated
check('RT: linkSeries provenance preserved', (function () {
  const links = RT.links[RT.chron.names.find(n => /master/.test(n)) || RT.chron.names[RT.chron.names.length - 1]];
  return links && links.indexOf('MS-1A') >= 0 && links.indexOf('MS-2A') >= 0;
})());
// meta round-trip: taxon + pith survive
const rtMember = Object.keys(RT.meta).map(k => RT.meta[k]).find(m => m.tridas && m.tridas.seriesId === 'MS-1A');
check('RT: member taxon preserved', rtMember && rtMember.taxon === 'Quercus robur');
check('RT: member pith/bark preserved', rtMember && rtMember.pith === true && rtMember.bark === false);

// derivedOnly mode omits measurementSeries but keeps linkSeries
const xmlDerived = writeTridas(Object.assign({}, spec, { mode: 'derivedOnly' }));
check('W: derivedOnly omits measurementSeries', !/<measurementSeries>/.test(xmlDerived));
check('W: derivedOnly keeps linkSeries ids', /MS-1A/.test(xmlDerived) && /MS-2A/.test(xmlDerived));

console.log(ok ? '\nTRIDAS READ/WRITE PASS' : '\nTRIDAS READ/WRITE FAIL');
process.exit(ok ? 0 : 1);
