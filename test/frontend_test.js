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
// the heatmap's lag axis: a band beside the other plots, every scanned lag on
// its own (viewed alone in the app, where there is room for it)
const hmPair = [names[0], names[1]];
const band = AppCore.buildPlots(result, { pair: hmPair, lag: 0 });
const full = AppCore.buildPlots(result, { pair: hmPair, lag: 0, heatmapFull: true });
const scanned = AppCore.scannedLagSpan(result, hmPair[0], hmPair[1]);
ok('the scanned lag span is recovered from the lead-lag block',
  !!scanned && scanned.neg < -100 && scanned.pos > 100,
  scanned ? scanned.neg + ' … ' + scanned.pos : 'null');
ok('the default heatmap is a 41-lag band',
  band.heatmapSpan.pos - band.heatmapSpan.neg === 40,
  band.heatmapSpan.neg + ' … ' + band.heatmapSpan.pos);
ok('heatmapFull opens the lag axis far wider',
  full.heatmapSpan.pos - full.heatmapSpan.neg > 4 * (band.heatmapSpan.pos - band.heatmapSpan.neg) &&
  full.heatmapSpan.neg >= scanned.neg && full.heatmapSpan.pos <= scanned.pos,
  full.heatmapSpan.neg + ' … ' + full.heatmapSpan.pos + ' of ' + scanned.neg + ' … ' + scanned.pos);
ok('the full heatmap carries more cells and is taller',
  full.heatmap.marks[0].x.length > 5 * band.heatmap.marks[0].x.length &&
  full.heatmap.height > band.heatmap.height && full.heatmap.width >= band.heatmap.width,
  full.heatmap.marks[0].x.length + ' cells at ' + full.heatmap.width + 'x' + full.heatmap.height +
  ' vs ' + band.heatmap.marks[0].x.length + ' at ' + band.heatmap.width + 'x' + band.heatmap.height);
ok('the full heatmap renders', isSvg(AppCore.renderPlot(full.heatmap)));
ok('an explicit size overrides the default',
  AppCore.buildPlots(result, { pair: hmPair, heatmapFull: true, heatmapSize: { width: 900, height: 500 } })
    .heatmap.width === 900);
ok('no lead-lag block for a pair leaves the band alone',
  AppCore.scannedLagSpan(result, hmPair[0], 'not_a_series') === null);

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

// What the linked hover cursor calls a position in each plotted series
// (spec.linkSeries -> ownAxis in src/viz/render.js). The comparison frame's
// axis is the CHRONOLOGY's calendar years, so the mean chronology is labelled
// in years; the undated series has no years to name — it is the series being
// dated — and is labelled by ring count from its own first ring, which is the
// number the measuring table shows.
const compLink = compPlots.line.linkSeries;
const compX = compPlots.line.data.series_2.x;
ok('chronology-mode cursor labels the chronology in calendar years',
  compLink[0].unit === 'year' && compLink[0].offset === 0 &&
  compLink[0].span[0] === compPlots.line.data.series_1.x[0],
  JSON.stringify(compLink[0]));
ok('...and the undated series in ring counts from its own first ring',
  compLink[1].unit === 'ring' && compLink[1].offset === 1 - compX[0] &&
  compLink[1].span[0] === 1 && compLink[1].span[1] === compX[compX.length - 1] + compLink[1].offset,
  JSON.stringify(compLink[1]) + ' first drawn x ' + compX[0]);
ok('the skeleton plot counts the same rings',
  compPlots.skeleton.panels[0].linkSeries[1].unit === 'ring' &&
  compPlots.skeleton.panels[0].linkSeries[1].offset === compLink[1].offset &&
  compPlots.skeleton.panels[0].linkSeries[0].unit === 'year',
  JSON.stringify(compPlots.skeleton.panels[0].linkSeries));

// 9b. already-detrended data is not detrended twice -----------------------------
// The engine detrends whatever it is handed. A run now looks first: series that
// are already indices are carried through as they are (src/detrend/detect.js
// decides; test/detect_test.js covers the rules), and the chronology can be
// excluded by hand — "detrend the pool but not the chronology" is the ordinary
// shape of a .crn read against raw measurements.
const detPool = RD.normalise(undated, AppCore.detrendOptions(detrendUI));
const skipRun = AppCore.runAnalysis({
  mode: 1, undated: detPool, detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
});
ok('a run detects series that are already detrended',
  !!skipRun.detrendSkipped && skipRun.detrendSkipped.undated.all &&
  skipRun.detrendSkipped.undated.names.length === names.length,
  skipRun.detrendSkipped ? skipRun.detrendSkipped.undated.names.length + '/' + names.length : 'missing');
