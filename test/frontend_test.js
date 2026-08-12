'use strict';
// ============================================================================
// frontend_test.js — functional (no-DOM) validation of the main RingdateR web
// frontend. jsdom is not available, so instead of driving the HTML we drive the
// app's factored logic module (web/appCore.js), which is exactly what app.js
// wires to the DOM. This proves the browser app can run end-to-end:
//
//   load example CSV text  ->  loadUndated (via ringdater.bundle.js)
//   -> pairwiseWorkflow    ->  crossDatRes table (17 cols, row count == engine)
//   -> build each plot spec-> renderSvg  (well-formed non-empty <svg>)
//   -> buildDownloads      ->  descriptors ({filename, mime, content})
//   -> renderReport        ->  HTML string
//
// It loads the SAME bundle the browser loads (web/ringdater.bundle.js), so a
// broken bundle / missing export fails here. Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const AppCore = require('../web/appCore.js');            // -> requires the bundle
const RD = require('../web/ringdater.bundle.js').RD;     // engine oracle for row-count parity
const EXAMPLE = require('../web/exampleData.js');         // bundled example dataset

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}
function isSvg(s) {
  return typeof s === 'string' && /^<svg[\s\S]*<\/svg>$/.test(s.trim()) && s.length > 100;
}

console.log('RingdateR frontend — functional (no-DOM) test\n');

// 0. the bundled example dataset is present and looks like the CSV -------------
ok('example dataset bundled', EXAMPLE && typeof EXAMPLE.text === 'string' && /^Year,/.test(EXAMPLE.text),
  (EXAMPLE && EXAMPLE.text ? EXAMPLE.text.length + ' chars' : 'missing'));

// 1. load the example CSV via the app's loader --------------------------------
const undated = AppCore.loadUndated([{ name: EXAMPLE.name, text: EXAMPLE.text }]);
ok('loadUndated returns a Frame', !!(undated && undated.names && undated.cols),
  undated ? undated.names.length + ' cols x ' + undated.cols[0].length + ' rows' : 'null');
const names = AppCore.seriesNames(undated);
ok('series names extracted', names.length > 1, names.slice(0, 3).join(', ') + ' ...');

// 2. run the pairwise workflow through appCore --------------------------------
const detrendUI = { detrending_select: 3, splinewindow: 21, ARmod: false, logT: false };
const result = AppCore.runAnalysis({
  mode: 1,
  undated: undated,
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
});
ok('runAnalysis (pairwise) produced crossDatRes', !!(result && result.crossDatRes));
ok('runAnalysis produced aligned block', !!(result && result.aligned && result.aligned.names.length > 2),
  result.aligned ? result.aligned.names.length + ' aligned cols' : 'none');

// engine oracle: run the same pairwise workflow directly and compare shapes ----
const engine = RD.pairwiseWorkflow({
  undated: undated,
  detrend: { detrending_select: 3, splinewindow: 21 },
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
});

// 3. crossDatRes table: 17 columns, row count matches the engine --------------
const table = AppCore.crossDatTable(result.crossDatRes);
ok('crossDat table has 17 columns', table.columns.length === 17, table.columns.length + ' cols');
ok('crossDat columns are the fixed contract',
  table.columns[0] === 'Series_1' && table.columns[16] === 'Third_Overlap');
const engineRows = engine.crossDatRes.cols[0].length;
ok('crossDat table row count matches engine', table.rows.length === engineRows,
  'table ' + table.rows.length + ' vs engine ' + engineRows);
ok('every table row has 17 cells', table.rows.every(function (r) { return r.length === 17; }));

// 4. build each plot spec + renderSvg -----------------------------------------
const plots = AppCore.buildPlots(result, { colorScale: 1, lag: 0 });
['line', 'heatmap', 'leadLagBar', 'allSeries', 'detrend'].forEach(function (k) {
  const spec = plots[k];
  ok('plot spec built: ' + k, !!spec);
  const svg = AppCore.renderPlot(spec);
  ok('renderSvg(' + k + ') well-formed non-empty SVG', isSvg(svg), svg ? svg.length + ' chars' : 'empty');
});
// combined stacked SVG (what the plots area renders)
const combined = AppCore.combinedPlot([plots.line, plots.leadLagBar, plots.heatmap]);
ok('combined stacked SVG well-formed', isSvg(combined), combined.length + ' chars');

