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
// synthetic dated chronologies built from the example series, so the suite
// carries no dependency on local sample-data files.
function datedFrame(memberNames, startYear, offsetStep) {
  const runs = memberNames.map(function (n) {
    return undated.cols[undated.names.indexOf(n)].filter(function (v) { return v != null; });
  });
  const nrow = Math.max.apply(null, runs.map(function (v, i) { return i * offsetStep + v.length; }));
  const years = [];
  for (let y = 0; y < nrow; y++) years.push(startYear + y);
  const cols = runs.map(function (vals, i) {
    const col = new Array(nrow).fill(null);
    vals.forEach(function (v, k) { col[i * offsetStep + k] = v; });
    return col;
  });
  return { names: ['years'].concat(memberNames.map(function (n) { return n + '_c'; })), cols: [years].concat(cols) };
}
const chronA = datedFrame(['sample_a', 'sample_b', 'sample_c'], 1000, 25);
const chronB = datedFrame(['sample_f'], 1200, 0);
const comp = AppCore.compositeChron([{ name: 'chronA.rwl', frame: chronA }, { name: 'chronB.rwl', frame: chronB }], detrendUI);
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
const chronC = datedFrame(['sample_g'], 1230, 0);
const compSmall = AppCore.compositeChron(
  [{ name: 'chronB.rwl', frame: chronB }, { name: 'chronC.rwl', frame: chronC }], detrendUI);
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
while (defect.length < undated.cols[0].length) defect.push(null);   // keep the frame rectangular
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
// corrected-series export: the best edit applied to the raw values, as .rwl
const corr = runner.corrected(best);
ok('corrected() applies the edit to the raw series',
  corr.values.length === runner.seriesLength + (best.type === 'split' ? 1 : -1) &&
  corr.name === 'h_defect' + (best.type === 'split' ? '+ring' : '-ring') + best.ring,
  corr.name + ', ' + corr.values.length + ' rings');
const dl = runner.correctedDownload(best);
ok('correctedDownload() produces an .rwl descriptor',
  /_corrected\.rwl$/.test(dl.filename) && dl.mime === 'text/plain' && dl.content.length > 200, dl.filename);
const reload = AppCore.loadUndated([{ name: dl.filename, text: dl.content }]);
const reloadVals = reload.cols[reload.names.length - 1].filter(function (v) { return v != null; });
ok('the .rwl round-trips (length + first value)',
  reloadVals.length === corr.values.length && Math.abs(reloadVals[0] - corr.values[0]) < 0.01,
  reloadVals.length + ' rings');
// iterative pass: re-test the corrected series via seriesValues — the defect is
// gone, so the new baseline matches the edit's score and nothing bears fruit
const runner2 = AppCore.ringTest({
  undated: rtFrame, series: corr.name, seriesValues: corr.values,
  reference: { kind: 'series', name: 'sample_i' },
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true }
});
ok('iterative pass starts from the corrected baseline',
  Math.abs(runner2.baseline.t - best.t) < 1e-9,
  'T ' + runner2.baseline.t.toFixed(2) + ' vs edit T ' + best.t.toFixed(2));
while (!runner2.step(100));
ok('corrected series comes back clean (no further fruitful edits)',
  runner2.results().fruitful.length === 0);

// 12. segment placement diagnosis ----------------------------------------------
// clean control: sample_c's kept windows all place consistently vs sample_a
const cleanSegs = (segResult.segments['sample_c'] || []).map(function (w) { return w.name; });
ok('control series has multiple kept segments', cleanSegs.length >= 2, cleanSegs.length + ' segments');
const diagClean = AppCore.diagnoseSegments(segResult, cleanSegs, 'sample_a');
ok('clean series: every neighbour offset is zero',
  diagClean.entries.every(function (e, i) { return i === 0 ? e.dPrev == null : e.dPrev === 0; }),
  diagClean.entries.map(function (e) { return e.dPrev; }).join(','));
ok('whole-series context row matches the segment placements',
  diagClean.whole && Math.abs(diagClean.whole.placement - diagClean.entries[0].placement) <= 2);
ok('alternate-lag placements carried as data',
  diagClean.entries.every(function (e) { return Array.isArray(e.alts); }));
ok('placement plot spec renders', isSvg(AppCore.renderPlot(diagClean.plot)));
// defect: sliding run on the frame with sample_h's ring 90 deleted (rtFrame)
const diagRun = AppCore.slidingSegmentAnalysis({
  mode: 1, undated: rtFrame,
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] },
  segLen: 60, keepN: 5
});
const dSegs = (diagRun.segments['h_defect'] || []).map(function (w) { return w.name; });
ok('defective series has multiple kept segments', dSegs.length >= 3, dSegs.length + ' segments');
const diagDef = AppCore.diagnoseSegments(diagRun, dSegs, 'sample_i');
ok('the +1 offset across the defect appears in the placements',
  diagDef.entries.filter(function (e) { return e.dPrev === 1; }).length === 1 &&
  diagDef.entries.every(function (e) { return e.dPrev == null || e.dPrev === 0 || e.dPrev === 1; }),
  diagDef.entries.map(function (e) { return e.dPrev; }).join(','));
