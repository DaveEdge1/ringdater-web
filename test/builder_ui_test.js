'use strict';
// ============================================================================
// builder_ui_test.js — functional (no-DOM) validation of the Build-chronology
// tab logic. jsdom isn't available, so we drive the SAME factored appCore
// helpers (web/appCore.js) that app.js wires to the DOM, proving the browser
// Build tab can run end-to-end:
//
//   load example CSV  -> newBuilder -> setAnchor(first) -> crossdate(second)
//   -> builderReview   : best-3 suggestions + three review plot specs
//   -> renderSvg each  : well-formed non-empty <svg>
//   -> approve(bestLag): members grow, pool shrinks
//   -> exportChronology: Frame with >= 3 columns
//   -> builderDownloads: {filename, mime, content} CSV + RWL descriptors
//
// Loads the SAME bundle the browser loads, so a broken bundle / missing export
// fails here. Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const AC = require('../web/appCore.js');   // -> requires web/ringdater.bundle.js
const RD = AC.RD;

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}
function isSvg(s) {
  return typeof s === 'string' && /^<svg[\s\S]*<\/svg>$/.test(s.trim()) && s.length > 100;
}

console.log('RingdateR Build-chronology tab — functional (no-DOM) test\n');

// 0. load the example undated CSV via the app loader --------------------------
const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'extdata', 'undated_example.csv'), 'utf8');
const undated = AC.loadUndated([{ name: 'undated_example.csv', text: csv }]);
const names = AC.seriesNames(undated);
ok('loaded undated example', names.length >= 2, names.length + ' series');

// 1. create a builder from the raw data + a detrend UI object -----------------
const builder = AC.newBuilder({ undated: undated, detrend: { detrending_select: 3, splinewindow: 21 } });
ok('newBuilder created', builder && typeof builder.crossdate === 'function');
const st0 = builder.state();
ok('starts with no chronology + full pool', !st0.hasChronology && st0.poolIds.length === names.length,
  'pool=' + st0.poolIds.length);

// 2. anchor the first series --------------------------------------------------
builder.setAnchor(names[0]);
const st1 = builder.state();
ok('setAnchor seeds one member', st1.hasChronology && st1.members.length === 1 && st1.members[0].id === names[0]);
ok('pool shrank by one after anchor', st1.poolIds.length === names.length - 1);

// 3. review the second candidate: suggestions + three plot specs --------------
const candId = st1.poolIds[0];
const review = AC.builderReview(builder, candId);
ok('suggestions non-empty', review.suggestions.length >= 1, review.suggestions.length + ' suggestions');
const best = review.suggestions[0];
ok('best lag is a finite number', typeof best.lag === 'number' && Number.isFinite(best.lag), 'lag=' + best.lag);
ok('builderReview defaults to best lag', review.lag === review.bestLag && review.bestLag === best.lag);

// three review plot specs render to well-formed non-empty <svg>
ok('line plot spec renders SVG', isSvg(RD.renderSvg(review.line)),
  review.line ? 'ok' : 'null spec');
ok('heatmap spec renders SVG', isSvg(RD.renderSvg(review.heatmap)),
  review.heatmap ? 'ok' : 'null spec');
ok('lead-lag bar spec renders SVG', isSvg(RD.renderSvg(review.leadLagBar)),
  review.leadLagBar ? 'ok' : 'null spec');

// builderPlots re-renders at an alternate lag without re-crossdating -----------
const alt = AC.builderPlots(review.cn, review.masterLeadLag, candId, review.bestLag + 1);
ok('builderPlots(cached cn) rebuilds line SVG at alt lag', isSvg(RD.renderSvg(alt.line)));

// suggestion P formats via the app convention --------------------------------
ok('fmtP formats a p-value', typeof AC.fmtP(best.P) === 'string' && AC.fmtP(best.P).length > 0,
  'P=' + AC.fmtP(best.P));

// 4. approve at the best lag: members grow, pool shrinks -----------------------
const beforeMembers = builder.state().members.length;
const beforePool = builder.state().poolIds.length;
builder.approve(candId, best.lag);
const st2 = builder.state();
ok('approve grew members', st2.members.length === beforeMembers + 1, beforeMembers + ' -> ' + st2.members.length);
ok('approve shrank pool', st2.poolIds.length === beforePool - 1, beforePool + ' -> ' + st2.poolIds.length);
ok('approved member recorded at chosen lag',
  st2.members.some(function (m) { return m.id === candId && m.lag === best.lag; }));

// 5. exportChronology is a Frame with >= 3 columns (year + 2 members) ---------
const chr = builder.exportChronology();
ok('exportChronology is a Frame with >= 3 columns',
  chr && chr.names && chr.cols && chr.names.length >= 3, chr ? chr.names.length + ' cols' : 'null');

// mean chronology helper works too
const mean = builder.meanChronology();
ok('meanChronology returns [year, mean_chronology]', mean && mean.names.indexOf('mean_chronology') >= 0);

// 6. builderDownloads -> CSV + RWL descriptors --------------------------------
const dls = AC.builderDownloads(chr, '2026-08-04');
ok('CSV download descriptor well-formed',
  dls.chronologyCsv && dls.chronologyCsv.mime === 'text/csv' &&
  /\.csv$/.test(dls.chronologyCsv.filename) && dls.chronologyCsv.content.length > 0,
  dls.chronologyCsv && dls.chronologyCsv.filename);
ok('RWL download descriptor well-formed',
  dls.chronologyRwl && /\.rwl$/.test(dls.chronologyRwl.filename) &&
  typeof dls.chronologyRwl.content === 'string' && dls.chronologyRwl.content.length > 0,
  dls.chronologyRwl && dls.chronologyRwl.filename);