// 5. re-filter the crossDatRes (results-tab filter controls) -------------------
const refiltered = AppCore.refilter(result.crossDatRes, { r_val: 0.6, p_val: 0.01, overlap: 40, target: names[0] });
ok('refilter returns a Frame with 17 cols', !!(refiltered && refiltered.names.length === 17),
  refiltered ? refiltered.cols[0].length + ' rows kept' : 'null');

// 6. downloads: descriptors with filename/mime/content ------------------------
const dls = AppCore.downloads(result, { date: '2026-08-03' });
const dlKeys = Object.keys(dls);
ok('buildDownloads returns descriptors', dlKeys.length > 0, dlKeys.join(', '));
ok('every download descriptor is well-formed', dlKeys.every(function (k) {
  const d = dls[k];
  return d && typeof d.filename === 'string' && typeof d.mime === 'string' && d.content != null;
}));

// 7. report: self-contained HTML ----------------------------------------------
const html = AppCore.report(result, {
  files: { undated: EXAMPLE.name },
  settings: { verbose: false, probs: 30, rbarWindow: 30 }
});
ok('renderReport returns HTML', typeof html === 'string' && /^<!DOCTYPE html>/i.test(html.trim()) && /RingdateR/.test(html),
  html ? html.length + ' chars' : 'empty');

// 8. sliding-window segmentation ---------------------------------------------
const segResult = AppCore.slidingSegmentAnalysis({
  mode: 1, undated: undated,
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] },
  segLen: 60, keepN: 5
});
ok('sliding analysis produced a result bundle', !!(segResult && segResult.crossDatRes && segResult.segments));
const keptAll = [];
names.forEach(function (n) { (segResult.segments[n] || []).forEach(function (w) { keptAll.push(w); }); });
ok('kept windows exist and respect keepN', keptAll.length > 0 &&
  names.every(function (n) { return (segResult.segments[n] || []).length <= 5; }),
  keptAll.length + ' windows kept');
ok('window names carry ring ranges (name@a-b)', keptAll.every(function (w) { return /@\d+-\d+$/.test(w.name); }));
// diversity suppression: kept windows of one series overlap < 50%
const win = segResult.segLength;
ok('kept windows are diversity-suppressed (<50% overlap)', names.every(function (n) {
  const ws = segResult.segments[n] || [];
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
    if (Math.abs(ws[i].startRow - ws[j].startRow) < win / 2) return false;
  }
  return true;
}));
// each kept window's detrended column re-slices the detrended whole exactly
const w0 = keptAll[0];
const detWhole = segResult.detrended.cols[segResult.detrended.names.indexOf(w0.series)];
const detSeg = segResult.detrended.cols[segResult.detrended.names.indexOf(w0.name)];
let sliceOk = true;
for (let k = 0; k < win; k++) if (detSeg[k] !== detWhole[w0.startRow + k]) { sliceOk = false; break; }
ok('segment columns are slices of the detrended whole', sliceOk, w0.name);
// crossDatRes: segment blocks head the table, no segment-vs-segment rows
const isSegName = function (n) { return /@\d+-\d+$/.test(String(n)); };
const cdS1 = segResult.crossDatRes.cols[0], cdS2 = segResult.crossDatRes.cols[1];
let segSeg = 0, sameParent = 0, segWhole = 0, wholeWhole = 0;
const parentOf = function (n) { return String(n).replace(/@\d+-\d+$/, ''); };
for (let r = 0; r < cdS1.length; r++) {
  const a = cdS1[r], b = cdS2[r];
  if (a == null || b == null || a === b) continue;               // separator / header rows
  if (isSegName(a) && isSegName(b)) segSeg++;
  else if (parentOf(a) === parentOf(b)) sameParent++;
  else if (isSegName(a) || isSegName(b)) segWhole++;
  else wholeWhole++;
}
ok('no segment-vs-segment comparisons', segSeg === 0);
ok('no segment-vs-own-series comparisons', sameParent === 0);
ok('segment-vs-complete-series comparisons present', segWhole > 0, segWhole + ' rows');
ok('whole-vs-whole comparisons kept as baseline', wholeWhole > 0, wholeWhole + ' rows');
// windows selected for high r produce full-overlap, high-r table rows
const iOv = segResult.crossDatRes.names.indexOf('First_Overlap');
const iR = segResult.crossDatRes.names.indexOf('First_R');
let maxSegOverlap = 0, maxSegR = 0;
for (let r2 = 0; r2 < cdS1.length; r2++) {
  const a2 = cdS1[r2], b2 = cdS2[r2];
  if (a2 == null || b2 == null || a2 === b2) continue;
  if (isSegName(a2) || isSegName(b2)) {
    if (segResult.crossDatRes.cols[iOv][r2] > maxSegOverlap) maxSegOverlap = segResult.crossDatRes.cols[iOv][r2];
    if (segResult.crossDatRes.cols[iR][r2] > maxSegR) maxSegR = segResult.crossDatRes.cols[iR][r2];
  }
}
ok('a segment can fully overlap a complete series', maxSegOverlap >= win - 5, 'max overlap ' + maxSegOverlap);
ok('kept segments include strong matches', maxSegR >= 0.7, 'max r ' + maxSegR.toFixed(3));
ok('sliding run aligned block present', !!(segResult.aligned && segResult.aligned.names.length >= 2),
  (segResult.aligned.names.length - 1) + ' aligned series');
