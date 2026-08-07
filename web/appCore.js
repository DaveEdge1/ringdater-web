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

  // ---- detrend / leadlag / filter option objects (from raw UI values) ------
  function detrendOptions(ui) {
    ui = ui || {};
    return {
      detrending_select: Number(ui.detrending_select != null ? ui.detrending_select : 3),
      splinewindow: Number(ui.splinewindow != null ? ui.splinewindow : 32),
      ARmod: !!ui.ARmod,
      logT: !!ui.logT
    };
  }

  // ---- run a full workflow -------------------------------------------------
  // opts: { mode(1|2), undated, chron?, detrend, leadlag, filter, probWind, rbarWindow }
  // Returns the workflow bundle, annotated with { mode, target, undated } so the
  // downloads / report / plot helpers are self-sufficient.
  function runAnalysis(opts) {
    var mode = Number(opts.mode) === 2 ? 2 : 1;
    var undated = opts.undated;
    if (!undated) throw new Error('No undated data loaded.');
    var names = seriesNames(undated);
    var filter = Object.assign({ r_val: 0.5, p_val: 0.05, overlap: 50 }, opts.filter || {});
    var detrend = detrendOptions(opts.detrend);
    var leadlag = opts.leadlag || { neg_lag: -20, pos_lag: 20, complete: true };
    var probWind = opts.probWind != null ? opts.probWind : 20;
    var rbarWindow = opts.rbarWindow != null ? opts.rbarWindow : 25;

    var result;
    if (mode === 2) {
      if (!opts.chron) throw new Error('Chronology mode needs a loaded chronology.');
      var target2 = filter.target || 'mean_chronology';
      result = RD.chronologyWorkflow({
        undated: undated, chron: opts.chron, detrend: detrend,
        leadlag: leadlag,
        filter: Object.assign({}, filter, { target: target2 }),
        probWind: probWind, rbarWindow: rbarWindow
      });
      result.target = target2;
    } else {
      var target1 = filter.target || names[0];
      result = RD.pairwiseWorkflow({
        undated: undated, detrend: detrend,
        leadlag: leadlag,
        filter: Object.assign({}, filter, { target: target1 }),
        probWind: probWind, rbarWindow: rbarWindow
      });
      result.target = target1;
    }
    result.mode = mode;
    result.undated = undated;
    result.detrendOpts = detrend;
    return result;
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
  // the pairwise results tab). Returns the filtered Frame (throws on bad target).
  function refilter(crossDatRes, filter) {
    return RD.filterCrossdates(crossDatRes, filter);
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

    var out = { line: null, skeleton: null, heatmap: null, leadLagBar: null, allSeries: null, detrend: null };

    out.line = safe(function () { return RD.linePlot(lineFrame, s1, s2, lag, { sel_col_pal: colScale }); });
    out.skeleton = safe(function () { return RD.skelPlot(skelFrame(compFrame, undated), s1, s2, lag, {}); });
    out.leadLagBar = safe(function () { return RD.leadLagBar(result.masterLeadLag, s1, s2); });
    out.allSeries = safe(function () { return RD.allSeries(aligned); });
    // heatmap: running lead-lag between the two series on the comparison frame,
    // with the lag (y) axis centered on the pair's best crossdate lag by default
    // (e.g. best lag 98 -> lag axis ~78..118) so the match band is visible.
    var hmCenter = o.heatmapCenter != null ? Number(o.heatmapCenter) : bestLagFor(result, s1, s2);
    var corWin = o.corWin != null ? Number(o.corWin) : 21;
    out.heatmap = safe(function () {
      var rll = RD.heatmapAnalysis(compFrame, {
        s1: s1, s2: s2, neg_lag: -20, pos_lag: 20, center: hmCenter, win: corWin, complete: false
      });
      return RD.heatmapPlot(rll, { s1: s1, s2: s2, sel_col_pal: colScale });
    });
    // detrend diagnostic on the raw (un-detrended) undated data
    var dSeries = o.detrendSeries || (undated && undated.names[1]);
    out.detrend = safe(function () {
      return RD.detrendPlot(undated, dSeries, {
        detrending_select: detrend.detrending_select,
        splinewindow: detrend.splinewindow,
        ARmod: detrend.ARmod, logT: detrend.logT
      });
    });
    return out;
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
  function newBuilder(o) {
    o = o || {};
    return RD.createBuilder({ undated: o.undated, chron: o.chron, detrend: detrendOptions(o.detrend) });
  }

  // Build the three review plot specs for candidate `id` at lag `lag` from an
  // already-run crossdate (cn + masterLeadLag). Each is safe()-wrapped and null
  // on thin overlap. leadLagBar is lag-independent; line + heatmap follow `lag`.
  // `rawUndated` (the un-detrended pool frame) feeds the skeleton plot its raw
  // ring widths — see skelFrame.
  function builderPlots(cn, masterLeadLag, id, lag, rawUndated) {
    var L = Number(lag) || 0;
    return {
      line: safe(function () { return RD.linePlot(cn, TARGET, id, L); }),
      skeleton: safe(function () { return RD.skelPlot(skelFrame(cn, rawUndated), TARGET, id, L, {}); }),
      heatmap: safe(function () {
        var rll = RD.heatmapAnalysis(cn, { s1: TARGET, s2: id, neg_lag: -20, pos_lag: 20, center: L, win: 21, complete: false });
        return RD.heatmapPlot(rll, { s1: TARGET, s2: id });
      }),
      leadLagBar: safe(function () { return RD.leadLagBar(masterLeadLag, TARGET, id); })
    };
  }

  // Crossdate `id` against the builder's current mean chronology and return the
  // best-3 suggestions plus the three review plot specs for the chosen lag
  // (defaults to the best suggestion when `lag` is null/NaN). cn + masterLeadLag
  // are returned so the host can rebuild the plots on a lag change WITHOUT
  // re-crossdating (see builderPlots).
  function builderReview(builder, id, lag, rawUndated) {
    var cx = builder.crossdate(id);
    var suggestions = cx.suggestions || [];
    var bestLag = suggestions.length ? Number(suggestions[0].lag) : 0;
    var L = (lag == null || isNaN(Number(lag))) ? bestLag : Number(lag);
    var plots = builderPlots(cx.cn, cx.masterLeadLag, id, L, rawUndated);
    return {
      suggestions: suggestions, cn: cx.cn, masterLeadLag: cx.masterLeadLag,
      bestLag: bestLag, lag: L,
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
  function builderDownloads(frame, date) {
    var dt = isoDate(date);
    return {
      chronologyCsv: { filename: 'built_chronology_' + dt + '.csv', mime: 'text/csv', content: RD.writeCsv(frame) },
      chronologyRwl: { filename: 'built_chronology_' + dt + '.rwl', mime: 'text/plain', content: RD.writeRwl(frame, {}) }
    };
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
      'h1{color:#006b3a;font-size:22px;margin:0 0 2px}h2{color:#006b3a;font-size:16px;margin:22px 0 6px}' +
      '.sub{color:#667;font-size:13px;margin:0 0 14px}.hint{color:#667;font-size:13px;margin:2px 0 8px}' +
      '.statement{background:#eef6ef;border:1px solid #cfe6d5;border-radius:6px;padding:10px 14px;margin:10px 0}' +
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
    loadTridas: loadTridas, bindUndated: bindUndated,
    ensureMeta: RD.ensureMeta, META_EDITABLE: RD.META_EDITABLE,
    detrendOptions: detrendOptions,
    runAnalysis: runAnalysis,
    crossDatTable: crossDatTable, frameToTable: frameToTable, refilter: refilter,
    fmtCell: fmtCell,
    buildPlots: buildPlots, renderPlot: renderPlot, combinedPlot: combinedPlot,
    bestLagFor: bestLagFor,
    fmtP: fmtP,
    newBuilder: newBuilder, builderReview: builderReview, builderPlots: builderPlots,
    builderChronPlot: builderChronPlot, builderDownloads: builderDownloads,
    builderTridasDownloads: builderTridasDownloads,
    builderReport: builderReport,
    serializeSession: serializeSession, restoreSession: restoreSession,
    downloads: downloads, report: report
  };
});