// Detrending an index a second time is not free: the double pass and the
// single pass are not the same numbers.
ok('...and leaves them alone, where a second pass would not',
  (function () {
    const c = function (f, n) { return f.cols[f.names.indexOf(n)]; };
    const kept = c(skipRun.detrended, names[0]);
    const twice = c(RD.normalise(detPool, AppCore.detrendOptions(detrendUI)), names[0]);
    let same = 0, diff = 0;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i] == null || twice[i] == null) continue;
      if (Math.abs(kept[i] - twice[i]) < 1e-9) same++; else diff++;
    }
    return diff > same;
  })());
ok('...which the caller can turn off',
  AppCore.runAnalysis({
    mode: 1, undated: detPool, detrend: detrendUI, autoSkip: false,
    leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
    filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
  }).detrendSkipped.undated.names.length === 0);
// Raw widths are untouched by any of this: the run is bit-for-bit what it was.
ok('a run on raw widths is unchanged by the detection',
  (function () {
    const r = AppCore.runAnalysis({
      mode: 1, undated: undated, detrend: detrendUI,
      leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
      filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
    });
    if (r.detrendSkipped.undated.names.length) return false;
    return names.every(function (n) {
      const a = r.detrended.cols[r.detrended.names.indexOf(n)];
      const b = result.detrended.cols[result.detrended.names.indexOf(n)];
      return a.every(function (v, i) { return v === b[i]; });
    });
  })());

// The chronology gets its own settings. Method 1 is "leave it alone", which is
// what the rail's "Detrend the chronology too" tick clears to.
const chronRawRun = AppCore.runAnalysis({
  mode: 2, undated: undated, chron: chronA, chronName: 'chronA.rwl',
  detrend: detrendUI, detrendChron: { detrending_select: 1 },
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 }
});
ok('the chronology can be left un-detrended while the pool is detrended',
  (function () {
    const cd = chronRawRun.chronDetrended;
    const raw = RD.normalise(chronA, { detrending_select: 1 });
    const c = function (f, n) { return f.cols[f.names.indexOf(n)]; };
    const sameChron = cd.names.slice(1).every(function (n) {
      return c(cd, n).every(function (v, i) { return v === c(raw, n)[i]; });
    });
    // ...while the undated pool went through the spline as asked
    const det = c(chronRawRun.detrended, names[0]);
    const rawU = c(undated, names[0]);
    return sameChron && det.some(function (v, i) { return v != null && rawU[i] != null && Math.abs(v - rawU[i]) > 1e-9; });
  })());
ok('...and the run still crossdates', chronRawRun.crossDatRes.cols[0].length > 0,
  chronRawRun.crossDatRes.cols[0].length + ' rows');
// A chronology that IS already an index is spotted without being told.
const detChron = RD.normalise(chronA, AppCore.detrendOptions(detrendUI));
const chronDetRun = AppCore.runAnalysis({
  mode: 2, undated: undated, chron: detChron, chronName: 'indices.csv',
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30 }
});
ok('an already-detrended chronology is detected on its own',
  chronDetRun.detrendSkipped.chron.all &&
  chronDetRun.detrendSkipped.chron.names.length === detChron.names.length - 1,
  JSON.stringify(chronDetRun.detrendSkipped.chron.names));
ok('...and the composite path judges each chronology separately',
  (function () {
    const mixedComp = AppCore.compositeChron(
      [{ name: 'indices.csv', frame: detChron }, { name: 'chronB.rwl', frame: chronB }], detrendUI);
    return !!mixedComp && mixedComp.names.length === 3;
  })());

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
// a ring named by hand: scored and judged exactly as the sweep scores its own,
// and available WITHOUT the sweep — this runner is never stepped.
const hand = AppCore.ringTest({
  undated: rtFrame, series: 'h_defect',
  reference: { kind: 'series', name: 'sample_i' },
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true }
});
const handBest = hand.scoreEdit({ type: best.type, ring: best.ring });
ok('scoreEdit() reproduces the swept experiment exactly',
  handBest.t === best.t && handBest.r === best.r && handBest.lag === best.lag &&
  handBest.dT === best.dT && handBest.fruitful === best.fruitful,
  'T ' + handBest.t.toFixed(2) + ', dT +' + handBest.dT.toFixed(1));
const handDud = hand.scoreEdit({ type: 'merge', ring: 5 });
ok('an edit the data does not support is reported as barren',
  handDud.fruitful === false && handDud.dT < 1, 'dT ' + handDud.dT.toFixed(2));
ok('scoreEdit(null) is the baseline', hand.scoreEdit(null).t === hand.baseline.t &&
  hand.scoreEdit(null).dT === 0 && hand.scoreEdit(null).fruitful === false);