const segName0 = keptAll.find(function (w) { return w.series !== names[0]; }).name;
const segRefilter = AppCore.refilter(segResult.crossDatRes, { r_val: 0, p_val: 1, overlap: 10, target: segName0 });
ok('a segment works as the results-table target', !!segRefilter && segRefilter.cols[0].length > 0,
  segName0 + ': ' + segRefilter.cols[0].length + ' rows');
const segPlots = AppCore.buildPlots(segResult, { pair: [segName0, names[0]] });
ok('segment-vs-whole plots render', isSvg(AppCore.renderPlot(segPlots.line)) && isSvg(AppCore.renderPlot(segPlots.heatmap)));

// 9. multi-chronology composite: mean of the detrended chronologies -----------
const rwl1 = fs.readFileSync(path.join(__dirname, '..', 'ut585', 'ut585.rwl'), 'utf8');
const rwl2 = fs.readFileSync(path.join(__dirname, '..', 'ut585', 'CMP511.rwl'), 'utf8');
const chronA = AppCore.loadChron({ name: 'ut585.rwl', text: rwl1 });
const chronB = AppCore.loadChron({ name: 'CMP511.rwl', text: rwl2 });
const comp = AppCore.compositeChron([{ name: 'ut585.rwl', frame: chronA }, { name: 'CMP511.rwl', frame: chronB }], detrendUI);
ok('compositeChron: one column per chronology', !!comp && comp.names.length === 3,
  comp ? comp.names.join(', ') : 'null');
// each composite column equals that chronology's detrended mean on shared years
const meanA = RD.meanChronology(RD.normalise(chronA, AppCore.detrendOptions(detrendUI)), 'a');
const yShared = meanA.cols[0][10];
const compRow = comp.cols[0].indexOf(yShared);
ok('composite column 1 equals chronology A detrended mean',
  compRow >= 0 && Math.abs(comp.cols[1][compRow] - meanA.cols[1][10]) < 1e-12);
const compResult = AppCore.runAnalysis({
  mode: 2, undated: undated, chron: comp, chronIsDetrended: true,
  chronName: 'composite of 2 chronologies',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 }
});
ok('composite chronology run produced crossDatRes', !!(compResult && compResult.crossDatRes),
  compResult ? compResult.crossDatRes.cols[0].length + ' rows' : 'null');
ok('chronIsDetrended skips the second detrend (chronDetrended === input)',
  compResult.chronDetrended === comp);
const compPlots = AppCore.buildPlots(compResult, {});
ok('composite run plots render', isSvg(AppCore.renderPlot(compPlots.line)) && isSvg(AppCore.renderPlot(compPlots.leadLagBar)));

// 10. sliding segments in chronology mode --------------------------------------
const rwl3 = fs.readFileSync(path.join(__dirname, '..', 'ut585', 'CMP519A.rwl'), 'utf8');
const chronC = AppCore.loadChron({ name: 'CMP519A.rwl', text: rwl3 });
const compSmall = AppCore.compositeChron(
  [{ name: 'CMP511.rwl', frame: chronB }, { name: 'CMP519A.rwl', frame: chronC }], detrendUI);