// 7. builderChronPlot renders --------------------------------------------------
ok('builderChronPlot renders SVG', isSvg(RD.renderSvg(AC.builderChronPlot(chr))));

// 8. remove returns a member to the pool --------------------------------------
const preRemove = builder.state();
builder.remove(candId);
const st3 = builder.state();
ok('remove returns member to pool',
  st3.members.length === preRemove.members.length - 1 && st3.poolIds.indexOf(candId) >= 0);

// ============================================================================
// EXTENDED capabilities: auto-build, dating, dispositions, report, session.
// Drive a fresh builder end-to-end through the appCore helpers app.js wires up.
// ============================================================================
console.log('\n-- extended: auto-build / dating / dispositions / report / session --');

// 9. auto-build seeds itself and adds >= 2 members ----------------------------
const B = AC.newBuilder({ undated: undated, detrend: { detrending_select: 3, splinewindow: 21 } });
const ab = B.autoBuild({ r_val: 0.4, p_val: 0.05, overlap: 30 });
const abMembers = B.state().members;
ok('autoBuild added >= 2 members', abMembers.length >= 2, abMembers.length + ' members');
ok('autoBuild reports added/notAdded', Array.isArray(ab.added) && Array.isArray(ab.notAdded),
  ab.added.length + ' added / ' + ab.notAdded.length + ' not');

// 10. calendar dating: summary().dated true + members carry calendar years -----
const datumId = abMembers[0].id;
B.setDatum({ seriesId: datumId, edge: 'first', year: 1600 });
const sumD = B.summary();
ok('setDatum -> summary().dated true', sumD.dated === true);
ok('dated member carries calendar first/last year',
  typeof sumD.members[0].firstYear === 'number' && typeof sumD.members[0].lastYear === 'number',
  sumD.members[0].firstYear + '–' + sumD.members[0].lastYear);
ok('datum series first ring == pinned year',
  sumD.members.find(m => m.id === datumId).firstYear === 1600);
ok('datedChronology col0 is calendar years',
  B.datedChronology().names[0] && typeof B.datedChronology().cols[0][0] === 'number');

// 11. dispositions with notes appear in setAside; restore returns to pool ------
const poolNow = B.state().poolIds.slice();
const skipId = poolNow[0], reviewId = poolNow[1];
B.skip(skipId, 'thin overlap');
B.flagReview(reviewId, 'ambiguous match');
const sa = B.state().setAside;
ok('skip appears in setAside with note',
  sa.some(x => x.id === skipId && x.status === 'skipped' && x.note === 'thin overlap'));
ok('flagReview appears in setAside with note',
  sa.some(x => x.id === reviewId && x.status === 'review' && x.note === 'ambiguous match'));
ok('skipped/review left the live pool',
  B.state().poolIds.indexOf(skipId) < 0 && B.state().poolIds.indexOf(reviewId) < 0);
B.restore(skipId);
ok('restore returns series to the pool',
  B.statusOf(skipId) === 'pool' && B.state().poolIds.indexOf(skipId) >= 0);

// 12. builderReport HTML contains members + a stats line -----------------------
const repHtml = AC.builderReport(B.summary(), { date: '2026-08-04' });
ok('builderReport is HTML', /^<!DOCTYPE html>/i.test(repHtml) && repHtml.indexOf('</html>') > 0);
ok('report lists a member id', repHtml.indexOf(datumId) >= 0);
ok('report has a stats line (Rbar/EPS/Sample depth)',
  repHtml.indexOf('Rbar') >= 0 && repHtml.indexOf('EPS') >= 0 && repHtml.indexOf('Sample depth') >= 0);
ok('report has the dating statement', repHtml.indexOf('Dated:') >= 0 && repHtml.indexOf('1600') >= 0);
ok('report has the set-aside status', repHtml.indexOf('review') >= 0);

// 13. session round-trip: serialize -> JSON -> restore, members+datum equal ----
const ser = AC.serializeSession({
  undated: undated, detrend: { detrending_select: 3, splinewindow: 21 },
  builder: B, undatedName: 'undated_example.csv'
});
ok('serializeSession version + frames', ser.version === 1 && ser.undated && ser.undated.names && ser.builder,
  ser.builder.members.length + ' logged members');
const wire = JSON.parse(JSON.stringify(ser));           // prove it is JSON-able
const restored = AC.restoreSession(wire);
const om = B.state().members, rm = restored.builder.state().members;
ok('round-trip: same number of members', om.length === rm.length, om.length + ' vs ' + rm.length);
ok('round-trip: member ids+lags identical',
  om.length === rm.length && om.every((m, i) => m.id === rm[i].id && m.lag === rm[i].lag));
const od = B.datum(), rd = restored.builder.datum();
ok('round-trip: datum identical',
  !!od && !!rd && od.seriesId === rd.seriesId && od.edge === rd.edge && od.year === rd.year,
  rd ? (rd.seriesId + ' ' + rd.edge + ' ' + rd.year) : 'null');
ok('round-trip: setAside preserved',
  restored.builder.state().setAside.some(x => x.id === reviewId && x.note === 'ambiguous match'));
ok('round-trip: member note preserved (setNote replay)',
  (function () { B.setNote(abMembers[1].id, 'kept'); const s2 = AC.serializeSession({ undated: undated, builder: B, detrend: {} }); const r2 = AC.restoreSession(JSON.parse(JSON.stringify(s2))); return r2.builder.state().members.some(m => m.id === abMembers[1].id && m.note === 'kept'); })());

console.log(fails ? '\nFAIL' : '\nPASS: Build-chronology tab logic drives the builder end-to-end.');
process.exit(fails ? 1 : 0);