ok('maxRing bounds each kind of edit',
  hand.maxRing('split') === hand.seriesLength && hand.maxRing('merge') === hand.seriesLength - 1);
// a ring outside the series is refused with a message rather than scored as NaN
function refuses(fn) { try { fn(); return false; } catch (e) { return /outside|Edit type/.test(e.message); } }
ok('a ring past the end of the series is refused',
  refuses(function () { return hand.scoreEdit({ type: 'split', ring: hand.seriesLength + 1 }); }));
ok('ring 0 is refused', refuses(function () { return hand.scoreEdit({ type: 'split', ring: 0 }); }));
ok('merge stops one ring short of the end',
  refuses(function () { return hand.scoreEdit({ type: 'merge', ring: hand.seriesLength }); }) &&
  !refuses(function () { return hand.scoreEdit({ type: 'merge', ring: hand.seriesLength - 1 }); }));
ok('an unknown edit type is refused',
  refuses(function () { return hand.scoreEdit({ type: 'shrink', ring: 10 }); }));
ok('review() and corrected() refuse the same bad ring',
  refuses(function () { return hand.review({ type: 'split', ring: 0 }); }) &&
  refuses(function () { return hand.corrected({ type: 'merge', ring: hand.seriesLength }); }));
// a hand-named edit reviews and exports like a swept one
const handRev = hand.review({ type: best.type, ring: best.ring });
ok('a hand-named edit reviews like a swept one',
  isSvg(AppCore.renderPlot(handRev.line)) && Math.abs(handRev.stats.r - rev.stats.r) < 1e-12,
  'r ' + handRev.stats.r.toFixed(3));
ok('a hand-named edit exports the corrected .rwl',
  /_corrected\.rwl$/.test(hand.correctedDownload({ type: best.type, ring: best.ring }).filename));

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

// 14b. segment consensus in PAIRWISE mode --------------------------------------
// Pairwise mode has no mean chronology, so the run TARGET plays the master:
// segments of every OTHER series are read against it, and only against it —
// one grid per series rather than one per pair. Two things differ from mode 2
// and both are checked here: the target must never be evidence about itself,
// and a pairwise row lists its pair in column order, so for a series that comes
// BEFORE the target the row reads (series, target) and every consensus lag has
// to be written into it the other way round.
const pwFrame = {
  names: ['a_broken', 'c_clean', 'e_clean'].reduce(function (a, n) { return a.concat([n]); }, ['ring']),
  cols: (function () {
    const c = undated.cols[undated.names.indexOf('sample_c')].filter(function (v) { return v != null; });
    const e = undated.cols[undated.names.indexOf('sample_e')].filter(function (v) { return v != null; });
    const n = Math.max(consBroken.length, c.length, e.length);
    const p = function (v) { return v.concat(new Array(n - v.length).fill(null)); };
    return [Array.from({ length: n }, function (_, i) { return i + 1; }), p(consBroken), p(c), p(e)];
  })()
};
const pwRunner = AppCore.analysisRunner({
  mode: 1, undated: pwFrame, detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: 'c_clean' },
  segLen: 60, keepN: 5
});
const pwLabels = [];
while (!pwRunner.done()) { pwLabels.push(pwRunner.label()); pwRunner.step(); }
const pwRes = pwRunner.result();
ok('pairwise run carries a consensus block', !!(pwRes.consensus && pwRes.consensus.counts),
  pwRes.consensus ? JSON.stringify(pwRes.consensus.counts) : 'missing');
ok('...scanned once per series against the target, not once per pair',
  pwLabels.filter(function (l) { return /^Scanning segments of /.test(l); }).join(',') ===
    'Scanning segments of a_broken,Scanning segments of e_clean' &&
  pwLabels[pwLabels.length - 1] === 'Segment consensus',
  pwLabels.join(' | '));
ok('...and the target is never evidence about itself',
  Object.keys(pwRes.consensus.bySeries).indexOf('c_clean') < 0,
  Object.keys(pwRes.consensus.bySeries).join(','));
const pwB = pwRes.consensus.bySeries.a_broken;
ok('the broken series gets a strong consensus at its true placement',
  !!pwB && pwB.tier === 'strong' && pwB.nSegs >= 2 && Math.abs(pwB.lag - pwB.engineLag) <= AppCore.CONSENSUS.tol &&
  pwB.action === 'confirmed',
  pwB ? pwB.action + '/' + pwB.tier + ' lag ' + pwB.lag + ' vs engine ' + pwB.engineLag + ', ' + pwB.nSegs + ' segs' : 'none');