const slide2 = AppCore.slidingSegmentAnalysis({
  mode: 2, undated: undated, chron: compSmall, chronIsDetrended: true,
  chronName: 'composite of 2 chronologies',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 },
  segLen: 60, keepN: 3
});
ok('sliding chronology-mode run produced crossDatRes', !!(slide2 && slide2.crossDatRes),
  slide2 ? slide2.crossDatRes.cols[0].length + ' rows' : 'null');
const kept2 = [];
names.forEach(function (n) { (slide2.segments[n] || []).forEach(function (w) { kept2.push(w); }); });
ok('chronology-mode windows kept (<=3 per series, vs mean_chronology)',
  kept2.length > 0 && kept2.every(function (w) { return w.comp === 'mean_chronology'; }) &&
  names.every(function (n) { return (slide2.segments[n] || []).length <= 3; }),
  kept2.length + ' windows');
ok('chronology-mode comparison frame carries wholes + segments',
  slide2.chronNSeries.names.length - 2 === names.length + kept2.length);
const slide2Plots = AppCore.buildPlots(slide2, {});
ok('sliding chronology-mode plots render', isSvg(AppCore.renderPlot(slide2Plots.line)));

// 11. missing/false ring test ---------------------------------------------------
// fabricate a missing ring: delete ring 90 of sample_h, test vs sample_i.
const hVals = undated.cols[undated.names.indexOf('sample_h')].filter(function (v) { return v != null; });
const defect = hVals.slice(0, 89).concat(hVals.slice(90));
const rtFrame = { names: undated.names.concat(['h_defect']), cols: undated.cols.concat([defect]) };
const runner = AppCore.ringTest({
  undated: rtFrame, series: 'h_defect',
  reference: { kind: 'series', name: 'sample_i' },
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true }
});
ok('ringTest runner created', runner.total === 2 * 209 - 1 && runner.seriesLength === 209,
  runner.total + ' experiments over ' + runner.seriesLength + ' rings');
ok('ringTest baseline scored', runner.baseline.t != null && runner.baseline.overlap > 100,
  'baseline T ' + runner.baseline.t.toFixed(2));
while (!runner.step(100));
const rt = runner.results();
const best = rt.experiments[0];
ok('ring test finds the fabricated missing ring (split near ring 90)',
  best.type === 'split' && Math.abs(best.ring - 90) <= 3 && best.fruitful,
  best.type + ' ring ' + best.ring + ', dT +' + best.dT.toFixed(1));
ok('edit improves the crossdate substantially', best.dT > 10, 'dT ' + best.dT.toFixed(1));
const rev = runner.review(best);
ok('experiment review returns renderable plots + stats',
  isSvg(AppCore.renderPlot(rev.line)) && isSvg(AppCore.renderPlot(rev.skeleton)) &&
  isSvg(AppCore.renderPlot(rev.heatmap)) && isSvg(AppCore.renderPlot(rev.leadLagBar)) &&
  rev.stats && rev.stats.r > 0.9,
  'r ' + rev.stats.r.toFixed(3) + ' at lag ' + rev.lag);
ok('review header names the corrected series', /h_defect\+ring\d+/.test(rev.header), rev.header);
const baseRev = runner.review(null);
ok('baseline review renders too', isSvg(AppCore.renderPlot(baseRev.line)) && baseRev.stats.r < rev.stats.r,
  'baseline r ' + baseRev.stats.r.toFixed(3) + ' vs corrected r ' + rev.stats.r.toFixed(3));
// clean series: no fruitful edits
const cleanRunner = AppCore.ringTest({
  undated: undated, series: 'sample_h',
  reference: { kind: 'series', name: 'sample_i' },
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true }
});
while (!cleanRunner.step(100));
ok('clean series yields no fruitful edits', cleanRunner.results().fruitful.length === 0);
// chronology reference path works
const chronRunner = AppCore.ringTest({
  undated: undated, series: 'sample_a',
  reference: { kind: 'chron', frame: compSmall, isDetrended: true },
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true }
});
ok('ringTest accepts a chronology reference', chronRunner.total > 0 && typeof chronRunner.step === 'function');

// ---- done -------------------------------------------------------------------
console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'PASS: web frontend runs end-to-end (load -> workflow -> table -> plots -> downloads -> report).'));
process.exit(fails ? 1 : 0);
