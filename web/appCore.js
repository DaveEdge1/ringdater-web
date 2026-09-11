/* ============================================================================
 * appCore.js — all the NON-DOM logic of the RingdateR web frontend, factored out
 * so it can be unit-tested in Node (test/frontend_test.js) with no browser.
 *
 * It is a thin, framework-agnostic wrapper around the ringdater-js engine
 * (window.RD, from ringdater.bundle.js): it loads data, runs the pairwise /
 * chronology workflows, shapes the 17-column crossDatRes table, builds the plot
 * specs, renders SVG, and produces the download descriptors + HTML report.
 *
 * UMD: in the browser it reads window.RD and publishes window.AppCore; in Node it
 * require()s ./ringdater.bundle.js and exports the same factory result.
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var RD = require('./ringdater.bundle.js').RD;
    module.exports = factory(RD);
  } else {
    root.AppCore = factory(root.RD);
  }
})(typeof self !== 'undefined' ? self : this, function (RD) {
  'use strict';

  if (!RD) throw new Error('appCore: window.RD (ringdater.bundle.js) is not loaded.');

  // ---- static option tables (mirror ui_function.R controls) ----------------
  // detrending_select 1..7 — labels straight from report.js detMethod().
  var DETREND_METHODS = [
    { value: 1, label: 'No detrending' },
    { value: 2, label: 'Convert to z-scores' },
    { value: 3, label: 'Spline (uses window)' },
    { value: 4, label: 'Modified negative exponential' },
    { value: 5, label: 'Friedman' },
    { value: 6, label: 'Modified Hugershoff' },
    { value: 7, label: 'First difference' }
  ];
  var COLOR_SCALES = [
    { value: 1, label: 'Blue-Grey-Red' },
    { value: 2, label: 'Grey-Red' },
    { value: 3, label: 'Grey-Blue' },
    { value: 4, label: 'White-Black' }
  ];
  // dependency-free upload formats fully supported in the browser bundle.
  var SUPPORTED_EXT = ['csv', 'txt', 'rwl', 'crn', 'pos', 'lps', 'xml'];

  function ext(name) {
    var s = String(name || '');
    var dot = s.lastIndexOf('.');
    return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
  }
  function isXlsx(name) { return ext(name) === 'xlsx' || ext(name) === 'xls'; }
  function isTridas(name) { return ext(name) === 'xml'; }
  function isSupportedUpload(name) { return SUPPORTED_EXT.indexOf(ext(name)) >= 0; }

  // ---- loading -------------------------------------------------------------
  // files: array of { name, text } descriptors (already read as text by the host).
  function loadUndated(files) {
    if (!Array.isArray(files)) files = [files];
    return RD.loadUndated(files);
  }
  function loadChron(file) { return RD.loadChron(file); }

  // Column-bind two undated (increment-axis) frames, aligning by ring index and
  // resetting the ring column to 1..nrow.
  function bindUndated(a, b) {
    if (!a) return b;
    if (!b) return a;
    var merged = RD.combNA(a, { names: b.names.slice(1), cols: b.cols.slice(1) });
    var nr = merged.cols[0].length, ring = [];
    for (var i = 0; i < nr; i++) ring.push(i + 1);
    merged.cols[0] = ring; merged.names[0] = 'ring';
    return merged;
  }
  // Merge two dated frames on the UNION of their (contiguous) internal-year axes.
  function bindDated(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ya = a.cols[0], yb = b.cols[0];
    var min = Math.min(ya[0], yb[0]), max = Math.max(ya[ya.length - 1], yb[yb.length - 1]);
    var years = []; for (var y = min; y <= max; y++) years.push(y);
    function place(frame) {
      var out = [], fy = frame.cols[0];
      for (var c = 1; c < frame.cols.length; c++) {
        var col = new Array(years.length).fill(null);
        for (var i = 0; i < fy.length; i++) col[fy[i] - min] = frame.cols[c][i];
        out.push(col);
      }
      return out;
    }
    return {
      names: ['years'].concat(a.names.slice(1)).concat(b.names.slice(1)),
      cols: [years].concat(place(a)).concat(place(b))
    };
  }

  // Ingest one or more TRiDaS .xml descriptors, auto-routing by content:
  // undated measurementSeries -> pool, derivedSeries / absolutely-dated -> chron.
  // Returns { undated, chron, meta, links } (frames may be null).
  function loadTridas(files) {
    if (!Array.isArray(files)) files = [files];
    var undated = null, chron = null, meta = {}, links = {}, anyAbsolute = false;
    files.forEach(function (f) {
      var r = RD.readTridas(f.text);
      undated = bindUndated(undated, r.undated);
      chron = bindDated(chron, r.chron);
      Object.assign(meta, r.meta);
      Object.assign(links, r.links || {});
      if (r.dating && r.dating.anyAbsolute) anyAbsolute = true;
    });
    var dating = chron ? { anyAbsolute: anyAbsolute, firstYearInternal: chron.cols[0][0] } : null;
    return { undated: undated, chron: chron, meta: meta, links: links, dating: dating };
  }

  function seriesNames(frame) {
    return frame && frame.names ? frame.names.slice(1) : [];
  }

  // ---- sliding-window segmentation -----------------------------------------
  // "All possible segments": every segLen-ring window of every series is scored
  // against the other COMPLETE series (or the mean chronology) via
  // runningLeadLag grids — one grid per pair covers every (window, lag) cell —
  // then only the best `keepN` windows per series are kept. Adjacent windows
  // share almost all their rings, so winners are diversity-suppressed: a
  // window is skipped when it overlaps an already-kept window of the same
  // series by 50% or more. Kept windows are named "series@a-b" (rings a..b,
  // 1-based) and enter the standard crossdating pipeline as extra series.
  var bad = function (v) { return v == null || (typeof v === 'number' && isNaN(v)); };
  function oddWin(segLen) {
    var L = Math.floor(Number(segLen));
    if (!isFinite(L) || L < 20) throw new Error('Segment length must be at least 20 years.');
    return L % 2 ? L : L + 1;                     // runningLeadLag forces odd windows
  }
  var SEG_NAME = /@\d+-\d+$/;                  // "series@a-b" — a kept window
  function firstRowOf(frame, name) {
    var col = frame.cols[frame.names.indexOf(name)];
    for (var i = 0; i < col.length; i++) if (!bad(col[i])) return i;
    return -1;
  }
  // Fold one runningLeadLag grid into `best`: per series, per window start row,
  // remember only the highest r (and which comparator produced it). A cell at
  // (year y0, lag L) is the window of s2 starting at axis row rowOf[y0-h-L]
  // AND the window of s1 starting at rowOf[y0-h] (verified vs direct cor).
  function foldGrid(best, grid, rowOf, s1, s2, win) {
    if (!grid) return;
    var h = (win - 1) / 2;
    var Y = grid.cols[0], L = grid.cols[1], R = grid.cols[2];
    for (var i = 0; i < Y.length; i++) {
      var r = R[i];
      if (bad(r) || bad(Y[i])) continue;
      var y0 = Number(Y[i]), lg = Number(L[i]);
      if (s2) {
        var rowB = rowOf[y0 - h - lg];
        if (rowB != null && (best[s2][rowB] == null || r > best[s2][rowB].r)) best[s2][rowB] = { r: r, comp: s1 };
      }
      if (s1 && best[s1]) {
        var rowA = rowOf[y0 - h];
        if (rowA != null && (best[s1][rowA] == null || r > best[s1][rowA].r)) best[s1][rowA] = { r: r, comp: s2 };
      }
    }
  }
  // best-per-startRow maps -> per-series kept windows (rank by r, suppress
  // >=50% overlap, cap keepN).
  function pickWindows(best, frame, names, win, keepN) {
    var out = {};
    names.forEach(function (s) {
      var entries = Object.keys(best[s] || {}).map(function (k) {
        return { startRow: Number(k), r: best[s][k].r, comp: best[s][k].comp };
      });
      entries.sort(function (a, b) { return b.r - a.r; });
      var kept = [];
      for (var i = 0; i < entries.length && kept.length < keepN; i++) {
        var e = entries[i];
        var clash = kept.some(function (k) { return Math.abs(k.startRow - e.startRow) < win / 2; });
        if (clash) continue;
        var f0 = firstRowOf(frame, s);
        var a = e.startRow - f0 + 1;
        kept.push({
          series: s, name: s + '@' + a + '-' + (a + win - 1),
          startRow: e.startRow, ringStart: a, ringEnd: a + win - 1,
          r: e.r, comp: e.comp
        });
      }
      kept.sort(function (a, b) { return a.startRow - b.startRow; });
      out[s] = kept;
    });
    return out;
  }
  function rowIndex(frame) {
    var rowOf = {};
    frame.cols[0].forEach(function (v, i) { if (!bad(v)) rowOf[Number(v)] = i; });
    return rowOf;
  }
  // Selection state + one-grid step, so the stepwise analysis runner can score
  // a single runningLeadLag grid per tick. foldGrid only records orientations
  // whose series exist in st.best — so the same step serves pairwise grids
  // (both sides kept) and vs-reference grids (the reference, absent from
  // st.best, is never segmented).
  function slidingSelectStart(frame, names) {
    var best = {}; names.forEach(function (n) { best[n] = {}; });
    return { best: best, rowOf: rowIndex(frame) };
  }
  function slidingSelectGridStep(st, frame, s1, s2, win) {
    var grid = safe(function () {
      return RD.runningLeadLag(frame, { s1: s1, s2: s2, win: win, complete: true });
    });
    foldGrid(st.best, grid, st.rowOf, s1, s2, win);
  }
  // Pairwise selection: one grid per unordered pair of complete series serves
  // windows of BOTH. detFrame = detrended wholes.
  function slidingSelectPairwise(detFrame, win, keepN) {
    var names = seriesNames(detFrame);
    var st = slidingSelectStart(detFrame, names);
    for (var i = 0; i < names.length; i++) {
      for (var j = i + 1; j < names.length; j++) slidingSelectGridStep(st, detFrame, names[i], names[j], win);
    }
    return pickWindows(st.best, detFrame, names, win, keepN);
  }
  // Chronology-mode selection: windows of each series vs the reference column.
  function slidingSelectVsReference(frame, names, refName, win, keepN) {
    var st = slidingSelectStart(frame, names);
    names.forEach(function (s) { slidingSelectGridStep(st, frame, refName, s, win); });
    return pickWindows(st.best, frame, names, win, keepN);
  }

  // slice rings startRow..startRow+win-1 of column `name`, re-based to row 0,
  // padded to `nrow`.
  function windowColumn(frame, name, startRow, win, nrow) {
    var col = frame.cols[frame.names.indexOf(name)];
    var out = new Array(nrow).fill(null);
    for (var k = 0; k < win && startRow + k < col.length; k++) out[k] = col[startRow + k];
    return out;
  }
  function concatCrossDat(parts) {
    var out = { names: parts[0].names.slice(), cols: parts[0].names.map(function () { return []; }) };
    parts.forEach(function (p) {
      for (var c = 0; c < out.cols.length; c++) out.cols[c] = out.cols[c].concat(p.cols[c]);
    });
    return out;
  }
  function diagOn(aligned, probWind, rbarWindow) {
    var out = {};
    try { out.probCheck = RD.probCheck(aligned, { wind: probWind }); }
    catch (e) { out.probCheck = { error: e && e.message ? e.message : String(e) }; }
    try { out.rBarEps = RD.rBarEps(aligned, { window: rbarWindow }); }
    catch (e2) { out.rBarEps = { error: e2 && e2.message ? e2.message : String(e2) }; }
    return out;
  }

  // Full sliding-segment analysis — same opts as runAnalysis plus
  // { segLen, keepN }. Segments are windows of the DETRENDED whole series
  // (slices, not re-detrended), so their scores match the selection grids.
  // Mode 1: each kept segment gets its own leadLag run vs the other complete
  // series (mode-2 leadLag with the segment as master), stitched ahead of the
  // standard whole-vs-whole pairwise run — so segment blocks lead the table
  // and segments are valid filter targets. Mode 2: one chronology run whose
  // comparison frame carries wholes + kept segments.
  // The result bundle is shaped exactly like runAnalysis output, with
  // `segments` (kept-window metadata per series) riding on it.
  function slidingSegmentAnalysis(opts) {
    var r = analysisRunner(Object.assign({}, opts, { segTool: true }));
    while (!r.step());
    return r.result();
  }

  // ---- stepwise analysis runner ---------------------------------------------
  // One runner for all four run shapes (pairwise / chronology × segments
  // on/off). Each step is a chunk of comparable cost — an engine workflow, one
  // runningLeadLag grid, one segment crossdate — so a host can drive step()
  // from a timeout loop and let a progress bar paint between chunks (the same
  // batched pattern as ringTest). runAnalysis and slidingSegmentAnalysis run
  // the runner to completion and stay synchronous.
  // API: total() (may grow mid-run — mode-1 segment steps are only known after
  // selection), progress(), label() (the NEXT step), done(), step() -> done,
  // result().
  function analysisRunner(opts) {
    var segTool = !!opts.segTool;
    var mode = Number(opts.mode) === 2 ? 2 : 1;
    var undated = opts.undated;
    if (!undated) throw new Error('No undated data loaded.');
    if (mode === 2 && !opts.chron) throw new Error('Chronology mode needs a loaded chronology.');
    var names = seriesNames(undated);
    // Detrending a series that is already an index degrades it, so series that
    // are already indices are detected and carried through un-detrended
    // (opts.autoSkip === false turns the detection off). Separately, the
    // chronology can be given its own detrend settings via opts.detrendChron —
    // "detrend the pool but not the chronology" is the ordinary case of a .crn
    // read against raw measurements, and is a user decision, not an inference.
    var autoOn = opts.autoSkip !== false;
    var willDetrend = function (o) { return detrendOptions(o).detrending_select !== 1; };
    var skipU = (autoOn && willDetrend(opts.detrend))
      ? detectDetrended(undated, opts.undatedName) : NO_SKIP;
    var skipC = (autoOn && mode === 2 && !opts.chronIsDetrended &&
      willDetrend(opts.detrendChron || opts.detrend))
      ? detectDetrended(opts.chron, opts.chronName) : NO_SKIP;
    var detOpt = detrendOptions(opts.detrend, skipU.names);
    var detChronOpt = detrendOptions(opts.detrendChron || opts.detrend, skipC.names);
    // Reported to the user: what was skipped, and on what evidence.
    var skipInfo = { undated: skipU, chron: skipC, chronOpts: detChronOpt, auto: autoOn };
    var leadlag = opts.leadlag || { neg_lag: -20, pos_lag: 20, complete: true };
    var filter = Object.assign({ r_val: 0.5, p_val: 0.05, overlap: 50 }, opts.filter || {});
    var probWind = opts.probWind != null ? opts.probWind : 20;
    var rbarWindow = opts.rbarWindow != null ? opts.rbarWindow : 25;
    var keepN = Math.max(1, Math.floor(Number(opts.keepN) || 5));
    var target2 = filter.target || 'mean_chronology';
    // The RAW chronology behind the run, kept so exports can be written in ring
    // widths rather than in the indices the crossdate is computed on. A
    // composite of chronologies arrives already detrended and has no raw form.
    var chronRaw = (mode === 2 && !opts.chronIsDetrended) ? (opts.chron || null) : null;
    var target1 = filter.target || names[0];
    // The background consensus pass is best-effort: an unusable segment length
    // only aborts the run when the Segments tool itself asked for it.
    var win = null;
    try { win = oddWin(opts.segLen != null ? opts.segLen : 60); }
    catch (e) { if (segTool) throw e; }

    var ctx = {};
    var steps = [];

    if (mode === 2 && !segTool) {
      steps.push({ label: 'Crossdating vs chronology', fn: function () {
        var result = RD.chronologyWorkflow({
          undated: undated, chron: opts.chron, detrend: detOpt,
          leadlag: leadlag,
          filter: Object.assign({}, filter, { target: target2 }),
          probWind: probWind, rbarWindow: rbarWindow,
          detrendChron: detChronOpt,
          chronIsDetrended: !!opts.chronIsDetrended
        });
        result.target = target2;
        result.mode = mode; result.undated = undated; result.chronRaw = chronRaw;
        result.detrendOpts = detOpt; result.detrendSkipped = skipInfo; result.chronName = opts.chronName || null;
        ctx.result = result;
        if (win) ctx.selState = slidingSelectStart(result.chronNSeries, names);
      } });
      if (win) {
        names.forEach(function (s) {
          steps.push({ label: 'Scanning segments of ' + s, fn: function () {
            slidingSelectGridStep(ctx.selState, ctx.result.chronNSeries, target2, s, win);
          } });
        });
        // segment-consensus ranking rides on every chronology run (see the
        // CONSENSUS block above). safe(): a failed consensus pass must never
        // break the primary analysis.
        steps.push({ label: 'Segment consensus', fn: function () {
          var result = ctx.result;
          result.consensus = safe(function () {
            var sel = pickWindows(ctx.selState.best, result.chronNSeries, names, win, keepN);
            var cons = consensusFinish(result, names, sel, win, keepN);
            cons.counts = applyConsensus(result, cons.bySeries,
              Object.assign({}, filter, { target: target2 }), probWind, rbarWindow);
            return cons;
          });
        } });
      }
    } else if (mode === 1 && !segTool) {
      // Pairwise mode has no mean chronology to date against, so the run's
      // TARGET series takes that part — it is the series the filter, the
      // alignment and the table are already organised around. Only segments of
      // the others, only against the target: every pair would be a grid per
      // pair, and a consensus vs a series nobody is dating against says nothing.
      var consNames = names.filter(function (n) { return n !== target1; });
      steps.push({ label: 'Pairwise crossdating', fn: function () {
        var result = RD.pairwiseWorkflow({
          undated: undated, detrend: detOpt,
          leadlag: leadlag,
          filter: Object.assign({}, filter, { target: target1 }),
          probWind: probWind, rbarWindow: rbarWindow
        });
        result.target = target1;
        result.mode = mode; result.undated = undated; result.chronRaw = chronRaw;
        result.detrendOpts = detOpt; result.detrendSkipped = skipInfo; result.chronName = opts.chronName || null;
        ctx.result = result;
        if (win && consNames.length) ctx.selState = slidingSelectStart(result.detrended, consNames);
      } });
      if (win && consNames.length) {
        consNames.forEach(function (s) {
          steps.push({ label: 'Scanning segments of ' + s, fn: function () {
            slidingSelectGridStep(ctx.selState, ctx.result.detrended, target1, s, win);
          } });
        });
        steps.push({ label: 'Segment consensus', fn: function () {
          var result = ctx.result;
          result.consensus = safe(function () {
            var sel = pickWindows(ctx.selState.best, result.detrended, consNames, win, keepN);
            var cons = consensusFinish(result, consNames, sel, win, keepN);
            cons.counts = applyConsensus(result, cons.bySeries,
              Object.assign({}, filter, { target: target1 }), probWind, rbarWindow);
            return cons;
          });
        } });
      }
    } else if (mode === 2) {
      // Segments tool, chronology mode. Segments are windows of the DETRENDED
      // whole series (slices, not re-detrended), so their scores match the
      // selection grids; one chronology run whose comparison frame carries
      // wholes + kept segments.
      var segMeta = function (result) {
        result.mode = mode;
        result.undated = result.rawCombined;
        result.chronRaw = chronRaw;
        result.detrendOpts = detOpt; result.detrendSkipped = skipInfo;
        result.chronName = opts.chronName || null;
        result.segLength = win;
        result.keepN = keepN;
        ctx.result = result;
      };
      steps.push({ label: 'Detrending', fn: function () {
        ctx.det = RD.normalise(undated, detOpt);
        ctx.chronDetrended = opts.chronIsDetrended ? opts.chron : RD.normalise(opts.chron, detChronOpt);
        var chronoMean = RD.meanChronology(ctx.chronDetrended, target2);
        // wholes-only comparison frame for window selection
        ctx.baseFrame = RD.combNA(chronoMean, { names: ctx.det.names.slice(1), cols: ctx.det.cols.slice(1) });
        ctx.baseFrame.names = ['year', target2].concat(ctx.det.names.slice(1));
        ctx.selState = slidingSelectStart(ctx.baseFrame, names);
      } });
      names.forEach(function (s) {
        steps.push({ label: 'Scanning segments of ' + s, fn: function () {
          slidingSelectGridStep(ctx.selState, ctx.baseFrame, target2, s, win);
        } });
      });
      steps.push({ label: 'Crossdating wholes + segments', fn: function () {
        var baseFrame = ctx.baseFrame;
        var sel2 = pickWindows(ctx.selState.best, baseFrame, names, win, keepN);
        // comparison frame with each series' kept segments right after it
        var cn = { names: baseFrame.names.slice(0, 2), cols: [baseFrame.cols[0], baseFrame.cols[1]] };
        var nrow2 = baseFrame.cols[0].length;
        names.forEach(function (s) {
          cn.names.push(s); cn.cols.push(baseFrame.cols[baseFrame.names.indexOf(s)]);
          (sel2[s] || []).forEach(function (w) {
            cn.names.push(w.name);
            cn.cols.push(windowColumn(baseFrame, s, w.startRow, win, nrow2));
          });
        });
        // raw wholes + raw segment slices (skeleton plots need raw ring widths)
        var rawC2 = { names: undated.names.slice(), cols: undated.cols.slice() };
        names.forEach(function (s) {
          (sel2[s] || []).forEach(function (w) {
            // startRow is on the chron-frame axis; undated series sit at rows 0..
            // there, matching their rows in the raw frame.
            rawC2.names.push(w.name);
            rawC2.cols.push(windowColumn(undated, s, w.startRow, win, undated.cols[0].length));
          });
        });
        ctx.sel2 = sel2; ctx.cn = cn; ctx.rawC2 = rawC2;
        ctx.ll2 = RD.leadLag(cn, { mode: 2, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete });
      } });
      steps.push({ label: 'Aligning + segment consensus', fn: function () {
        var filtered2 = RD.filterCrossdates(ctx.ll2.crossDatRes, Object.assign({}, filter, { target: target2 }));
        var alignedSeries = RD.alignSeries(ctx.cn, filtered2, target2);
        var aligned2 = RD.alignToChron(alignedSeries, ctx.chronDetrended);
        var result = Object.assign({
          detrended: ctx.det, chronDetrended: ctx.chronDetrended, chronNSeries: ctx.cn,
          crossDatRes: ctx.ll2.crossDatRes, masterLeadLag: ctx.ll2.masterLeadLag,
          filtered: filtered2, alignedSeries: alignedSeries, aligned: aligned2,
          target: target2, segments: ctx.sel2
        }, diagOn(aligned2, probWind, rbarWindow));
        result.rawCombined = ctx.rawC2;
        // consensus from the segment rows this run already computed
        result.consensus = safe(function () {
          var cons = { segments: ctx.sel2, segLength: win, keepN: keepN, bySeries: consensusFromRows(ctx.ll2.crossDatRes, ctx.sel2, target2) };
          cons.counts = applyConsensus(result, cons.bySeries,
            Object.assign({}, filter, { target: target2 }), probWind, rbarWindow);
          return cons;
        });
        segMeta(result);
      } });
    } else {
      // Segments tool, pairwise mode: each kept segment gets its own leadLag
      // run vs the other complete series (mode-2 leadLag with the segment as
      // master), stitched ahead of the standard whole-vs-whole pairwise run —
      // so segment blocks lead the table and segments are valid filter targets.
      var segMeta1 = function (result) {
        result.mode = mode;
        result.undated = result.rawCombined;
        result.chronRaw = chronRaw;
        result.detrendOpts = detOpt; result.detrendSkipped = skipInfo;
        result.chronName = opts.chronName || null;
        result.segLength = win;
        result.keepN = keepN;
        ctx.result = result;
      };
      steps.push({ label: 'Detrending', fn: function () {
        ctx.det = RD.normalise(undated, detOpt);
        ctx.selState = slidingSelectStart(ctx.det, names);
      } });
      for (var pi = 0; pi < names.length; pi++) {
        for (var pj = pi + 1; pj < names.length; pj++) {
          (function (a, b) {
            steps.push({ label: 'Scanning segments: ' + a + ' vs ' + b, fn: function () {
              slidingSelectGridStep(ctx.selState, ctx.det, a, b, win);
            } });
          })(names[pi], names[pj]);
        }
      }
      steps.push({ label: 'Selecting segments', fn: function () {
        var det = ctx.det;
        var sel1 = pickWindows(ctx.selState.best, det, names, win, keepN);
        var segs = [];
        names.forEach(function (s) { (sel1[s] || []).forEach(function (w) { segs.push(w); }); });
        var nrow1 = det.cols[0].length;
        // combined frames (segments first, wholes after; segments re-based to row 0)
        var detC = { names: [det.names[0]], cols: [det.cols[0]] };
        var rawC = { names: [undated.names[0]], cols: [undated.cols[0]] };
        segs.forEach(function (w) {
          detC.names.push(w.name); detC.cols.push(windowColumn(det, w.series, w.startRow, win, nrow1));
          rawC.names.push(w.name); rawC.cols.push(windowColumn(undated, w.series, w.startRow, win, undated.cols[0].length));
        });
        names.forEach(function (s) {
          detC.names.push(s); detC.cols.push(det.cols[det.names.indexOf(s)]);
          rawC.names.push(s); rawC.cols.push(undated.cols[undated.names.indexOf(s)]);
        });
        ctx.sel1 = sel1; ctx.detC = detC; ctx.rawC = rawC;
        ctx.crossParts = []; ctx.masterParts = [];
        // one crossdating step per kept segment (count known only now)
        segs.forEach(function (w) {
          steps.push({ label: 'Crossdating segment ' + w.name, fn: function () {
            var f = { names: [ctx.det.names[0], w.name], cols: [ctx.det.cols[0], ctx.detC.cols[ctx.detC.names.indexOf(w.name)]] };
            names.forEach(function (s) {
              if (s === w.series) return;
              f.names.push(s); f.cols.push(ctx.det.cols[ctx.det.names.indexOf(s)]);
            });
            var ll = RD.leadLag(f, { mode: 2, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete });
            ctx.crossParts.push(ll.crossDatRes); ctx.masterParts.push(ll.masterLeadLag);
          } });
        });
        steps.push({ label: 'Pairwise crossdating', fn: function () {
          var llW = RD.leadLag(ctx.det, { mode: 1, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete });
          ctx.crossParts.push(llW.crossDatRes); ctx.masterParts.push(llW.masterLeadLag);
        } });
        steps.push({ label: 'Aligning', fn: function () {
          var crossDatRes = concatCrossDat(ctx.crossParts);
          var masterLeadLag = ctx.masterParts.reduce(function (a, b) { return RD.combNA(a, b); });
          var filtered1 = RD.filterCrossdates(crossDatRes, Object.assign({}, filter, { target: target1 }));
          var aligned1 = RD.alignSeries(ctx.detC, filtered1, target1);
          var result = Object.assign({
            detrended: ctx.detC, crossDatRes: crossDatRes, masterLeadLag: masterLeadLag,
            filtered: filtered1, aligned: aligned1,
            target: target1, segments: ctx.sel1
          }, diagOn(aligned1, probWind, rbarWindow));
          result.rawCombined = ctx.rawC;
          segMeta1(result);
        } });
        // Same consensus pass as a plain pairwise run: the segments this branch
        // already picked, read against the target series. The rows it computed
        // cannot be reused — each segment was crossdated AS the master, so they
        // carry (segment, series) placements — so this is one more leadLag over
        // a segments-vs-target frame, exactly as the background pass does.
        steps.push({ label: 'Segment consensus', fn: function () {
          var result = ctx.result;
          if (SEG_NAME.test(String(target1))) return;    // a 60-ring master dates nothing
          result.consensus = safe(function () {
            var cn = names.filter(function (n) { return n !== target1; });
            var sel = {};
            cn.forEach(function (s) { sel[s] = (ctx.sel1 && ctx.sel1[s]) || []; });
            var cons = consensusFinish(result, cn, sel, win, keepN);
            cons.counts = applyConsensus(result, cons.bySeries,
              Object.assign({}, filter, { target: target1 }), probWind, rbarWindow);
            return cons;
          });
        } });
      } });
    }

    var i = 0;
    return {
      total: function () { return steps.length; },
      progress: function () { return i; },
      label: function () { return i < steps.length ? steps[i].label : ''; },
      done: function () { return i >= steps.length; },
      step: function () {
        if (i < steps.length) { steps[i].fn(); i++; }
        return i >= steps.length;
      },
      result: function () { return ctx.result; }
    };
  }

  // ---- segment placement diagnosis -----------------------------------------
  // Convert several kept segments of ONE series into the date each placement
  // implies for RING 1 of the source series (dated start minus rings before
  // the segment) — for the best lag and the 2nd/3rd-best lags. A sound series
  // implies the same ring-1 date everywhere; the offsets between neighbouring
  // segments are the missing/false-ring counts. No thresholds or verdicts are
  // applied — the numbers and the placement plot are the diagnosis.
  //
  // All placements are expressed on the reference's own (unshifted) axis, so
  // they are directly comparable:
  //   mode 2 rows (ref, seg):  seg is the shifted series -> First_ring is its
  //     dated start on the chronology axis; alt lags shift it by (lag - bestLag).
  //   mode 1 rows (seg, ref):  the reference is the shifted series, so the
  //     segment (at axis row 0) sits at (axis0 - lag) on the ref's axis.
  //   whole-series context row: at f(series) - lag or f(series) + lag
  //     depending on row orientation (f = axis year of the series' first ring).
  function segRowFor(cd, s1, s2) {
    for (var r = 0; r < cd.cols[0].length; r++) {
      if (cd.cols[0][r] === s1 && cd.cols[1][r] === s2) return r;
    }
    return -1;
  }
  // best-3 (lag, r, p, overlap) tuples from one crossDatRes row.
  function rowLags(cd, r) {
    var take = function (li, ri, pi, oi, rank) {
      var lag = cd.cols[li][r];
      if (bad(lag)) return null;
      return { rank: rank, lag: Number(lag), r: cd.cols[ri][r], p: cd.cols[pi][r], overlap: cd.cols[oi][r] };
    };
    return [take(5, 6, 7, 8, 1), take(9, 10, 11, 12, 2), take(13, 14, 15, 16, 3)].filter(Boolean);
  }
  function diagnoseSegments(result, segNames, refName) {
    var mode = Number(result.mode) === 2 ? 2 : 1;
    var cd = result.crossDatRes;
    if (mode === 2) refName = refName || result.target || 'mean_chronology';
    if (!refName) throw new Error('Diagnosis needs a reference series.');
    var det = mode === 2 ? result.chronNSeries : result.detrended;
    var axis0 = Number(det.cols[0][0]);
    var fOf = function (name) {                    // axis year of a column's first ring
      var i = firstRowOf(det, name);
      return i < 0 ? null : Number(det.cols[0][i]);
    };

    // resolve segment metadata + placements
    var series = null;
    var entries = [];
    segNames.forEach(function (segName) {
      var m = /^(.*)@(\d+)-(\d+)$/.exec(String(segName));
      if (!m) throw new Error(segName + ' is not a segment.');
      if (series == null) series = m[1];
      else if (series !== m[1]) throw new Error('Diagnosis needs segments of ONE series (' + series + ' vs ' + m[1] + ').');
      var ringStart = Number(m[2]), ringEnd = Number(m[3]);
      var row = mode === 2 ? segRowFor(cd, refName, segName) : segRowFor(cd, segName, refName);
      if (row < 0) return;                         // no placement vs this reference
      var lags = rowLags(cd, row);
      if (!lags.length) return;
      var best = lags[0];
      var datedStartAt = function (lag) {
        if (mode === 2) return Number(cd.cols[2][row]) + (lag - best.lag);   // First_ring shifted to alt lag
        return axis0 - lag;
      };
      var placements = lags.map(function (L) {
        var ds = datedStartAt(L.lag);
        return Object.assign({}, L, { datedStart: ds, placement: ds - (ringStart - 1) });
      });
      entries.push({
        name: segName, ringStart: ringStart, ringEnd: ringEnd,
        datedStart: placements[0].datedStart,
        datedEnd: placements[0].datedStart + (ringEnd - ringStart),
        r: best.r, p: best.p, overlap: best.overlap, lag: best.lag,
        placement: placements[0].placement,
        alts: placements.slice(1)
      });
    });
    if (entries.length < 2) throw new Error('Need at least two placed segments of one series (vs ' + refName + ').');
    entries.sort(function (a, b) { return a.ringStart - b.ringStart; });

    // whole-series context placement, when the run has a row for it
    var whole = null;
    var rowWR = segRowFor(cd, series, refName), rowRW = segRowFor(cd, refName, series);
    if (mode === 2 && rowRW >= 0) {
      var lw = rowLags(cd, rowRW);
      if (lw.length) whole = { placement: Number(cd.cols[2][rowRW]), lag: lw[0].lag, r: lw[0].r, p: lw[0].p, overlap: lw[0].overlap };
    } else if (mode === 1) {
      var f = fOf(series);
      if (rowWR >= 0) { var l1 = rowLags(cd, rowWR); if (l1.length && f != null) whole = { placement: f - l1[0].lag, lag: l1[0].lag, r: l1[0].r, p: l1[0].p, overlap: l1[0].overlap }; }
      else if (rowRW >= 0) { var l2 = rowLags(cd, rowRW); if (l2.length && f != null) whole = { placement: f + l2[0].lag, lag: l2[0].lag, r: l2[0].r, p: l2[0].p, overlap: l2[0].overlap }; }
    }

    // offset of each placement from the previous segment (in ring order) —
    // the raw missing(+)/false(-) ring count between neighbours.
    entries.forEach(function (e, i) {
      e.dPrev = i ? e.placement - entries[i - 1].placement : null;
    });

    return {
      series: series, reference: refName, mode: mode,
      entries: entries, whole: whole,
      plot: segmentPlacementSpec(series, refName, mode, entries, whole)
    };
  }

  // ---- segment-consensus lag ranking (chronology mode) ----------------------
  // The whole-series best-3 lags rank full-series correlations, which a single
  // missing or false ring dilutes at EVERY lag — the true dating then hides
  // behind an unimpressive r/p while the "best" lag is noise. Kept segments are
  // immune: each dates on its own, and independent segments that agree on the
  // whole-series lag they imply are very unlikely to do so by chance — per-lag
  // p-values arrive Bonferroni-corrected across the whole lag range, and a
  // second segment landing within ±tol of the first is a ~(2·tol+1)/lag-range
  // event even before the p gate.
  //
  // Every mode-2 run therefore runs the sliding-window segmentation in the
  // background, projects each kept segment's best-3 placements onto the
  // whole-series lag each implies (segment lag − startRow), clusters them by
  // chained ±tol agreement (successive segments drift as missing/false rings
  // accumulate), and tiers the winning cluster per series:
  //   strong     ≥3 supporting segments, or ≥2 with min p ≤ strongP
  //   tentative  ≥2 supporting segments at p ≤ pGate
  // A STRONG consensus that disagrees with the engine's best lag is promoted
  // into the displayed First_* slot (whole-series stats at that lag; the engine
  // ranking shifts down) and the series joins the aligned output at the
  // consensus lag — the cluster's earliest segment sets the lag, since ring 1
  // predates any later missing/false ring. A consensus matching the engine
  // confirms it; a tentative one is only flagged. The engine's own crossDatRes
  // is never mutated — promotion happens on a copy in this app layer, keeping
  // the R-parity contract intact.
  var CONSENSUS = {
    pGate: 0.05,     // corrected-p gate for a segment placement to count
    tol: 5,          // implied-lag agreement tolerance between segments
    strongP: 1e-6    // 2 segments at/below this = strong (≥3 segments always strong)
  };

  // Whole-series stats at an arbitrary lag, from the run's masterLeadLag grid.
  // Returns null when the pair or the lag is outside the computed range.
  function statsAtLag(master, s1, s2, lag) {
    var pre = 'ser_1_' + s1 + '_ser_2_' + s2 + '_';
    var iL = master.names.indexOf(pre + 'lag');
    if (iL < 0) return null;
    var f = function (name, i) { return master.cols[master.names.indexOf(pre + name)][i]; };
    var L = master.cols[iL];
    for (var i = 0; i < L.length; i++) {
      if (Number(L[i]) === lag) {
        return {
          R: f('R_Val', i), P: f('P_Val', i), Overlap: f('Overlap', i),
          First_ring: f('First_ring', i), Last_ring: f('Last_ring', i)
        };
      }
    }
    return null;
  }

  // segCross: crossDatRes rows holding (reference, segment) placements.
  // segments: kept-window metadata per series. Returns
  // { series: { lag, nSegs, minP, tier, members } } for every series whose
  // winning cluster has ≥2 supporting segments.
  function consensusFromRows(segCross, segments, refName) {
    var out = {};
    Object.keys(segments).forEach(function (s) {
      var cands = [];
      (segments[s] || []).forEach(function (w) {
        var row = segRowFor(segCross, refName, w.name);
        if (row < 0) return;
        rowLags(segCross, row).forEach(function (t) {
          if (bad(t.p) || t.p > CONSENSUS.pGate) return;
          cands.push({ seg: w.name, startRow: w.startRow, lag: t.lag - w.startRow, r: t.r, p: t.p });
        });
      });
      // chained clustering on ascending implied lag: a candidate joins a
      // cluster when it is within tol of ANY member, so gradual drift chains
      // (442, 446, 450, …) stay together.
      cands.sort(function (a, b) { return a.lag - b.lag; });
      var clusters = [];
      cands.forEach(function (c) {
        var cl = null;
        for (var i = 0; i < clusters.length && !cl; i++) {
          if (clusters[i].members.some(function (m) { return Math.abs(c.lag - m.lag) <= CONSENSUS.tol; })) cl = clusters[i];
        }
        if (cl) cl.members.push(c); else clusters.push({ members: [c] });
      });
      clusters.forEach(function (cl) {
        var distinct = {};
        cl.members.forEach(function (m) { distinct[m.seg] = true; });
        cl.nSegs = Object.keys(distinct).length;
        cl.minP = Math.min.apply(null, cl.members.map(function (m) { return m.p; }));
        var first = cl.members.slice().sort(function (a, b) { return (a.startRow - b.startRow) || (a.p - b.p); })[0];
        cl.lag = first.lag;
      });
      clusters.sort(function (a, b) { return (b.nSegs - a.nSegs) || (a.minP - b.minP); });
      var win = clusters[0];
      if (!win || win.nSegs < 2) return;
      out[s] = {
        lag: win.lag, nSegs: win.nSegs, minP: win.minP,
        tier: (win.nSegs >= 3 || win.minP <= CONSENSUS.strongP) ? 'strong' : 'tentative',
        members: win.members
      };
    });
    return out;
  }

  // Promote strong consensus into the app-layer copy of crossDatRes, then
  // re-run the filter → align → diagnostics tail of the mode-2 workflow so the
  // whole pipeline (table, plots, aligned frame, report, exports) reflects the
  // consensus ranking. Mutates `result`; annotates each consensus entry with
  // engineLag + action (promoted | confirmed | noted) and returns counts.
  function applyConsensus(result, consensus, filter, probWind, rbarWindow) {
    var target = result.target;
    var cross = {
      names: result.crossDatRes.names.slice(),
      cols: result.crossDatRes.cols.map(function (c) { return c.slice(); })
    };
    var col = function (n) { return cross.cols[cross.names.indexOf(n)]; };
    var S1 = col('Series_1'), S2 = col('Series_2');
    var counts = { promoted: 0, confirmed: 0, noted: 0 };
    for (var r = 0; r < S1.length; r++) {
      if (S1[r] == null || S2[r] == null || S1[r] === S2[r]) continue;
      // Mode 2 always lists the mean chronology first; mode 1 lists each pair
      // in column order, so the target is Series_2 in the rows for series that
      // precede it. The consensus lag is in (target, series) orientation —
      // reading it into a reversed row means the opposite shift.
      var flip = S1[r] !== target;
      var other = flip ? S1[r] : S2[r];
      if (flip && S2[r] !== target) continue;
      var c = consensus[other];
      if (!c) continue;
      var rowLag = flip ? -c.lag : c.lag;
      var eng = bad(col('First_lag')[r]) ? null : Number(col('First_lag')[r]);
      c.engineLag = eng == null ? null : (flip ? -eng : eng);      // kept in target orientation
      if (c.engineLag != null && Math.abs(c.lag - c.engineLag) <= CONSENSUS.tol) {
        c.action = 'confirmed'; counts.confirmed++; continue;
      }
      var st = c.tier === 'strong' ? statsAtLag(result.masterLeadLag, S1[r], S2[r], rowLag) : null;
      if (!st) { c.action = 'noted'; counts.noted++; continue; }
      // engine's 1st/2nd shift down a rank; its 3rd drops off
      [['Sec_', 'Third_'], ['First_', 'Sec_']].forEach(function (mv) {
        ['lag', 'R', 'P', 'Overlap'].forEach(function (fld) { col(mv[1] + fld)[r] = col(mv[0] + fld)[r]; });
      });
      col('First_lag')[r] = rowLag; col('First_R')[r] = st.R;
      col('First_P')[r] = st.P; col('First_Overlap')[r] = st.Overlap;
      col('First_ring')[r] = st.First_ring; col('Last_ring')[r] = st.Last_ring;
      // the engine's old 2nd may BE the consensus lag (it lands in 3rd after
      // the shift) — drop the duplicate rather than list one lag twice
      if (Number(col('Third_lag')[r]) === rowLag) {
        ['lag', 'R', 'P', 'Overlap'].forEach(function (fld) { col('Third_' + fld)[r] = null; });
      }
      c.action = 'promoted'; counts.promoted++;
    }
    var filtered = keepConsensusRows(cross,
      RD.filterCrossdates(cross, Object.assign({}, filter, { target: target })),
      consensus, target, true);
    // Re-run each mode's own alignment tail: mode 2 places the series about the
    // mean chronology and then back onto the dated members; mode 1 places them
    // about the target series and stops there (pairwiseWorkflow step 4).
    var mode2 = Number(result.mode) === 2;
    var alignedSeries = RD.alignSeries(mode2 ? result.chronNSeries : result.detrended, filtered, target);
    var aligned = mode2 ? RD.alignToChron(alignedSeries, result.chronDetrended) : alignedSeries;
    result.crossDatRes = cross;
    result.filtered = filtered;
    if (mode2) result.alignedSeries = alignedSeries;
    result.aligned = aligned;
    Object.assign(result, diagOn(aligned, probWind, rbarWindow));
    return counts;
  }

  // The r/p filter judges whole-series stats, which are exactly what a
  // missing/false-ring series can never deliver — so it drops the very rows
  // the segment consensus rescued. Append each strong-consensus series' own
  // (promoted) row from `cross` when the filter lost it; alignSeries and the
  // filtered-table display both read these rows as-is. markInjected records
  // which entries came back this way (pipeline call only).
  function keepConsensusRows(cross, filtered, consensus, target, markInjected) {
    if (!consensus) return filtered;
    // Either orientation counts as having the series: pairwise rows list the
    // pair in column order, so the target is Series_2 for the series ahead of it.
    var pairedWith = function (f, r) {
      if (f.cols[0][r] === target) return f.cols[1][r];
      if (f.cols[1][r] === target) return f.cols[0][r];
      return null;
    };
    var have = {};
    for (var i = 0; i < filtered.cols[0].length; i++) {
      var p = pairedWith(filtered, i);
      if (p != null) have[p] = true;
    }
    Object.keys(consensus).forEach(function (s) {
      var c = consensus[s];
      if (c.tier !== 'strong' || have[s]) return;
      if (c.action !== 'promoted' && c.action !== 'confirmed') return;
      for (var r = 0; r < cross.cols[0].length; r++) {
        if (pairedWith(cross, r) === s) {
          cross.cols.forEach(function (col, i) { filtered.cols[i].push(col[r]); });
          if (markInjected) c.injected = true;
          filtered.consensusKept = (filtered.consensusKept || 0) + 1;
          break;
        }
      }
    });
    return filtered;
  }

  // Finish a run's background segmentation: the grids already folded (one
  // runner step per series), pick the kept windows, then one segments-only
  // leadLag against the master (full lag range — placements need it, whatever
  // the whole-series lag limits were). No segment rows enter the visible table.
  // The master is the mean chronology in mode 2 and the target series in mode 1;
  // either way it leads the frame, so leadLag mode 2 reads it as series 1 and
  // every implied lag comes back in (target, series) orientation.
  function consensusFinish(result, names, sel, win, keep) {
    var target = result.target;
    var base = Number(result.mode) === 2 ? result.chronNSeries : result.detrended;
    var ti = base ? base.names.indexOf(target) : -1;
    var empty = { segments: sel, bySeries: {}, segLength: win, keepN: keep };
    if (ti < 1) return empty;
    var segFrame = { names: [base.names[0], target], cols: [base.cols[0], base.cols[ti]] };
    var nrow = base.cols[0].length;
    var total = 0;
    names.forEach(function (s) {
      if (s === target) return;                 // a series is no evidence about itself
      (sel[s] || []).forEach(function (w) {
        segFrame.names.push(w.name);
        segFrame.cols.push(windowColumn(base, s, w.startRow, win, nrow));
        total++;
      });
    });
    var bySeries = total ? consensusFromRows(RD.leadLag(segFrame, { mode: 2, complete: true }).crossDatRes, sel, target) : {};
    return { segments: sel, bySeries: bySeries, segLength: win, keepN: keep };
  }

  // Convert a segment's plot lag into the equivalent lag for its FULL series:
  // the parent aligned at the returned lag reproduces the segment's alignment
  // exactly over the segment's rings (segments are slices of the detrended
  // parent, re-based to row 0). `segIsS2` says which side of the plot pair the
  // segment sits on — the plots shift series 2, so replacing s2 subtracts the
  // segment's offset while replacing s1 adds it.
  function fullSeriesLag(result, segName, lag, segIsS2) {
    var m = /^(.*)@(\d+)-(\d+)$/.exec(String(segName));
    if (!m) throw new Error(segName + ' is not a segment.');
    var series = m[1], ringStart = Number(m[2]);
    var frame = Number(result.mode) === 2 ? result.chronNSeries : result.detrended;
    var f = firstRowOf(frame, series);
    if (f < 0) throw new Error(series + ' is not part of this run.');
    var shift = f + ringStart - 1;
    return { series: series, lag: (Number(lag) || 0) + (segIsS2 ? -shift : shift) };
  }

  // Placement plot: ring number (x) vs dated position (y); every segment is a
  // slope-1 line — placements that agree are collinear, offsets and
  // inversions stand apart. The whole-series placement (when the run has one)
  // is the thin reference line.
  function segmentPlacementSpec(series, refName, mode, entries, whole) {
    var xMax = Math.max.apply(null, entries.map(function (e) { return e.ringEnd; }));
    var yLo = Math.min.apply(null, entries.map(function (e) { return e.datedStart; }));
    var yHi = Math.max.apply(null, entries.map(function (e) { return e.datedEnd; }));
    if (whole) { yLo = Math.min(yLo, whole.placement); yHi = Math.max(yHi, whole.placement + xMax - 1); }
    var pad = Math.max(5, Math.round((yHi - yLo) * 0.05));
    var marks = [];
    if (whole) {
      marks.push({ type: 'segment', x0: [1], x1: [xMax], y0: [whole.placement], y1: [whole.placement + xMax - 1], color: '#8899a6', width: 1.5 });
    }
    marks.push({
      type: 'segment',
      x0: entries.map(function (e) { return e.ringStart; }),
      x1: entries.map(function (e) { return e.ringEnd; }),
      y0: entries.map(function (e) { return e.datedStart; }),
      y1: entries.map(function (e) { return e.datedEnd; }),
      color: '#96702f', width: 4
    });
    var legend = [{ label: 'segments', color: '#96702f' }];
    if (whole) legend.push({ label: 'whole series', color: '#8899a6' });
    return {
      type: 'segmentPlacement',
      width: 760, height: 320,
      title: 'Segment placements — ' + series + ' vs ' + refName,
      xLabel: 'Ring in ' + series,
      yLabel: mode === 2 ? 'Dated year' : 'Position on ' + refName + ' axis',
      scales: {
        x: { domain: [1, xMax], breaks: RD.xScaleBar(1, xMax) },
        y: { domain: [yLo - pad, yHi + pad], breaks: null }
      },
      marks: marks,
      legend: { entries: legend },
      colourbar: null
    };
  }

  // ---- missing / false ring test -------------------------------------------
  // Exhaustive single-ring edit experiments for ONE series against a reference:
  //   split i  — ring i divided into two half-width rings (simulates a missed
  //              ring boundary inside increment i; series gains one year)
  //   merge i  — rings i and i+1 summed (simulates a falsely split ring;
  //              series loses one year)
  // Every experiment re-detrends the edited raw series and re-runs the FULL
  // lead-lag crossdate vs the reference. An experiment "bears fruit" when its
  // best match beats the unedited baseline by a meaningful margin
  // (ΔT >= FRUIT_DT and r above baseline).
  //
  // ringTest(opts) returns a stepwise runner so the host can batch the work
  // and paint progress: { total, baseline, seriesLength, step(count)->done,
  // progress(), results(), review(exp), corrected(exp) -> {name, values},
  // correctedDownload(exp) -> {filename, mime, content} (.rwl, relative ring
  // axis 1..n), scoreEdit(exp) -> one ranked row for an edit named by hand,
  // maxRing(type) }.
  // scoreEdit lets a user test a ring they suspect — one they saw under the
  // scope, or one ranked below the top of a finished sweep — on its own,
  // without running (or waiting for) all ~2n experiments.
  //   opts: { undated, series, detrend, leadlag,
  //           seriesValues,   // optional raw values override for `series` —
  //                           // lets an already-corrected series be re-tested
  //                           // (iterative testing) without touching the frame
  //           reference: { kind:'series', name }                       // another complete series
  //                    | { kind:'chron', frame, isDetrended, name } }  // chronology (mean of members)
  var FRUIT_DT = 1;
  function trimSeries(frame, name) {
    var col = frame.cols[frame.names.indexOf(name)];
    var first = -1, last = -1;
    for (var i = 0; i < col.length; i++) if (!bad(col[i])) { if (first < 0) first = i; last = i; }
    if (first < 0) throw new Error('Series ' + name + ' has no values.');
    return col.slice(first, last + 1);
  }
  function applyRingEdit(vals, exp) {
    var i = exp.ring - 1;                          // 1-based ring -> index
    var out = vals.slice(0, i);
    if (exp.type === 'split') {
      out.push(vals[i] / 2, vals[i] / 2);
      return out.concat(vals.slice(i + 1));
    }
    out.push(vals[i] + vals[i + 1]);
    return out.concat(vals.slice(i + 2));
  }
  function detrendValues(values, name, detOpt) {
    var ring = [];
    for (var i = 0; i < values.length; i++) ring.push(i + 1);
    return RD.normalise({ names: ['ring', name], cols: [ring, values] }, detOpt).cols[1];
  }
  function tFromR(r, n) {
    if (r == null || n == null || n < 3 || Math.abs(r) >= 1) return null;
    return r * Math.sqrt((n - 2) / (1 - r * r));
  }
  function ringTest(opts) {
    var undated = opts.undated;
    var series = opts.series;
    if (!undated || !series) throw new Error('Ring test needs loaded data and a series.');
    var detOpt = detrendOptions(opts.detrend);
    var leadlag = opts.leadlag || { neg_lag: -20, pos_lag: 20, complete: true };
    var ref = opts.reference || {};

    // detrended reference column + a contiguous integer axis long enough for both
    var refName, refCol;
    if (ref.kind === 'chron') {
      var chronDet = ref.isDetrended ? ref.frame : RD.normalise(ref.frame, detOpt);
      var mean = RD.meanChronology(chronDet, 'mean_chronology');
      refName = 'mean_chronology'; refCol = mean.cols[1];
    } else {
      if (!ref.name || ref.name === series) throw new Error('Pick a reference other than the test series.');
      refName = ref.name;
      refCol = detrendValues(trimSeries(undated, ref.name), ref.name, detOpt);
    }

    var vals = opts.seriesValues ? opts.seriesValues.slice() : trimSeries(undated, series);
    var n = vals.length;
    if (n < 20) throw new Error('Series is too short to test.');
    function editName(exp) {
      return exp ? series + (exp.type === 'split' ? '+ring' : '-ring') + exp.ring : series;
    }
    // A ring named by hand (a custom edit) is checked here rather than
    // silently producing NaNs downstream; the exhaustive sweep passes
    // through it too, so both paths agree on what an edit IS.
    function validateEdit(exp) {
      if (!exp) return null;
      var type = exp.type === 'merge' ? 'merge' : (exp.type === 'split' ? 'split' : null);
      if (!type) throw new Error('Edit type must be "split" (a missing ring) or "merge" (a false ring).');
      var ring = Math.round(Number(exp.ring));
      var hi = type === 'split' ? n : n - 1;
      if (!(ring >= 1 && ring <= hi)) {
        throw new Error(type === 'split'
          ? 'Ring ' + exp.ring + ' is outside ' + series + ' — it has ' + n + ' rings, so pick 1 to ' + n + '.'
          : 'Rings ' + exp.ring + '–' + (Math.round(Number(exp.ring)) + 1) + ' are outside ' + series +
            ' — it has ' + n + ' rings, so pick a first ring from 1 to ' + hi + '.');
      }
      return { type: type, ring: ring };
    }
    function corrected(exp) {
      var e = validateEdit(exp);
      return { name: editName(e), values: e ? applyRingEdit(vals, e) : vals.slice() };
    }
    function correctedDownload(exp) {
      var c = corrected(exp);
      var ring = [];
      for (var ri = 0; ri < c.values.length; ri++) ring.push(ri + 1);
      return {
        filename: String(c.name).replace(/[^\w.-]+/g, '_') + '_corrected.rwl',
        mime: 'text/plain',
        content: RD.writeRwl({ names: ['ring', c.name], cols: [ring, c.values] }, {})
      };
    }
    var exps = [];
    for (var i = 1; i <= n; i++) exps.push({ type: 'split', ring: i });
    for (var j = 1; j <= n - 1; j++) exps.push({ type: 'merge', ring: j });

    function score(values) {
      var detS = detrendValues(values, series, detOpt);
      var nrow = Math.max(refCol.length, detS.length);
      var axis = [], rc = [], tc = [];
      for (var r = 0; r < nrow; r++) {
        axis.push(r + 1);
        rc.push(r < refCol.length ? refCol[r] : null);
        tc.push(r < detS.length ? detS[r] : null);
      }
      var ll = RD.leadLag({ names: ['year', refName, series], cols: [axis, rc, tc] },
        { mode: 2, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete });
      var cd = ll.crossDatRes;
      var S2 = cd.cols[1], out = null;
      for (var q = 0; q < S2.length; q++) {
        if (S2[q] === series && cd.cols[0][q] === refName) {
          var rV = cd.cols[6][q], ov = cd.cols[8][q];
          out = { lag: cd.cols[5][q], r: rV, p: cd.cols[7][q], overlap: ov, t: tFromR(rV, ov) };
          break;
        }
      }
      return out || { lag: null, r: null, p: null, overlap: null, t: null };
    }

    // raw reference column for the skeleton plot (series references only —
    // a chronology mean has no raw source and keeps its RWI values, as in the
    // Explore chronology-mode plots).
    var refRaw = ref.kind === 'series' ? trimSeries(undated, ref.name) : null;

    // Full review of one experiment (or the unedited baseline when exp is
    // null): rebuild the edited series, re-crossdate it, and return the four
    // standard pair plots + stats at the best lag, shaped like buildPlots
    // output so the host renders them the same way.
    function review(exp) {
      exp = validateEdit(exp);
      var values = exp ? applyRingEdit(vals, exp) : vals;
      var name = editName(exp);
      var detS = detrendValues(values, name, detOpt);
      var nrow = Math.max(refCol.length, detS.length);
      var axis = [], rc = [], tc = [], rawRc = [], rawTc = [];
      for (var r = 0; r < nrow; r++) {
        axis.push(r + 1);
        rc.push(r < refCol.length ? refCol[r] : null);
        tc.push(r < detS.length ? detS[r] : null);
        rawRc.push(refRaw && r < refRaw.length ? refRaw[r] : null);
        rawTc.push(r < values.length ? values[r] : null);
      }
      var cn = { names: ['year', refName, name], cols: [axis, rc, tc] };
      var rawF = { names: ['year'].concat(refRaw ? [refName] : []).concat([name]),
                   cols: [axis].concat(refRaw ? [rawRc] : []).concat([rawTc]) };
      var ll = RD.leadLag(cn, { mode: 2, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete });
      var cd = ll.crossDatRes, lag = 0;
      for (var q = 0; q < cd.cols[1].length; q++) {
        if (cd.cols[1][q] === name && cd.cols[0][q] === refName && cd.cols[5][q] != null) { lag = Number(cd.cols[5][q]); break; }
      }
      var out = {
        // Both columns sit on the synthetic 1..n axis built above — even a
        // chronology reference lost its years there — so the cursor counts
        // rings on both rather than naming a year that is not one.
        line: safe(function () { return RD.linePlot(cn, refName, name, lag, { ringSeries: [refName, name] }); }),
        skeleton: safe(function () { return RD.skelPlot(skelFrame(cn, rawF), refName, name, lag, { ringSeries: [refName, name] }); }),
        heatmap: safe(function () {
          var rll = RD.heatmapAnalysis(cn, { s1: refName, s2: name, neg_lag: -20, pos_lag: 20, center: lag, win: 21, complete: false });
          return RD.heatmapPlot(rll, { s1: refName, s2: name });
        }),
        leadLagBar: safe(function () { return RD.leadLagBar(ll.masterLeadLag, refName, name); }),
        stats: pairStats(cn, refName, name, lag),
        lag: lag
      };
      return applyPlotTitles(out, masterLabel(ref.name || opts.chronName, refName), name, lag);
    }

    var baseline = score(vals);
    // One edit, scored and judged exactly as the sweep judges its own —
    // so a ring the user names by hand is comparable with the ranking,
    // and can be tested on its own without waiting for ~2n experiments.
    function scoreEdit(exp) {
      var e = validateEdit(exp);
      var s = e ? score(applyRingEdit(vals, e)) : baseline;
      var dT = (s.t != null && baseline.t != null) ? s.t - baseline.t : null;
      return {
        type: e ? e.type : null, ring: e ? e.ring : null,
        lag: s.lag, r: s.r, p: s.p, overlap: s.overlap, t: s.t, dT: dT,
        fruitful: !!e && dT != null && s.r != null && baseline.r != null &&
          dT >= FRUIT_DT && s.r > baseline.r
      };
    }
    var results = [];
    var idx = 0;
    return {
      total: exps.length,
      baseline: baseline,
      seriesLength: n,
      step: function (count) {
        var k = 0;
        while (idx < exps.length && k < count) {
          results.push(scoreEdit(exps[idx]));
          idx++; k++;
        }
        return idx >= exps.length;
      },
      progress: function () { return idx; },
      results: function () {
        var sorted = results.slice().sort(function (a, b) {
          return (b.dT == null ? -Infinity : b.dT) - (a.dT == null ? -Infinity : a.dT);
        });
        return { experiments: sorted, fruitful: sorted.filter(function (x) { return x.fruitful; }) };
      },
      review: review,
      corrected: corrected,
      correctedDownload: correctedDownload,
      scoreEdit: scoreEdit,
      // highest ring number an edit of each kind can name (merge needs i+1)
      maxRing: function (type) { return type === 'merge' ? n - 1 : n; }
    };
  }

  // ---- chronology composite ------------------------------------------------
  // Mean of the detrended chronologies: each loaded chronology's members are
  // detrended with the CURRENT settings and averaged into that chronology's
  // mean; the means are merged on the union of their year axes. Each
  // chronology contributes one column (equal weight regardless of member
  // count), so feeding the result to chronologyWorkflow with
  // chronIsDetrended:true makes its mean_chronology the mean of the detrended
  // chronologies. chronList: [{ name, frame }].
  function baseName(name) {
    return String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.[A-Za-z0-9]+$/, '');
  }
  function compositeChron(chronList, detrendUiObj) {
    if (!chronList || chronList.length < 2) throw new Error('The composite needs at least two loaded chronologies.');
    var out = null, used = {};
    chronList.forEach(function (c) {
      var base = baseName(c.name) || 'chronology';
      var name = base, k = 2;
      while (used[name]) name = base + '_' + (k++);
      used[name] = true;
      // each chronology is judged on its own: a .crn among .rwl files is not
      // detrended a second time before it is averaged in.
      var cOpt = detrendOptions(detrendUiObj, detectDetrended(c.frame, c.name).names);
      var mean = RD.meanChronology(RD.normalise(c.frame, cOpt), name);
      out = bindDated(out, mean);
    });
    return out;
  }

  // ---- detrend / leadlag / filter option objects (from raw UI values) ------
  // `skip` names series to carry through un-detrended (normalise() honours it).
  function detrendOptions(ui, skip) {
    ui = ui || {};
    var o = {
      detrending_select: Number(ui.detrending_select != null ? ui.detrending_select : 3),
      splinewindow: Number(ui.splinewindow != null ? ui.splinewindow : 32),
      ARmod: !!ui.ARmod,
      logT: !!ui.logT
    };
    var sk = skip != null ? skip : ui.skip;
    if (sk && sk.length) o.skip = sk.slice();
    return o;
  }

  // Which series of a frame are ALREADY indices (src/detrend/detect.js), so a
  // second detrend can be skipped on them. Best effort in both directions: the
  // detector never throws out of a run, and it never flags on a guess — see the
  // rules in that module. `source` is the file name, for the .crn rule.
  var NO_SKIP = { names: [], reasons: {}, all: false, judged: 0 };
  function detectDetrended(frame, source) {
    if (!frame) return NO_SKIP;
    try { return RD.detectDetrended(frame, { source: source }); }
    catch (e) { return NO_SKIP; }
  }

  // ---- run a full workflow -------------------------------------------------
  // opts: { mode(1|2), undated, chron?, detrend, leadlag, filter, probWind,
  // rbarWindow, segLen?, keepN? }. Returns the workflow bundle, annotated with
  // { mode, target, undated } so the downloads / report / plot helpers are
  // self-sufficient. Chronology-mode bundles also carry the segment-consensus
  // block. Synchronous run-to-completion of analysisRunner (above).
  function runAnalysis(opts) {
    var r = analysisRunner(opts);
    while (!r.step());
    return r.result();
  }

  // ---- crossDatRes table shaping (the 17-col interseries table) -------------
  function fmtCell(v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '';
    if (typeof v === 'number') {
      // keep integers whole; round noisy floats to 4 dp for display
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4);
    }
    return String(v);
  }
  // p-value display: on strong crossdates cor.test p underflows toward 0, which
  // fmtCell would round to "0". Below the 1E-6 measurement threshold show "< 1E-6"
  // instead; small-but-measurable values use scientific notation. (Display only —
  // the raw numeric p is preserved in the frame and in CSV exports.)
  var P_FLOOR = 1e-6;
  function isPCol(name) { return /(_P$)|(p[_ ]?val)/i.test(String(name)); }
  function fmtP(v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '';
    if (typeof v !== 'number') return String(v);
    if (v < P_FLOOR) return '< 1E-6';                 // includes 0 / underflow
    if (v >= 1) return '1';                           // Bonferroni p caps at 1
    if (v < 0.001) return v.toExponential(2).replace('e', 'E');
    return String(Math.round(v * 1e5) / 1e5);
  }
  // frame -> { columns:[...names], rows:[[cell,...]] } (raw cell values preserved
  // in `raw`, display strings in `rows`).
  function frameToTable(frame) {
    if (!frame || !frame.names) return { columns: [], rows: [], raw: [] };
    var nrow = frame.cols.length ? frame.cols[0].length : 0;
    var rows = [], raw = [];
    var pCol = frame.names.map(isPCol);
    for (var r = 0; r < nrow; r++) {
      var row = [], rawRow = [];
      for (var c = 0; c < frame.cols.length; c++) {
        rawRow.push(frame.cols[c][r]);
        row.push(pCol[c] ? fmtP(frame.cols[c][r]) : fmtCell(frame.cols[c][r]));
      }
      rows.push(row); raw.push(rawRow);
    }
    return { columns: frame.names.slice(), rows: rows, raw: raw };
  }
  function crossDatTable(crossDatRes) { return frameToTable(crossDatRes); }

  // re-filter an existing crossDatRes with new r/p/overlap/target (Step-1/2 of
  // the pairwise results tab). Returns the filtered Frame (throws on bad
  // target). With `consensus`, rows the filter dropped but a strong segment
  // consensus supports are appended back (frame.consensusKept counts them).
  function refilter(crossDatRes, filter, consensus) {
    var out = RD.filterCrossdates(crossDatRes, filter);
    return keepConsensusRows(crossDatRes, out, consensus, filter.target, false);
  }

  // ---- plots ---------------------------------------------------------------
  // Build every plot spec available from a workflow result. Each is wrapped in a
  // try/catch and returns null on failure (e.g. not enough overlap), so a single
  // un-buildable panel never breaks the whole plots area.
  //   pair: [s1, s2] series names for the pairwise line/lead-lag/heatmap plots
  //   lag:  integer lag to shift series 2 in the line plot
  //   detrendSeries: series name for the detrending diagnostic plot
  // Best crossdate lag for a pair, read from crossDatRes (First_lag). Used to
  // center the heatmap's lag axis on the match. Falls back to the reversed
  // orientation (negated) or 0 if the pair isn't in the results table.
  // Every lag this pair's crossdate scanned, from the masterLeadLag block —
  // the same range the lead-lag bar plots on its x axis. Null when the pair
  // has no block (e.g. a frame built outside a run). Columns are stored for
  // one direction only, so a reversed pair's span is negated.
  function scannedLagSpan(result, s1, s2) {
    var mll = result && result.masterLeadLag;
    if (!mll || !mll.names) return null;
    var i = mll.names.indexOf('ser_1_' + s1 + '_ser_2_' + s2 + '_lag'), flip = false;
    if (i < 0) { i = mll.names.indexOf('ser_1_' + s2 + '_ser_2_' + s1 + '_lag'); flip = i >= 0; }
    if (i < 0) return null;
    var c = mll.cols[i], lo = Infinity, hi = -Infinity;
    for (var r = 0; r < c.length; r++) {
      var v = c[r];
      if (v == null || (typeof v === 'number' && isNaN(v))) continue;
      v = Number(v);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return flip ? { neg: -hi, pos: -lo } : { neg: lo, pos: hi };
  }
  function bestLagFor(result, s1, s2) {
    var cd = result && result.crossDatRes;
    if (!cd) return 0;
    var i1 = cd.names.indexOf('Series_1'), i2 = cd.names.indexOf('Series_2'), il = cd.names.indexOf('First_lag');
    if (i1 < 0 || i2 < 0 || il < 0) return 0;
    var S1 = cd.cols[i1], S2 = cd.cols[i2], L = cd.cols[il];
    for (var r = 0; r < S1.length; r++) if (S1[r] === s1 && S2[r] === s2 && L[r] != null) return Number(L[r]);
    for (var q = 0; q < S1.length; q++) if (S1[q] === s2 && S2[q] === s1 && L[q] != null) return -Number(L[q]);
    return 0;
  }

  // Skeleton plots must run on RAW measurements: dplR's skel.plot divides by the
  // hanning-smoothed local mean as its own normalisation and assumes positive
  // values. The detrended comparison frames (z-score+1, first differences) cross
  // zero, which flips the narrowness sign and marks the wrong rings. Rebuild the
  // comparison frame with raw columns wherever the raw frame carries the same
  // series (row axes are positionally aligned: normalise/comb.NA keep undated
  // series at rows 0..n-1). Columns without a raw source — mean_chronology,
  // seeded chron members — keep their positive RWI values, which dplR's maths
  // handles fine.
  function skelFrame(compFrame, rawFrame) {
    if (!compFrame || !rawFrame || !rawFrame.names) return compFrame;
    var out = { names: compFrame.names.slice(), cols: compFrame.cols.slice() };
    var n = out.cols[0].length;
    for (var c = 1; c < out.names.length; c++) {
      var ri = rawFrame.names.indexOf(out.names[c]);
      if (ri < 1) continue;
      var raw = rawFrame.cols[ri];
      var col = new Array(n).fill(null);
      for (var r = 0; r < n && r < raw.length; r++) col[r] = raw[r];
      out.cols[c] = col;
    }
    return out;
  }

  // Uniform titling for the pair plots: one HEADER line names the two series
  // (or chronology and series) and the lag; each plot itself is titled by its
  // TYPE. The header string rides on the plots object; the hosts render it once
  // above the plots (app.js headerSvg) so screen and saved images match.
  var PLOT_TITLES = {
    line: 'Detrended time series',
    skeleton: 'Skeleton plot',
    leadLagBar: "Student's T test",
    heatmap: 'Heat map'
  };
  function setPlotTitle(spec, t) {
    if (!spec) return spec;
    spec.title = t;
    if (spec.panels && spec.panels.length) spec.panels[0].title = t;
    return spec;
  }
  function applyPlotTitles(out, s1, s2, lag) {
    Object.keys(PLOT_TITLES).forEach(function (k) { setPlotTitle(out[k], PLOT_TITLES[k]); });
    out.header = s1 + ' vs ' + s2 + ' — lagged ' + (Number(lag) || 0) + ' years';
    return out;
  }
  // Stats for a pair at ONE specified lag, computed on the comparison frame
  // with the engine's conventions (leadLag.js): series 2 shifted by `lag`,
  // First/Last ring = its shifted placement on the axis, overlap = complete
  // pairs, r/p/t from the validated Pearson cor.test port (p uncorrected —
  // single chosen lag, not a scan). Null r/p/t when the overlap is too thin.
  function pairStats(frame, s1, s2, lag) {
    if (!frame || !frame.names) return null;
    var i1 = frame.names.indexOf(s1), i2 = frame.names.indexOf(s2);
    if (i1 < 1 || i2 < 1) return null;
    var bad = function (v) { return v == null || (typeof v === 'number' && isNaN(v)); };
    var yrs = frame.cols[0], a = frame.cols[i1], b = frame.cols[i2];
    var L = Number(lag) || 0;
    var byYear = {};
    for (var r = 0; r < yrs.length; r++) if (!bad(yrs[r])) byYear[Number(yrs[r])] = r;
    var first = null, last = null, x = [], y = [];
    for (var q = 0; q < yrs.length; q++) {
      if (bad(yrs[q]) || bad(b[q])) continue;
      var t = Number(yrs[q]) + L;
      if (first == null || t < first) first = t;
      if (last == null || t > last) last = t;
      var ra = byYear[t];
      if (ra != null && !bad(a[ra])) { x.push(Number(a[ra])); y.push(Number(b[q])); }
    }
    var out = { firstRing: first, lastRing: last, overlap: x.length, r: null, p: null, t: null };
    if (x.length >= 3) {
      var ct = RD.pearsonCorTest(x, y);
      out.r = ct.r; out.p = ct.p; out.t = ct.t;
    }
    return out;
  }

  // "mean_chronology" alone doesn't say WHICH chronology — prefix the source
  // file's base name when one is known: "ut585 mean_chronology".
  function masterLabel(chronName, s1) {
    if (s1 !== TARGET || !chronName) return s1;
    var base = String(chronName).replace(/\\/g, '/').split('/').pop().replace(/\.[A-Za-z0-9]+$/, '');
    return base ? base + ' ' + TARGET : s1;
  }

  function buildPlots(result, o) {
    o = o || {};
    var mode = Number(result.mode) === 2 ? 2 : 1;
    var aligned = result.aligned;
    var undated = result.undated;
    var colScale = o.colorScale != null ? Number(o.colorScale) : 1;
    var lag = Number(o.lag) || 0;
    var detrend = result.detrendOpts || {};

    // Frame the two-series plots (line / skeleton / heatmap / lead-lag bar)
    // operate on, and where their pair names come from. Both modes use the
    // UNALIGNED comparison frame — mode 1 (pairwise): the detrended undated series
    // (each at its own position 0); mode 2 (chronology): `chronNSeries` =
    // mean_chronology + undated series. The `lag` then shifts series 2 to the
    // crossdate alignment, so all four two-series plots share one lag convention.
    // (Using the pre-aligned `aligned` frame here double-shifts the line plot.)
    var compFrame = mode === 2 ? result.chronNSeries : result.detrended;
    var lineFrame = compFrame;
    var pn = compFrame && compFrame.names ? compFrame.names : [];
    var target = result.target || (mode === 2 ? 'mean_chronology' : pn[1]);
    var s1 = (o.pair && o.pair[0]) || (mode === 2 ? target : pn[1]);
    var s2 = (o.pair && o.pair[1]) || (mode === 2 ? (pn[2] || pn[1]) : pn[2]);

    // Which plotted series are UNDATED, so the hover cursor labels them by ring
    // count instead of by a calendar year they do not have. The comparison
    // frame's year axis belongs to the CHRONOLOGY (mode 2: comb.NA places each
    // pool series' ring 1 on the chronology's first row, positionally), so
    // every column but the mean chronology is a series being dated; in mode 1
    // both sides come from the undated pool.
    var ringSeries = pn.slice(1).filter(function (n) { return mode !== 2 || n !== target; });

    var out = { line: null, skeleton: null, heatmap: null, leadLagBar: null, allSeries: null, detrend: null };

    out.line = safe(function () { return RD.linePlot(lineFrame, s1, s2, lag, { sel_col_pal: colScale, ringSeries: ringSeries }); });
    out.skeleton = safe(function () { return RD.skelPlot(skelFrame(compFrame, undated), s1, s2, lag, { ringSeries: ringSeries }); });
    out.leadLagBar = safe(function () { return RD.leadLagBar(result.masterLeadLag, s1, s2); });
    out.allSeries = safe(function () { return RD.allSeries(aligned); });
    // heatmap: running lead-lag between the two series on the comparison frame.
    // The lag (y) axis centers on the UI-chosen lag so adjusting the lag moves
    // the heatmap window like the line/skeleton plots; when no lag is chosen
    // (0), fall back to the pair's best crossdate lag so the match band is
    // visible (e.g. best lag 98 -> lag axis ~78..118).
    var hmCenter = o.heatmapCenter != null ? Number(o.heatmapCenter)
      : (lag !== 0 ? lag : bestLagFor(result, s1, s2));
    var corWin = o.corWin != null ? Number(o.corWin) : 21;
    var HM_HALF = 20;
    var heatAt = function (span, size) {
      return safe(function () {
        var rll = RD.heatmapAnalysis(compFrame, {
          s1: s1, s2: s2, neg_lag: span.neg, pos_lag: span.pos, center: 0,
          win: corWin, complete: false
        });
        return RD.heatmapPlot(rll, {
          s1: s1, s2: s2, sel_col_pal: colScale,
          width: size && size.width, height: size && size.height
        });
      });
    };
    var window20 = function (center) { return { neg: center - HM_HALF, pos: center + HM_HALF }; };
    // `heatmapFull` opens the lag axis to EVERY lag the crossdate scanned
    // instead of the ±20 band around the match. The band is what lets the
    // heatmap sit beside the other plots; shown on its own it has the room to
    // say where else in the scan the two series correlate — which is the
    // question a heatmap is for. Taller with more lag rows, so the rows stay
    // thick enough to read (capped, and the wrapper scrolls).
    var fullSpan = o.heatmapFull ? scannedLagSpan(result, s1, s2) : null;
    var fullSize = fullSpan ? (o.heatmapSize || {
      width: 1100,
      height: Math.max(360, Math.min(820, Math.round((fullSpan.pos - fullSpan.neg) * 1.4) + 80))
    }) : null;
    // a far-off best-lag center can leave too little overlap; fall back to the
    // chosen lag rather than rendering nothing
    out.heatmap = (fullSpan && heatAt(fullSpan, fullSize)) ||
      heatAt(window20(hmCenter)) || (hmCenter !== lag ? heatAt(window20(lag)) : null);
    // What the lag axis ended up covering, so the host can say so. It is the
    // range that produced correlations, not the range asked for: lags far
    // enough out leave fewer than `win` overlapping rings and drop out.
    out.heatmapSpan = out.heatmap
      ? { neg: out.heatmap.scales.y.domain[0], pos: out.heatmap.scales.y.domain[1] }
      : null;
    out.scannedSpan = scannedLagSpan(result, s1, s2);
    // detrend diagnostic on the raw (un-detrended) undated data
    var dSeries = o.detrendSeries || (undated && undated.names[1]);
    out.detrend = safe(function () {
      return RD.detrendPlot(undated, dSeries, {
        detrending_select: detrend.detrending_select,
        splinewindow: detrend.splinewindow,
        ARmod: detrend.ARmod, logT: detrend.logT
      });
    });
    out.stats = pairStats(compFrame, s1, s2, lag);
    return applyPlotTitles(out, masterLabel(result.chronName || o.chronName, s1), s2, lag);
  }
  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  function renderPlot(spec) { return spec ? RD.renderSvg(spec) : ''; }
  // stack several single-/multi-panel specs into one tall SVG
  function combinedPlot(specs) {
    var panels = [];
    specs.forEach(function (s) {
      if (!s) return;
      if (s.panels && s.panels.length) panels = panels.concat(s.panels);
      else panels.push(s);
    });
    if (!panels.length) return '';
    var width = Math.max.apply(null, panels.map(function (p) { return p.width || 760; }));
    return RD.renderSvg({ width: width, panels: panels });
  }

  // ---- interactive chronology builder --------------------------------------
  // Thin, DOM-free wrappers around RD.createBuilder so the Build-chronology tab
  // in app.js stays dumb wiring. TARGET is the mean-chronology column name the
  // builder crossdates every candidate against.
  var TARGET = 'mean_chronology';

  // Create a builder from loaded frames + the current detrend UI object.
  // Series already in index form are carried through un-detrended, as in a run.
  function newBuilder(o) {
    o = o || {};
    var skip = o.autoSkip === false ? [] : detectDetrended(o.undated, o.undatedName).names
      .concat(detectDetrended(o.chron, o.chronName).names);
    return RD.createBuilder({
      undated: o.undated, chron: o.chron, detrend: detrendOptions(o.detrend, skip)
    });
  }

  // Build the three review plot specs for candidate `id` at lag `lag` from an
  // already-run crossdate (cn + masterLeadLag). Each is safe()-wrapped and null
  // on thin overlap. leadLagBar is lag-independent; line + heatmap follow `lag`.
  // `rawUndated` (the un-detrended pool frame) feeds the skeleton plot its raw
  // ring widths — see skelFrame.
  function builderPlots(cn, masterLeadLag, id, lag, rawUndated, chronName) {
    var L = Number(lag) || 0;
    return applyPlotTitles({
      // the candidate is a pool series: no years, so the cursor counts its rings
      line: safe(function () { return RD.linePlot(cn, TARGET, id, L, { ringSeries: [id] }); }),
      skeleton: safe(function () { return RD.skelPlot(skelFrame(cn, rawUndated), TARGET, id, L, { ringSeries: [id] }); }),
      heatmap: safe(function () {
        var rll = RD.heatmapAnalysis(cn, { s1: TARGET, s2: id, neg_lag: -20, pos_lag: 20, center: L, win: 21, complete: false });
        return RD.heatmapPlot(rll, { s1: TARGET, s2: id });
      }),
      leadLagBar: safe(function () { return RD.leadLagBar(masterLeadLag, TARGET, id); }),
      stats: pairStats(cn, TARGET, id, L)
    }, masterLabel(chronName, TARGET), id, L);
  }

  // Crossdate `id` against the builder's current mean chronology and return the
  // best-3 suggestions plus the three review plot specs for the chosen lag
  // (defaults to the best suggestion when `lag` is null/NaN). cn + masterLeadLag
  // are returned so the host can rebuild the plots on a lag change WITHOUT
  // re-crossdating (see builderPlots).
  function builderReview(builder, id, lag, rawUndated, chronName) {
    var cx = builder.crossdate(id);
    var suggestions = cx.suggestions || [];
    var bestLag = suggestions.length ? Number(suggestions[0].lag) : 0;
    var L = (lag == null || isNaN(Number(lag))) ? bestLag : Number(lag);
    var plots = builderPlots(cx.cn, cx.masterLeadLag, id, L, rawUndated, chronName);
    return {
      suggestions: suggestions, cn: cx.cn, masterLeadLag: cx.masterLeadLag,
      bestLag: bestLag, lag: L, header: plots.header, stats: plots.stats,
      line: plots.line, skeleton: plots.skeleton, heatmap: plots.heatmap, leadLagBar: plots.leadLagBar
    };
  }

  // Safe "mean + all member series" plot of a working chronology frame.
  function builderChronPlot(frame) { return safe(function () { return RD.allSeries(frame); }); }

  // Download descriptors (CSV + RWL) for a working chronology frame, matching the
  // Downloads tab's { filename, mime, content } shape. Uses the R-validated
  // writeCsv / writeRwl writers directly (buildDownloads is workflow-result
  // oriented; a plain chronology frame only needs these two writers).
  function isoDate(date) {
    if (typeof date === 'string') return date;          // assume already ISO
    var d = date == null ? new Date() : (date instanceof Date ? date : new Date(date));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // Download descriptors for a built chronology frame.
  //   opts: a date (string | Date), or { date, sources }.
  // `sources` are the RAW frames the members were measured from (the undated
  // pool, loaded chronologies). The builder crossdates on detrended indices, so
  // its working frame holds indices; given the sources, the CSV and the .rwl are
  // written in RING WIDTHS at the placement the build found — which is what a
  // .rwl means and what other software will read them as — and the indices keep
  // a CSV of their own.
  // A file name the browser — and the file system it lands in — will accept:
  // no path separators, none of the characters Windows refuses, no leading dot
  // or trailing dot/space. Falls back to the generated name when what the user
  // typed comes to nothing, so an emptied box saves as "built_chronology.csv"
  // rather than as ".csv".
  function downloadName(name, fallback) {
    var s = String(name == null ? '' : name).trim()
      .replace(/[\/:*?"<>|]+/g, '_')
      .replace(/[\x00-\x1f]+/g, '')
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
    return s || fallback;
  }

  function builderDownloads(frame, opts) {
    var o = (opts && typeof opts === 'object' && !(opts instanceof Date)) ? opts : { date: opts };
    var dt = isoDate(o.date);
    var re = (o.sources && o.sources.length) ? RD.rawAligned(frame, o.sources) : null;
    var raw = (re && re.substituted.length) ? re.frame : null;
    var out = {};
    out.chronologyCsv = { filename: 'built_chronology_' + dt + '.csv', mime: 'text/csv',
      content: RD.writeCsv(raw || frame) };
    if (raw) {
      out.chronologyDetrendedCsv = { filename: 'built_chronology_detrended_' + dt + '.csv',
        mime: 'text/csv', content: RD.writeCsv(frame) };
    }
    out.chronologyRwl = { filename: 'built_chronology_' + dt + '.rwl', mime: 'text/plain',
      content: RD.writeRwl(raw || frame, {}) };
    return out;
  }

  // Assemble a writeTridas() spec from a builder + the raw undated frame + meta:
  //   - derivedSeries  = the mean chronology, with per-year sample depth
  //   - measurementSeries (members) = the RAW ring-width series from `undated`,
  //     dated onto the chronology axis via summary() first years
  //   - provenance = derivedSeries <linkSeries> back to each member's identifier
  function colByName(frame, name) {
    var i = frame ? frame.names.indexOf(name) : -1;
    return i < 0 ? null : frame.cols[i];
  }
  function leadingRun(col) {                 // raw member columns are bottom-padded with NA
    var out = [];
    for (var i = 0; i < col.length; i++) { if (col[i] == null) break; out.push(col[i]); }
    return out;
  }
  function tridasSpec(o, mode) {
    var b = o.builder;
    if (!b) throw new Error('No chronology to export.');
    var dated = b.isDated();
    var mean = b.meanChronology();
    if (!mean) throw new Error('Nothing to export yet.');
    var work = b.chronology();               // relative-axis working frame (col0 + member cols)
    var meanVals = mean.cols[mean.cols.length - 1];
    var firstInternal = dated ? b.calendarYear(mean.cols[0][0]) : null;
    var depth = [];
    for (var r = 0; r < work.cols[0].length; r++) {
      var n = 0;
      for (var c = 1; c < work.cols.length; c++) if (work.cols[c][r] != null) n++;
      depth.push(n);
    }
    var meta = o.meta || {};
    var sum = b.summary();
    var members = sum.members.map(function (m) {
      var col = colByName(o.undated, m.id);
      return {
        name: m.id,
        valuesMm: col ? leadingRun(col) : [],
        firstYearInternal: (dated && m.firstYear != null) ? m.firstYear : null,
        meta: meta[m.id] || RD.emptySeriesMeta(m.id, m.id)
      };
    });
    var chronology = {
      name: o.chronName || 'chronology', valuesMm: meanVals,
      firstYearInternal: firstInternal, sampleDepth: depth,
      meta: RD.emptySeriesMeta('chronology', o.chronName || 'chronology')
    };
    return {
      mode: mode, chronology: chronology, members: members,
      project: { title: o.projectTitle || 'RingdateR chronology' }
    };
  }
  function builderTridasDownloads(o) {
    var dt = isoDate(o && o.date);
    return {
      chronologyTridasSelfContained: {
        filename: 'chronology_' + dt + '.tridas.xml', mime: 'application/xml',
        content: RD.writeTridas(tridasSpec(o, 'selfContained'))
      },
      chronologyTridasDerivedOnly: {
        filename: 'chronology_derivedSeries_' + dt + '.tridas.xml', mime: 'application/xml',
        content: RD.writeTridas(tridasSpec(o, 'derivedOnly'))
      }
    };
  }

  // ---- builder report ------------------------------------------------------
  // Self-contained HTML report of a BUILT chronology, from summary() output.
  // Contains: members table (id, lag, calendar first/last year when dated, else
  // positions), the dating statement, the set-aside table (status + note
  // explaining what was left out and why), chronology stats (Rbar / EPS /
  // sample depth, guarded for nulls) and the span. Opens standalone in a new tab.
  function statNum(v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
    return typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v);
  }
  function isNAn(v) { return v == null || (typeof v === 'number' && isNaN(v)); }

  // prob_check() result -> HTML: the flagged samples + intervals, or the
  // "no problems"/error message.
  function renderProbSection(pc, e) {
    if (!pc) return '<p class="hint">Problem check was not run.</p>';
    if (pc.message) return '<p>' + e(pc.message) + '</p>';
    if (!pc.samples || !pc.samples.length) {
      return '<p>Problem checker could not detect problems with any sample.</p>';
    }
    var rows = pc.samples.map(function (s, i) {
      return '<tr><td class="l">' + e(s) + '</td><td class="l">' + e((pc.intervals && pc.intervals[i]) || '') + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>Flagged sample</th><th>Interval</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // rBarEps() rows -> HTML: always a compact peak summary; when `verbose`, also
  // the full per-window Rbar/EPS table.
  function renderRbarSection(re, verbose, e) {
    if (!re || !re.length) return '<p class="hint">Rbar/EPS unavailable (no complete windows for this window length).</p>';
    var peakR = -Infinity, peakE = -Infinity, depth = 0;
    re.forEach(function (w) {
      if (!isNAn(w.rbarTot) && w.rbarTot > peakR) peakR = w.rbarTot;
      if (!isNAn(w.eps) && w.eps > peakE) peakE = w.eps;
      if (!isNAn(w.nTrees) && w.nTrees > depth) depth = w.nTrees;
    });
    var summaryTbl = '<table><tbody>' +
      '<tr><td class="l">Peak Rbar</td><td>' + statNum(peakR === -Infinity ? null : peakR) + '</td></tr>' +
      '<tr><td class="l">Peak EPS</td><td>' + statNum(peakE === -Infinity ? null : peakE) + '</td></tr>' +
      '<tr><td class="l">Peak sample depth</td><td>' + statNum(depth) + '</td></tr>' +
      '</tbody></table>';
    if (!verbose) return summaryTbl;
    var rows = re.map(function (w) {
      return '<tr><td class="l">' + e(w.midYear) + '</td><td>' + e(w.nTrees) + '</td><td>' + e(w.n) +
        '</td><td>' + statNum(w.rbarTot) + '</td><td>' + statNum(w.eps) + '</td></tr>';
    }).join('');
    return summaryTbl +
      '<table><thead><tr><th>Mid year</th><th>Trees</th><th>n</th><th>Rbar</th><th>EPS</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  // opts = { date, verbose, probWind, rbarWindow }. `builder` is the live builder
  // (preferred) so the report can recompute prob-check + Rbar/EPS at GENERATE time
  // from the current chronology frame, honouring the option windows. summary() is
  // still used for the member / dating / set-aside content.
  function builderReport(builder, opts) {
    opts = opts || {};
    var dt = isoDate(opts.date);
    var verbose = !!opts.verbose;
    var probWind = opts.probWind != null ? Number(opts.probWind) : 30;
    var rbarWindow = opts.rbarWindow != null ? Number(opts.rbarWindow) : 30;
    var s = (builder && typeof builder.summary === 'function') ? builder.summary() : (builder || {});
    var members = s.members || [];
    var setAside = s.setAside || [];
    var dated = !!s.dated;
    var datum = s.datum || null;
    var span = s.span || {};
    var stats = s.stats || {};
    var e = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

    // dating statement + span line
    var dateStmt, spanLine;
    if (dated && datum && datum.source === 'chronology') {
      dateStmt = 'Dated from the loaded chronology (calendar years).';
      spanLine = 'Chronology spans <b>' + e(span.firstYear) + '</b>–<b>' + e(span.lastYear) + '</b> (calendar years).';
    } else if (dated && datum) {
      dateStmt = 'Dated: <b>' + e(datum.seriesId) + '</b> ' + e(datum.edge) + ' ring = <b>' + e(datum.year) + '</b>.';
      spanLine = 'Chronology spans <b>' + e(span.firstYear) + '</b>–<b>' + e(span.lastYear) + '</b> (calendar years).';
    } else {
      dateStmt = 'Undated (floating chronology) — no calendar datum applied.';
      spanLine = 'Spans positions <b>' + e(span.firstPos) + '</b>–<b>' + e(span.lastPos) + '</b>.';
    }

    var memHead = dated
      ? '<tr><th>Series</th><th>Lag</th><th>First year</th><th>Last year</th></tr>'
      : '<tr><th>Series</th><th>Lag</th><th>First pos</th><th>Last pos</th></tr>';
    var memRows = members.map(function (m) {
      var a = dated ? m.firstYear : m.firstPos, b = dated ? m.lastYear : m.lastPos;
      return '<tr><td class="l">' + e(m.id) + '</td><td>' + e(m.lag) + '</td><td>' + e(a) + '</td><td>' + e(b) + '</td></tr>';
    }).join('') || '<tr><td colspan="4">No members.</td></tr>';

    var saSection;
    if (setAside.length) {
      var saRows = setAside.map(function (x) {
        var badge = x.status === 'review' ? 'review' : 'skipped';
        return '<tr><td class="l">' + e(x.id) + '</td><td><span class="tag ' + badge + '">' + e(x.status) + '</span></td><td class="l">' + e(x.note || '') + '</td></tr>';
      }).join('');
      saSection = '<h2>Set aside (' + setAside.length + ')</h2><p class="hint">Series deliberately left out of the chronology and why.</p>' +
        '<table><thead><tr><th>Series</th><th>Status</th><th>Note</th></tr></thead><tbody>' + saRows + '</tbody></table>';
    } else {
      saSection = '<h2>Set aside</h2><p class="hint">No series were skipped or flagged for review.</p>';
    }

    var statsRows =
      '<tr><td class="l">Rbar</td><td>' + statNum(stats.rbar) + '</td></tr>' +
      '<tr><td class="l">EPS</td><td>' + statNum(stats.eps) + '</td></tr>' +
      '<tr><td class="l">Sample depth</td><td>' + statNum(stats.sampleDepth) + '</td></tr>';

    // Recompute diagnostics at generate time from the current chronology frame.
    // Both RD.probCheck / RD.rBarEps THROW on short/thin chronologies, so each is
    // wrapped and degraded to a friendly note rather than failing the report.
    var chrono = null;
    if (builder && typeof builder.chronology === 'function') {
      try { chrono = builder.isDated() ? builder.datedChronology() : builder.chronology(); }
      catch (err) { chrono = null; }
    }
    var haveChron = !!(chrono && chrono.cols && chrono.cols.length >= 2 && members.length >= 2);

    var probHtml;
    if (!haveChron) {
      probHtml = '<p class="hint">Problem check unavailable (need at least two aligned series).</p>';
    } else {
      try { probHtml = renderProbSection(RD.probCheck(chrono, { wind: probWind }), e); }
      catch (err) { probHtml = '<p class="hint">Problem check unavailable (try a smaller window).</p>'; }
    }

    var rbarHtml;
    if (!haveChron) {
      rbarHtml = '<p class="hint">Rbar/EPS unavailable (need at least two aligned series).</p>';
    } else {
      try { rbarHtml = renderRbarSection(RD.rBarEps(chrono, { window: rbarWindow }), verbose, e); }
      catch (err) { rbarHtml = '<p class="hint">Rbar/EPS unavailable (try a smaller window).</p>'; }
    }

    var diagSections =
      '<h2>Problem check</h2>' +
      '<p class="hint">Segment correlations against the mean chronology (' + e(probWind) + '-year window, 50% overlap).</p>' +
      probHtml +
      '<h2>Rbar / EPS (' + e(rbarWindow) + '-year window)</h2>' +
      '<p class="hint">' + (verbose ? 'Full per-window table.' : 'Compact summary — enable Verbose for the full per-window table.') + '</p>' +
      rbarHtml;

    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>RingdateR — built chronology report</title><style>' +
      'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;margin:0;padding:28px;line-height:1.5;background:#f4f6f8}' +
      '.wrap{max-width:820px;margin:0 auto;background:#fff;border:1px solid #d7dde2;border-radius:8px;padding:24px 28px}' +
      'h1{color:#8a6529;font-size:22px;margin:0 0 2px}h2{color:#8a6529;font-size:16px;margin:22px 0 6px}' +
      '.sub{color:#667;font-size:13px;margin:0 0 14px}.hint{color:#667;font-size:13px;margin:2px 0 8px}' +
      '.statement{background:#fbf5e9;border:1px solid #e8d6ae;border-radius:6px;padding:10px 14px;margin:10px 0}' +
      'table{border-collapse:collapse;font-size:13px;width:100%;margin:6px 0}' +
      'th,td{border:1px solid #e7ebee;padding:4px 9px;text-align:right}td.l,th.l{text-align:left}th{background:#eef2f4}' +
      'th:first-child,td:first-child{text-align:left}' +
      '.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}' +
      '.tag.skipped{background:#f1e0df;color:#8a3c34}.tag.review{background:#fdf0d5;color:#8a6300}' +
      '</style></head><body><div class="wrap">' +
      '<h1>Built chronology report</h1><p class="sub">Generated ' + e(dt) + '</p>' +
      '<div class="statement">' + dateStmt + '<br>' + spanLine + '</div>' +
      '<h2>Members (' + members.length + ')</h2>' +
      '<table><thead>' + memHead + '</thead><tbody>' + memRows + '</tbody></table>' +
      saSection +
      '<h2>Chronology statistics</h2><table><tbody>' + statsRows + '</tbody></table>' +
      diagSections +
      '</div></body></html>';
  }

  // ---- session save / restore ----------------------------------------------
  // Serialize the whole analysis session to a JSON-able object so a browser-only
  // user can leave and come back. Frames are already plain { names, cols }.
  function serializeFrame(f) {
    if (!f || !f.names || !f.cols) return null;
    return { names: f.names.slice(), cols: f.cols.map(function (c) { return c.slice(); }) };
  }
  function serializeSession(o) {
    o = o || {};
    var out = {
      version: 2,
      meta: { undatedName: o.undatedName || null, chronName: o.chronName || null },
      seriesMeta: o.seriesMeta || {},           // per-series metadata side-channel (src/io/meta.js)
      undated: serializeFrame(o.undated),
      chron: serializeFrame(o.chron),
      detrend: detrendOptions(o.detrend),
      builder: null
    };
    if (o.builder) {
      var st = o.builder.state();
      var d = o.builder.datum ? o.builder.datum() : null;
      out.builder = {
        members: (st.members || []).map(function (m) { return { id: m.id, lag: m.lag, note: m.note || '' }; }),
        setAside: (st.setAside || []).map(function (x) { return { id: x.id, status: x.status, note: x.note || '' }; }),
        // Only persist an explicit ring-pin datum; a 'chronology' datum is
        // re-established automatically when the session reloads the chronology.
        datum: (d && d.seriesId) ? { seriesId: d.seriesId, edge: d.edge, year: d.year } : null
      };
    }
    return out;
  }
  // Rebuild + deterministically replay a serialized session. Replay is exact:
  // re-anchoring on members[0] then approving each subsequent member at its saved
  // lag reproduces the working set; notes + dispositions + datum are re-applied.
  function restoreSession(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Not a session object.');
    if (obj.version !== 1 && obj.version !== 2) throw new Error('Unsupported session version: ' + obj.version);
    if (!obj.undated || !obj.undated.names) throw new Error('Session is missing undated data.');
    var undated = obj.undated, chron = obj.chron || null, detrend = detrendOptions(obj.detrend);
    var builder = RD.createBuilder({ undated: undated, chron: chron, detrend: detrend });
    var B = obj.builder;
    if (B && B.members) {
      var seeded = {};                                    // members already present (loaded chronology)
      builder.state().members.forEach(function (m) { seeded[m.id] = true; });
      B.members.forEach(function (m) {
        if (!seeded[m.id]) {
          if (builder.state().members.length === 0) builder.setAnchor(m.id);   // first member = anchor
          else builder.approve(m.id, m.lag);                                   // subsequent = approve at saved lag
        }
        if (m.note) builder.setNote(m.id, m.note);
      });
    }
    if (B && B.setAside) {
      B.setAside.forEach(function (x) {
        if (x.status === 'review') builder.flagReview(x.id, x.note || '');
        else builder.skip(x.id, x.note || '');
      });
    }
    if (B && B.datum && B.datum.seriesId) builder.setDatum({ seriesId: B.datum.seriesId, edge: B.datum.edge, year: B.datum.year });
    return { undated: undated, chron: chron, detrend: detrend, builder: builder, seriesMeta: obj.seriesMeta || {} };
  }

  // ---- downloads + report --------------------------------------------------
  function downloads(result, opts) {
    return RD.buildDownloads(result, opts || {});
  }
  function report(result, opts) {
    opts = opts || {};
    var chrono = !!opts.chrono;
    var settings = opts.settings || {};
    var probWind = settings.probs != null ? Number(settings.probs) : 30;
    var rbarWindow = settings.rbarWindow != null ? Number(settings.rbarWindow) : 30;

    // Recompute the diagnostics at GENERATE time from result.aligned so the
    // Report-tab windows take effect WITHOUT re-running the analysis. Both
    // RD.probCheck / RD.rBarEps throw on short/thin chronologies — guard each.
    var probCheck = result.probCheck || null;
    var rBarEps = null;
    if (result.aligned) {
      try { probCheck = RD.probCheck(result.aligned, { wind: probWind }); }
      catch (err) { probCheck = { message: 'Problem check unavailable (try a smaller window).', samples: [], intervals: [] }; }
      try { rBarEps = RD.rBarEps(result.aligned, { window: rbarWindow }); }
      catch (err) { rBarEps = null; }
    }

    var state = {
      files: opts.files || {},
      detrend: result.detrendOpts || {},
      settings: settings,
      correlReplace: opts.correlReplace || null,
      probCheck: probCheck,
      rBarEps: rBarEps,
      plots: opts.plots || null
    };
    return RD.renderReport(state, { chrono: chrono, date: opts.date });
  }

  return {
    RD: RD,
    DETREND_METHODS: DETREND_METHODS,
    COLOR_SCALES: COLOR_SCALES,
    SUPPORTED_EXT: SUPPORTED_EXT,
    ext: ext, isXlsx: isXlsx, isTridas: isTridas, isSupportedUpload: isSupportedUpload,
    loadUndated: loadUndated, loadChron: loadChron, seriesNames: seriesNames,
    loadTridas: loadTridas, bindUndated: bindUndated, bindDated: bindDated,
    slidingSegmentAnalysis: slidingSegmentAnalysis, ringTest: ringTest,
    diagnoseSegments: diagnoseSegments, fullSeriesLag: fullSeriesLag,
    CONSENSUS: CONSENSUS, consensusFromRows: consensusFromRows, statsAtLag: statsAtLag,
    slidingSelectPairwise: slidingSelectPairwise, slidingSelectVsReference: slidingSelectVsReference,
    compositeChron: compositeChron,
    ensureMeta: RD.ensureMeta, META_EDITABLE: RD.META_EDITABLE,
    detrendOptions: detrendOptions, detectDetrended: detectDetrended,
    runAnalysis: runAnalysis, analysisRunner: analysisRunner,
    crossDatTable: crossDatTable, frameToTable: frameToTable, refilter: refilter,
    fmtCell: fmtCell,
    buildPlots: buildPlots, renderPlot: renderPlot, combinedPlot: combinedPlot,
    bestLagFor: bestLagFor,
    scannedLagSpan: scannedLagSpan,
    fmtP: fmtP,
    newBuilder: newBuilder, builderReview: builderReview, builderPlots: builderPlots,
    builderChronPlot: builderChronPlot, builderDownloads: builderDownloads,
    downloadName: downloadName,
    builderTridasDownloads: builderTridasDownloads,
    builderReport: builderReport,
    serializeSession: serializeSession, restoreSession: restoreSession,
    downloads: downloads, report: report
  };
});