// its whole-series r is diluted below the filter — the rescue is the point of
// the pass, and it has to work on a row that lists the pair the other way round
ok('...and is kept in the filtered set the r/p filter had dropped',
  !!pwB.injected && (function () {
    for (let r = 0; r < pwRes.filtered.cols[0].length; r++) {
      if (pwRes.filtered.cols[0][r] === 'a_broken' && pwRes.filtered.cols[1][r] === 'c_clean') return true;
    }
    return false;
  })(),
  'injected ' + !!pwB.injected);
ok('...so it joins the aligned output', pwRes.aligned.names.indexOf('a_broken') >= 0,
  pwRes.aligned.names.join(','));

// A promotion on a reversed row: the lag written into (series, target) must be
// the NEGATION of the consensus lag, or the series is dated the wrong way. The
// sample here is the master from ring 61 on, with a false ring every 25 rings,
// so it drifts away from any single whole-series lag while its early segments
// still date at the true placement.
const drift = (function () {
  const N = 400, S = [];
  for (let i = 0; i < N; i++) {
    S.push(1 + 0.5 * Math.sin(i / 3.7) + 0.3 * Math.sin(i / 11.3) + 0.2 * Math.sin(i / 29) + (i % 7) * 0.02);
  }
  const samp = [];
  for (let i = 60, k = 0; i < N; i++, k++) {
    samp.push(S[i]);
    if (k > 0 && k % 25 === 0) samp.push(S[i] * 0.55);
  }
  const noisy = S.map(function (v, i) { return v * (1 + 0.06 * Math.sin(i / 5.1)); });
  const rows = Math.max(N, samp.length);
  const p = function (v) { return v.concat(new Array(rows - v.length).fill(null)); };
  return {
    names: ['ring', 'aa_sample', 'MASTER', 'zz_extra'],
    cols: [Array.from({ length: rows }, function (_, i) { return i + 1; }), p(samp), p(S), p(noisy)]
  };
})();
const drRes = AppCore.runAnalysis({
  mode: 1, undated: drift, detrend: {},
  leadlag: { neg_lag: -100, pos_lag: 100, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: 'MASTER' },
  segLen: 60, keepN: 5
});
const drC = drRes.consensus.bySeries.aa_sample;
ok('a drifting series is promoted over a wrong whole-series lag',
  !!drC && drC.action === 'promoted' && drC.tier === 'strong' &&
  Math.abs(drC.lag - 60) <= 2 && Math.abs(drC.engineLag - drC.lag) > AppCore.CONSENSUS.tol,
  drC ? drC.action + ' lag ' + drC.lag + ' vs engine ' + drC.engineLag : 'none');
const drRow = (function () {
  for (let r = 0; r < drRes.crossDatRes.cols[0].length; r++) {
    if (drRes.crossDatRes.cols[0][r] === 'aa_sample' && drRes.crossDatRes.cols[1][r] === 'MASTER') return r;
  }
  return -1;
})();
ok('the reversed row carries the NEGATED consensus lag, engine best 2nd',
  drRow >= 0 && Number(drRes.crossDatRes.cols[5][drRow]) === -drC.lag &&
  Number(drRes.crossDatRes.cols[9][drRow]) === -drC.engineLag,
  drRow >= 0 ? '1st ' + drRes.crossDatRes.cols[5][drRow] + ', 2nd ' + drRes.crossDatRes.cols[9][drRow] +
    ' (consensus ' + drC.lag + ', engine ' + drC.engineLag + ')' : 'row missing');
ok('...and the promoted series is aligned at the consensus placement',
  (function () {
    const f = function (n) { return drRes.aligned.cols[drRes.aligned.names.indexOf(n)].findIndex(function (v) { return v != null; }); };
    return drRes.aligned.names.indexOf('aa_sample') >= 0 && f('aa_sample') - f('MASTER') === drC.lag;
  })(),
  drRes.aligned.names.join(','));

// With the Segments tool on, the pairwise run still ends with the same pass —
// its own segment rows are (segment, series) placements and cannot be reused.
const pwSegRes = AppCore.runAnalysis({
  mode: 1, undated: pwFrame, detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: 'c_clean' },
  segLen: 60, keepN: 3, segTool: true
});
ok('the Segments tool does not cost the pairwise run its consensus',
  !!(pwSegRes.consensus && pwSegRes.consensus.counts) &&
  Object.keys(pwSegRes.consensus.bySeries).indexOf('c_clean') < 0 &&
  !!pwSegRes.consensus.bySeries.a_broken,
  pwSegRes.consensus ? Object.keys(pwSegRes.consensus.bySeries).join(',') : 'missing');

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