// guard rails: mixed series and bad input throw
let threw = false;
try { AppCore.diagnoseSegments(segResult, [cleanSegs[0], dSegs[0]], 'sample_a'); } catch (e) { threw = true; }
ok('mixing segments of two series throws', threw);

// 13. full-series lag conversion ------------------------------------------------
const wSeg = keptAll[0];
const refW = names.find(function (n) { return n !== wSeg.series; });
const segPlotLag = AppCore.bestLagFor(segResult, wSeg.name, refW);
const conv = AppCore.fullSeriesLag(segResult, wSeg.name, segPlotLag, false);   // segment plotted as series 1
ok('fullSeriesLag swaps in the parent at the offset-corrected lag',
  conv.series === wSeg.series && conv.lag === segPlotLag + (wSeg.ringStart - 1),
  wSeg.name + ' lag ' + segPlotLag + ' -> ' + conv.series + ' lag ' + conv.lag);
const statsSeg = AppCore.buildPlots(segResult, { pair: [wSeg.name, refW], lag: segPlotLag }).stats;
const statsFull = AppCore.buildPlots(segResult, { pair: [conv.series, refW], lag: conv.lag }).stats;
ok('full series at the converted lag extends the segment alignment',
  statsFull && statsSeg && statsFull.overlap >= statsSeg.overlap && statsFull.r != null,
  'overlap ' + statsSeg.overlap + ' -> ' + statsFull.overlap + ', full r ' + (statsFull.r && statsFull.r.toFixed(3)));
const convS2 = AppCore.fullSeriesLag(segResult, wSeg.name, segPlotLag, true);  // segment plotted as series 2
ok('series-2 conversion subtracts the offset', convS2.lag === segPlotLag - (wSeg.ringStart - 1));

