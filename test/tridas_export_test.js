'use strict';
// End-to-end (through the browser bundle): import TRiDaS undated members + a
// dated chronology, build/date a chronology with the interactive builder, then
// export TRiDaS and re-import it — the Tellervo round-trip the feature exists for.
const AC = require('../web/appCore.js');
const RD = AC.RD;

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(52), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}

// Three undated cores with clear common signal, offset so crossdating is decisive.
function series(seed) {
  var v = [];
  for (var i = 0; i < 60; i++) {
    v.push(1 + 0.5 * Math.sin(i / 3) + 0.2 * Math.sin(i / 7 + seed) + ((i * 7 + seed * 13) % 5) * 0.03);
  }
  return v;
}
function tridasMS(id, title, taxon, vals) {
  var values = vals.map(function (x) { return '<value value="' + Math.round(x * 1000) + '"/>'; }).join('');
  return '<object><identifier domain="d">OBJ-' + id + '</identifier><element><identifier domain="d">EL-' + id + '</identifier>' +
    '<taxon>' + taxon + '</taxon><sample><identifier domain="d">SMP-' + id + '</identifier>' +
    '<radius><identifier domain="d">RAD-' + id + '</identifier>' +
    '<measurementSeries><title>' + title + '</title><identifier domain="d">MS-' + id + '</identifier>' +
    '<woodCompleteness><pith presence="complete"/><bark presence="absent"/></woodCompleteness>' +
    '<values><unit normalTridas="1/1000th millimetres"/>' + values + '</values>' +
    '</measurementSeries></radius></sample></element></object>';
}
var a = series(0), b = series(1), c = series(2);
var TR =
  '<tridas xmlns="http://www.tridas.org/1.2.2"><project><identifier domain="d">P</identifier>' +
  tridasMS('A', 'core-a', 'Quercus robur', a) +
  tridasMS('B', 'core-b', 'Quercus robur', b) +
  tridasMS('C', 'core-c', 'Fagus sylvatica', c) +
  '</project></tridas>';

// --- import ------------------------------------------------------------------
var imp = AC.loadTridas([{ name: 'in.xml', text: TR }]);
check('import: 3 undated members', imp.undated && AC.seriesNames(imp.undated).length === 3, imp.undated && AC.seriesNames(imp.undated).join(','));
var names = AC.seriesNames(imp.undated);

// --- build a chronology with the real builder --------------------------------
var builder = RD.createBuilder({ undated: imp.undated, detrend: { detrending_select: 3, splinewindow: 21 } });
builder.setAnchor(names[0]);
[names[1], names[2]].forEach(function (id) {
  var cx = builder.crossdate(id);
  var lag = (cx.suggestions && cx.suggestions.length) ? cx.suggestions[0].lag : 0;
  builder.approve(id, lag);
});
check('build: 3 members in chronology', builder.state().members.length === 3, builder.state().members.length + '');
// date it: pin the anchor's first ring to AD 1400
builder.setDatum({ seriesId: names[0], edge: 'first', year: 1400 });
check('build: chronology is dated', builder.isDated());

// --- export TRiDaS (self-contained) ------------------------------------------
var dl = AC.builderTridasDownloads({
  builder: builder, undated: imp.undated, meta: imp.meta,
  chronName: 'oak-master', projectTitle: 'Export Test', date: '2026-08-05'
});
var xml = dl.chronologyTridasSelfContained.content;
check('export: filename + xml mime', /\.tridas\.xml$/.test(dl.chronologyTridasSelfContained.filename) && dl.chronologyTridasSelfContained.mime === 'application/xml');
check('export: derivedSeries present', /<derivedSeries>/.test(xml));
check('export: 3 measurementSeries emitted', (xml.match(/<measurementSeries>/g) || []).length === 3);
check('export: linkSeries has 3 members', (xml.match(/<series>/g) || []).length === 3);
check('export: dated firstYear AD present', /<firstYear suffix="AD">/.test(xml));
check('export: taxon carried through', /Quercus robur/.test(xml) && /Fagus sylvatica/.test(xml));
check('export: sample depth counts present', /count="3"/.test(xml));

// --- re-import the exported file ---------------------------------------------
var back = AC.loadTridas([{ name: 'out.xml', text: xml }]);
check('re-import: chronology recovered', back.chron && AC.seriesNames(back.chron).length >= 1);
check('re-import: chronology dated (AD, absolute)', back.dating && back.dating.anyAbsolute === true);
// the anchor was pinned to AD 1400 -> internal 1400; axis should start at 1400
check('re-import: chronology axis starts at AD 1400', back.chron && back.chron.cols[0][0] === 1400, back.chron && back.chron.cols[0][0]);
check('re-import: provenance links recovered', (function () {
  var anyLinks = Object.keys(back.links).some(function (k) { return back.links[k].length === 3; });
  return anyLinks;
})());

// --- derivedOnly variant ------------------------------------------------------
var xmlD = dl.chronologyTridasDerivedOnly.content;
check('derivedOnly: no measurementSeries', !/<measurementSeries>/.test(xmlD));
check('derivedOnly: keeps 3 linkSeries members', (xmlD.match(/<series>/g) || []).length === 3);

console.log(ok ? '\nTRIDAS EXPORT PASS' : '\nTRIDAS EXPORT FAIL');
process.exit(ok ? 0 : 1);