// 14. segment-consensus lag ranking (chronology mode) ---------------------------
// Every mode-2 run segments in the background; >=2 well-dated segments agreeing
// on a series' implied placement out-rank the whole-series best lag.
// Construction: sample_a with 3 deleted rings + 40% deterministic noise — the
// full-series correlation is diluted at every lag (engine best goes elsewhere)
// while 60-ring segments still date strongly at the true placement (lag 0).
function lcg(seed) { let s = seed >>> 0; return function () { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
const aVals = undated.cols[undated.names.indexOf('sample_a')].filter(function (v) { return v != null; });
const rnd = lcg(42);
let consBroken = aVals.map(function (v) { return v * (0.6 + 0.8 * rnd()); });
[180, 120, 60].forEach(function (d) { consBroken = consBroken.slice(0, d).concat(consBroken.slice(d + 1)); });
const cVals = undated.cols[undated.names.indexOf('sample_c')].filter(function (v) { return v != null; });
const consN = Math.max(consBroken.length, cVals.length);
const consPad = function (v) { return v.concat(new Array(consN - v.length).fill(null)); };
const consFrame = {
  names: ['ring', 'a_broken', 'c_clean'],
  cols: [Array.from({ length: consN }, function (_, i) { return i + 1; }), consPad(consBroken), consPad(cVals)]
};
const consRes = AppCore.runAnalysis({
  mode: 2, undated: consFrame, chron: chronA, chronName: 'chronA',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 },
  segLen: 60, keepN: 5
});
const consBy = (consRes.consensus && consRes.consensus.bySeries) || {};
ok('chronology run carries a consensus block', !!consRes.consensus && !!consRes.consensus.counts,
  consRes.consensus ? JSON.stringify(consRes.consensus.counts) : 'missing');
const cb = consBy.a_broken;
ok('broken series: strong consensus at the true placement (lag 0)',
  !!cb && cb.action === 'promoted' && cb.tier === 'strong' && Math.abs(cb.lag) <= 2 && cb.nSegs >= 2,
  cb ? cb.action + '/' + cb.tier + ' lag ' + cb.lag + ', ' + cb.nSegs + ' segs, minP ' + cb.minP.toExponential(1) : 'none');
ok('promotion out-ranked a wrong engine best (>tol away)',
  !!cb && Math.abs(cb.engineLag - cb.lag) > AppCore.CONSENSUS.tol, cb ? 'engine ' + cb.engineLag : '');
// the promoted row: consensus lag 1st, engine best demoted to 2nd
const ccd = consRes.crossDatRes;
let consRow = -1;
for (let r = 0; r < ccd.cols[0].length; r++) if (ccd.cols[0][r] === 'mean_chronology' && ccd.cols[1][r] === 'a_broken') consRow = r;
ok('table row shows consensus lag 1st, engine best 2nd',
  consRow >= 0 && Number(ccd.cols[5][consRow]) === cb.lag && Number(ccd.cols[9][consRow]) === cb.engineLag,
  consRow >= 0 ? '1st ' + ccd.cols[5][consRow] + ', 2nd ' + ccd.cols[9][consRow] : 'row missing');
ok('promoted series joins the aligned output', consRes.aligned.names.indexOf('a_broken') >= 0);
const cc = consBy.c_clean;
ok('clean member series: consensus confirms the engine lag (50)',
  !!cc && cc.action === 'confirmed' && cc.lag === 50 && cc.engineLag === 50,
  cc ? cc.action + ' lag ' + cc.lag : 'none');
// corrected p-values above 1 display as 1 (Bonferroni cap)
ok('fmtP caps corrected p at 1', AppCore.fmtP(2300) === '1' && AppCore.fmtP(0.5) === '0.5');
// unit: clustering gates on p and keeps drift chains together
const CN = ['Series_1', 'Series_2', 'First_ring', 'Last_ring', 'col',
  'First_lag', 'First_R', 'First_P', 'First_Overlap', 'Sec_lag', 'Sec_R', 'Sec_P', 'Sec_Overlap',
  'Third_lag', 'Third_R', 'Third_P', 'Third_Overlap'];
const segRows = [
  ['ref', 's@1-61',    900, 960, 3, 100, 0.8, 1e-8, 61, 400, 0.5, 0.9, 61, null, null, null, null],
  ['ref', 's@71-131',  970, 1030, 4, 173, 0.7, 1e-6, 61, 800, 0.4, 2.0, 61, null, null, null, null],
  ['ref', 's@141-201', 1500, 1560, 5, 640, 0.6, 0.2, 61, null, null, null, null, null, null, null, null]
];
const segCross = { names: CN, cols: CN.map(function (_, i) { return segRows.map(function (r) { return r[i]; }); }) };
const segMeta = { s: [
  { name: 's@1-61', startRow: 0 }, { name: 's@71-131', startRow: 70 }, { name: 's@141-201', startRow: 140 }
] };
const unit = AppCore.consensusFromRows(segCross, segMeta, 'ref');
ok('consensusFromRows: drift chain clusters (100 + 103), p-gated candidates dropped',
  !!unit.s && unit.s.lag === 100 && unit.s.nSegs === 2 && unit.s.tier === 'strong',
  unit.s ? 'lag ' + unit.s.lag + ', ' + unit.s.nSegs + ' segs, ' + unit.s.tier : 'none');

// a custom consensus segment length flows through (windows forced odd: 80 -> 81)
const consRes81 = AppCore.runAnalysis({
  mode: 2, undated: consFrame, chron: chronA, chronName: 'chronA',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 },
  segLen: 80, keepN: 5
});
ok('consensus honours a custom segment length',
  consRes81.consensus && consRes81.consensus.segLength === 81 &&
  !!consRes81.consensus.bySeries.a_broken,
  consRes81.consensus ? 'segLength ' + consRes81.consensus.segLength + ', a_broken ' +
    (consRes81.consensus.bySeries.a_broken || {}).action : 'missing');

// 15. stepwise analysis runner ---------------------------------------------------
// The progress-bar host drives AppCore.analysisRunner step by step; it must
// deliver the same bundle runAnalysis returns (runAnalysis IS the runner run
// to completion), with one grid step per series and honest progress counters.
const stepRunner = AppCore.analysisRunner({
  mode: 2, undated: consFrame, chron: chronA, chronName: 'chronA',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 },
  segLen: 60, keepN: 5
});
const stepLabels = [];
ok('runner: 1 workflow + per-series grids + consensus steps',
  stepRunner.total() === 1 + 2 + 1 && stepRunner.progress() === 0 && !stepRunner.done(),
  stepRunner.total() + ' steps');
while (!stepRunner.done()) { stepLabels.push(stepRunner.label()); stepRunner.step(); }
ok('runner: labels name the phases',
  stepLabels[0] === 'Crossdating vs chronology' &&
  stepLabels[1] === 'Scanning segments of a_broken' &&
  stepLabels[stepLabels.length - 1] === 'Segment consensus', stepLabels.join(' | '));
const stepRes = stepRunner.result();
ok('runner result matches the synchronous run',
  stepRes.crossDatRes.cols[0].length === consRes.crossDatRes.cols[0].length &&
  stepRes.consensus.bySeries.a_broken.lag === consBy.a_broken.lag &&
  stepRes.consensus.bySeries.a_broken.action === 'promoted');

// ---- done -------------------------------------------------------------------
console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'PASS: web frontend runs end-to-end (load -> workflow -> table -> plots -> downloads -> report).'));
process.exit(fails ? 1 : 0);
