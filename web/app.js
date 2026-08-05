/* ============================================================================
 * app.js — thin DOM wiring for the RingdateR web frontend. All non-trivial logic
 * lives in appCore.js (window.AppCore); this file only reads inputs, calls
 * AppCore, and paints the DOM. Keep it dumb.
 *
 * Structure: a view router (Home / Explore / Build) + named actions collected on
 * an internal Actions object, published as window.AppUI so the guided tour
 * (tour.js) — and the console — can drive the app through the same code paths
 * as the buttons.
 * ==========================================================================*/
(function () {
  'use strict';
  var AC = window.AppCore;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function setMsg(el, text, kind) { el = $(el); el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }

  // ---- app state -----------------------------------------------------------
  var state = {
    undated: null, chron: null,
    undatedName: null, chronName: null,
    detrend: null,         // detrend UI object the current builder was created with (for session save)
    result: null,          // last workflow result
    filteredTable: null,   // current (possibly re-filtered) crossDatRes Frame
    selectedPair: null,    // [s1, s2]
    builder: null,         // RD.createBuilder instance (Build view)
    review: null           // cached crossdate review ({suggestions, cn, masterLeadLag, ...})
  };

  var Actions = {};        // named UI actions; published as window.AppUI below

  // ---- view router ---------------------------------------------------------
  var currentView = 'home';
  function syncNav() {
    var bb = document.querySelector('nav.tabs button[data-view="build"]');
    if (bb) bb.disabled = !(state.undated || hasAutosave());
  }
  function showView(name) {
    document.querySelectorAll('.tabpage').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.remove('active'); });
    var page = $('view-' + name); if (page) page.classList.add('active');
    var btn = document.querySelector('nav.tabs button[data-view="' + name + '"]'); if (btn) btn.classList.add('active');
    currentView = name;
    closeExport();
    if (name === 'build') renderBuild();
  }
  Actions.showView = showView;
  document.querySelectorAll('nav.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { if (!b.disabled) showView(b.getAttribute('data-view')); });
  });

  // ---- populate static option dropdowns ------------------------------------
  function fillSelect(el, items, val, lab) {
    el.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = val(it); o.textContent = lab(it);
      el.appendChild(o);
    });
  }
  fillSelect($('detrending_select'), AC.DETREND_METHODS, function (m) { return m.value; }, function (m) { return m.label; });
  $('detrending_select').value = '3';
  fillSelect($('p_colscale'), AC.COLOR_SCALES, function (m) { return m.value; }, function (m) { return m.label; });

  // Target series is the reference the pairwise run aligns to; chronology mode
  // always uses the mean chronology, so hide the control there.
  function syncModeUI() {
    var chronoMode = Number($('mode_select').value) === 2;
    $('targetField').style.display = chronoMode ? 'none' : '';
    // Contextual chronology loader: only in chronology mode with none loaded.
    $('modeChronPrompt').style.display = (chronoMode && !state.chron) ? '' : 'none';
  }
  $('mode_select').addEventListener('change', syncModeUI);
  syncModeUI();

  // ---- read UI option objects ----------------------------------------------
  function detrendUI() {
    return {
      detrending_select: $('detrending_select').value,
      splinewindow: $('splinewindow').value,
      ARmod: $('ARmod').checked,
      logT: $('logT').checked
    };
  }
  function leadlagUI() {
    return {
      neg_lag: Number($('neg_lag').value) || -20,
      pos_lag: Number($('pos_lag').value) || 20,
      complete: $('total_overlap').checked
    };
  }

  // ---- data loading --------------------------------------------------------
  function readFilesAsText(fileList, cb) {
    var files = Array.prototype.slice.call(fileList);
    var out = [], pending = files.length, xlsxRejected = [];
    if (!pending) return cb([], []);
    files.forEach(function (f) {
      if (AC.isXlsx(f.name)) { xlsxRejected.push(f.name); if (--pending === 0) cb(out, xlsxRejected); return; }
      var rd = new FileReader();
      rd.onload = function () { out.push({ name: f.name, text: rd.result }); if (--pending === 0) cb(out, xlsxRejected); };
      rd.onerror = function () { if (--pending === 0) cb(out, xlsxRejected); };
      rd.readAsText(f);
    });
  }
  function xlsxWarn(names) {
    var w = $('xlsxWarn');
    if (names && names.length) {
      w.style.display = 'block';
      w.innerHTML = '<b>.xlsx not supported in the browser build.</b> ' + esc(names.join(', ')) +
        ' skipped — .xlsx reading needs a zlib shim. Please use CSV / TXT / RWL / .pos / .lps instead.';
    } else { w.style.display = 'none'; w.innerHTML = ''; }
  }

  // Home is the loader; the Explore rail shows a compact summary of what's
  // loaded. Both repaint from the same state, and the requirement chips update.
  function renderDataInfo() {
    var un = state.undated ? AC.seriesNames(state.undated) : [];
    // rail: compact status lines
    $('undatedInfo').innerHTML = state.undated
      ? '<p class="msg ok">' + un.length + ' undated series loaded.</p>'
      : '<p class="hint">No undated series loaded.</p>';
    $('chronInfo').innerHTML = state.chron
      ? '<p class="msg ok">Chronology: ' + AC.seriesNames(state.chron).length + ' members.</p>'
      : '<p class="hint">No chronology loaded.</p>';
  }
  function loadUndatedFiles(fileList, msgId) {
    readFilesAsText(fileList, function (descriptors, xlsx) {
      xlsxWarn(xlsx);
      if (xlsx.length && msgId) setMsg(msgId, '.xlsx files skipped — see the warning above.', 'err');
      if (!descriptors.length) { renderDataInfo(); return; }
      try {
        state.undated = AC.loadUndated(descriptors);
        state.undatedName = descriptors.map(function (d) { return d.name; }).join(', ');
        renderDataInfo();
        onDataChanged();
        if (msgId) setMsg(msgId, 'Loaded ' + AC.seriesNames(state.undated).length + ' undated series.', 'ok');
      } catch (err) {
        if (msgId) setMsg(msgId, err.message, 'err');
        $('undatedInfo').innerHTML = '<p class="msg err">' + esc(err.message) + '</p>';
      }
    });
  }
  function loadChronFile(fileList, msgId, cb) {
    readFilesAsText(fileList, function (descriptors, xlsx) {
      xlsxWarn(xlsx);
      if (!descriptors.length) { renderDataInfo(); return; }
      try {
        state.chron = AC.loadChron(descriptors[0]);
        state.chronName = descriptors[0].name;
        // A loaded chronology is almost always there to be crossdated against —
        // default the Explore analysis mode to chronology mode.
        $('mode_select').value = '2';
        renderDataInfo();
        onDataChanged();
        if (msgId) setMsg(msgId, 'Loaded chronology ' + state.chronName + '.', 'ok');
        if (cb) cb(true);
      } catch (err) {
        if (msgId) setMsg(msgId, err.message, 'err');
        $('chronInfo').innerHTML = '<p class="msg err">' + esc(err.message) + '</p>';
        if (cb) cb(false);
      }
    });
  }
  // Data is loaded through the per-task setup step (below); the rail's
  // contextual chronology loader is the one exception (chronology mode with
  // none loaded).
  $('setupUndatedInput').addEventListener('change', function (e) { loadUndatedFiles(e.target.files, 'startMsg'); });
  $('setupChronInput').addEventListener('change', function (e) { loadChronFile(e.target.files, 'startMsg'); });
  $('modeChronInput').addEventListener('change', function (e) {
    loadChronFile(e.target.files, 'runMsg', function () { e.target.value = ''; });
  });
  $('railManageBtn').addEventListener('click', function () { openTaskSetup('explore'); });
  $('exploreLoadBtn').addEventListener('click', function () { openTaskSetup('explore'); });

  // ---- example data --------------------------------------------------------
  Actions.loadExample = function () {
    try {
      state.undated = AC.loadUndated([window.RD_EXAMPLE]);
      state.undatedName = window.RD_EXAMPLE.name;
      state.chron = null; state.chronName = null;
      setMsg('startMsg', 'Example data loaded — ' + AC.seriesNames(state.undated).length + ' undated series.', 'ok');
      renderDataInfo();
      onDataChanged();
      return true;
    } catch (err) { setMsg('startMsg', err.message, 'err'); return false; }
  };
  // Tour helper: make sure the example data is loaded, confirming before it
  // replaces data the user loaded themselves.
  Actions.usingExampleData = function () { return !!state.undated && state.undatedName === window.RD_EXAMPLE.name; };
  Actions.ensureExampleData = function () {
    if (Actions.usingExampleData()) return true;
    if (state.undated && !window.confirm('The tour uses the bundled example data, replacing the data you loaded. Continue?')) return false;
    return Actions.loadExample();
  };
  $('setupExampleBtn').addEventListener('click', Actions.loadExample);

  function onDataChanged() {
    var names = state.undated ? AC.seriesNames(state.undated) : [];
    fillSelect($('target_select'), names, function (n) { return n; }, function (n) { return n; });
    $('statusBar').textContent = state.undated
      ? (names.length + ' undated series' + (state.chron ? ' + chronology' : '') + ' loaded')
      : 'No data loaded';
    $('runBtn').disabled = !state.undated;
    // Header Clear + Export appear only once there's data to act on.
    document.querySelector('.header-actions').style.display = state.undated ? '' : 'none';
    syncModeUI();
    refreshSetup();
    if (!state.result) updateExploreEmpty();
    syncNav();
  }

  Actions.clearAll = function () {
    state = { undated: null, chron: null, undatedName: null, chronName: null, detrend: null, result: null, filteredTable: null, selectedPair: null, builder: null, review: null };
    $('setupUndatedInput').value = ''; $('setupChronInput').value = '';
    xlsxWarn([]);
    resetBuildUI();
    renderDataInfo();
    setMsg('runMsg', ''); setMsg('startMsg', '');
    showExploreResults(false);
    onDataChanged(); syncResumeBanners();
  };
  // Clear from the rail or the header; confirm only when real work would be lost.
  Actions.clearConfirmed = function () {
    var risky = (state.builder && state.builder.state().members.length) || state.result;
    if (risky && !window.confirm('Clear all loaded data, results and the current chronology session?')) return;
    Actions.clearAll();
    closeTaskSetup();
    showView('home');
  };
  $('clearBtn').addEventListener('click', Actions.clearConfirmed);
  $('headerClearBtn').addEventListener('click', Actions.clearConfirmed);

  // ---- explore: empty state vs results -------------------------------------
  function showExploreResults(on) {
    $('exploreEmpty').style.display = on ? 'none' : '';
    $('exploreResults').style.display = on ? '' : 'none';
    $('explorePlots').style.display = on ? '' : 'none';
    if (!on) updateExploreEmpty();
  }
  // The empty panel is data-aware: "no data" before anything is loaded, and a
  // "ready to run" prompt once undated series are present but no run has happened.
  function updateExploreEmpty() {
    var loaded = !!state.undated;
    $('exploreEmptyNoData').style.display = loaded ? 'none' : '';
    $('exploreEmptyReady').style.display = loaded ? '' : 'none';
    if (loaded) {
      $('exploreReadyMsg').innerHTML = AC.seriesNames(state.undated).length + ' undated series loaded' +
        (state.chron ? ' + a chronology' : '') +
        '. Choose a detrending method and analysis mode in the settings rail, then <b>Run analysis</b> — the results table and plots appear here.';
    }
  }

  // rail collapse
  $('railToggle').addEventListener('click', function () {
    var ws = $('exploreWorkspace');
    var collapsed = ws.classList.toggle('rail-collapsed');
    $('railToggle').textContent = collapsed ? '⟩' : '⟨';
    $('railToggle').title = collapsed ? 'Expand settings' : 'Collapse settings';
  });

  // ---- run analysis --------------------------------------------------------
  Actions.runAnalysis = function (done) {
    if (!state.undated) { setMsg('runMsg', 'Load undated data first.', 'err'); return; }
    var mode = Number($('mode_select').value);
    if (mode === 2 && !state.chron) { setMsg('runMsg', 'Chronology mode needs a loaded chronology (Data section above).', 'err'); return; }
    var target = $('target_select').value || AC.seriesNames(state.undated)[0];
    setMsg('runMsg', 'Running analysis…');
    setTimeout(function () {
      try {
        state.result = AC.runAnalysis({
          mode: mode,
          undated: state.undated, chron: state.chron,
          detrend: detrendUI(),
          leadlag: leadlagUI(),
          filter: {
            r_val: 0.5, p_val: 0.05, overlap: 30,
            target: mode === 2 ? 'mean_chronology' : target
          },
          probWind: Number($('rep_probs').value) || 30,
          rbarWindow: Number($('rep_eps').value) || 30
        });
        state.filteredTable = state.result.crossDatRes;
        state.selectedPair = null;
        setMsg('runMsg', 'Analysis complete (' + (mode === 2 ? 'chronology' : 'pairwise') + ' mode). ' +
          state.result.crossDatRes.cols[0].length + ' result rows; ' +
          (state.result.aligned.names.length - 1) + ' aligned series.', 'ok');
        setupResultControls();
        showExploreResults(true);
        renderPlots();
        if (done) done(true);
      } catch (err) { setMsg('runMsg', 'Error: ' + err.message, 'err'); if (done) done(false); }
    }, 20);
  };
  $('runBtn').addEventListener('click', function () { Actions.runAnalysis(); });

  // ---- results table -------------------------------------------------------
  function setupResultControls() {
    var mode = state.result.mode;
    $('resModeBadge').innerHTML = '<span class="pill mode' + mode + '">' + (mode === 2 ? 'Chronology' : 'Pairwise') + ' mode</span>';
    var names = mode === 2 ? ['mean_chronology'].concat(AC.seriesNames(state.undated)) : AC.seriesNames(state.undated);
    fillSelect($('f_target'), names, function (n) { return n; }, function (n) { return n; });
    $('f_target').value = state.result.target;
    // Plot series selectors from the comparison frame: mode 2 (chronology) compares
    // each undated series to the mean chronology, so list [mean_chronology, ...undated];
    // mode 1 (pairwise) lists the aligned series. (Picking from `aligned` in mode 2
    // gives the dated members, which aren't valid for the vs-chronology plots.)
    var compFrame = mode === 2 ? state.result.chronNSeries : state.result.aligned;
    var an = compFrame.names.slice(1);
    fillSelect($('p_series1'), an, function (n) { return n; }, function (n) { return n; });
    fillSelect($('p_series2'), an, function (n) { return n; }, function (n) { return n; });
    if (mode === 2) { $('p_series1').value = state.result.target; if (an[1]) $('p_series2').value = an[1]; }
    else if (an[1]) $('p_series2').value = an[1];
    $('p_lag').value = AC.bestLagFor(state.result, $('p_series1').value, $('p_series2').value);
    fillSelect($('detrendSeriesSel'), AC.seriesNames(state.undated), function (n) { return n; }, function (n) { return n; });
    renderResults();
  }
  ['f_r', 'f_p', 'f_overlap', 'f_target', 'f_apply'].forEach(function (id) {
    $(id).addEventListener('change', renderResults);
  });
  function renderResults() {
    if (!state.result) return;
    var frame = state.result.crossDatRes;
    if ($('f_apply').checked) {
      try {
        frame = AC.refilter(state.result.crossDatRes, {
          r_val: Number($('f_r').value), p_val: Number($('f_p').value),
          overlap: Number($('f_overlap').value), target: $('f_target').value
        });
        setMsg('resMsg', frame.cols[0].length + ' rows pass the filter.', 'ok');
      } catch (err) { setMsg('resMsg', 'Filter error: ' + err.message, 'err'); return; }
    } else { setMsg('resMsg', 'Showing full crossDatRes (' + frame.cols[0].length + ' rows).'); }
    state.filteredTable = frame;
    paintTable(AC.crossDatTable(frame));
  }
  function paintTable(tbl) {
    var thead = $('resTable').querySelector('thead');
    var tbody = $('resTable').querySelector('tbody');
    // Display tweaks (headers/frame stay underscored for the engine + exports):
    // hide the internal "col" column and show column names without underscores.
    var dropIdx = tbl.columns.findIndex(function (c) { return String(c).toLowerCase() === 'col'; });
    var keep = function (arr) { return dropIdx < 0 ? arr : arr.filter(function (_, i) { return i !== dropIdx; }); };
    var pretty = function (c) { return String(c).replace(/_/g, ' '); };
    var span = keep(tbl.columns).length;
    thead.innerHTML = '<tr>' + keep(tbl.columns).map(function (c) { return '<th>' + esc(pretty(c)) + '</th>'; }).join('') + '</tr>';
    tbody.innerHTML = '';
    tbl.rows.forEach(function (row) {
      var s1 = row[0], s2 = row[1];       // Series_1 / Series_2 stay at indices 0,1 ("col" is later)
      var isSep = row.every(function (c) { return c === ''; });
      var tr = document.createElement('tr');
      if (isSep) { tr.className = 'sep'; tr.innerHTML = '<td colspan="' + span + '"></td>'; tbody.appendChild(tr); return; }
      tr.innerHTML = keep(row).map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('');
      if (s1 && s2 && s1 !== s2) {
        tr.addEventListener('click', function () {
          tbody.querySelectorAll('tr').forEach(function (x) { x.classList.remove('sel'); });
          tr.classList.add('sel');
          Actions.selectPair(s1, s2);
        });
      }
      tbody.appendChild(tr);
    });
  }

  // Select a pair and render its plots in place (no tab hop).
  Actions.selectPair = function (s1, s2) {
    if (!state.result) return;
    state.selectedPair = [s1, s2];
    if ($('p_series1')) $('p_series1').value = s1;
    if ($('p_series2') && Array.prototype.some.call($('p_series2').options, function (o) { return o.value === s2; })) $('p_series2').value = s2;
    $('p_lag').value = AC.bestLagFor(state.result, s1, s2);
    renderPlots();
    $('explorePlots').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  // First selectable pair in the painted table (tour fallback for "click a row").
  // Skips separator rows and diagonal self-pairs (s1 === s2), which carry no
  // click handler.
  Actions.selectFirstPair = function () {
    var rows = $('resTable').querySelectorAll('tbody tr:not(.sep)');
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].cells;
      if (c.length >= 2 && c[0].textContent && c[0].textContent !== c[1].textContent) { rows[i].click(); return; }
    }
  };

  // ---- plots ---------------------------------------------------------------
  // Auto-render whenever any plot control changes (no explicit Render button).
  // Changing the PAIR resets the line-plot lag to that pair's best crossdate lag
  // (so the line plot defaults to the match, matching the heatmap); a manual lag
  // edit is respected until the pair changes again.
  ['p_series1', 'p_series2'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (state.result) $('p_lag').value = AC.bestLagFor(state.result, $('p_series1').value, $('p_series2').value);
      renderPlots();
    });
  });
  ['p_colscale', 'detrendSeriesSel'].forEach(function (id) {
    $(id).addEventListener('change', renderPlots);
  });
  $('p_which').addEventListener('change', function () { syncPlotControls(); renderPlots(); });
  $('p_lag').addEventListener('input', renderPlots);

  Actions.setPlotType = function (which) {
    $('p_which').value = which;
    syncPlotControls();
    renderPlots();
  };
  // The detrend diagnostic picks a single raw series; the pairwise plots pick a
  // pair — toggle the matching controls.
  function syncPlotControls() {
    var isDetrend = $('p_which').value === 'detrend';
    document.querySelectorAll('#explorePlots .pairCtl').forEach(function (d) { d.style.display = isDetrend ? 'none' : ''; });
    $('detrendCtl').style.display = isDetrend ? '' : 'none';
  }
  function renderPlots() {
    if (!state.result) return;
    var which = $('p_which').value;
    var area = $('plotArea');

    if (which === 'detrend') {
      var series = $('detrendSeriesSel').value || AC.seriesNames(state.undated)[0];
      var dspec = AC.buildPlots(state.result, { detrendSeries: series }).detrend;
      area.innerHTML = dspec ? AC.renderPlot(dspec)
        : '<p class="msg err">Could not build the detrending plot for this series.</p>';
      setMsg('plotMsg', dspec ? 'Detrending diagnostic for ' + series + ' — raw + fitted curve, detrended series, autocorrelation.' : '', dspec ? 'ok' : '');
      return;
    }

    var pair = [$('p_series1').value, $('p_series2').value];
    var plots = AC.buildPlots(state.result, {
      pair: pair, lag: Number($('p_lag').value) || 0, colorScale: $('p_colscale').value,
      corWin: Number($('cor_win').value) || 21
    });
    area.innerHTML = '';
    var vs = pair[0] + ' vs ' + pair[1];
    var zoomHint = ' Scroll = zoom time (x); Shift+scroll = zoom width (y); Ctrl+scroll = both; drag = pan; double-click = reset.';

    // The line plot (first plot / crossdate overlay) is interactive: data-domain
    // zoom + pan with crisp, regenerating axes. Other plots stay static.
    if (which === 'line') {
      if (!plots.line) { setMsg('plotMsg', 'Line plot could not be built for ' + vs + '.', 'err'); return; }
      PlotZoom.attachDataZoom(area, plots.line, AC.RD.renderSvg);
      setMsg('plotMsg', 'Line plot for ' + vs + '.' + zoomHint, 'ok');
      return;
    }
    if (which === 'combined') {
      var lineDiv = document.createElement('div');
      area.appendChild(lineDiv);
      if (plots.line) PlotZoom.attachDataZoom(lineDiv, plots.line, AC.RD.renderSvg);
      else lineDiv.innerHTML = '<p class="msg err">Line plot could not be built for ' + esc(vs) + '.</p>';
      var restSvg = AC.combinedPlot([plots.skeleton, plots.leadLagBar, plots.heatmap]);
      if (restSvg) { var restDiv = document.createElement('div'); restDiv.innerHTML = restSvg; area.appendChild(restDiv); }
      setMsg('plotMsg', 'Combined for ' + vs + '. The line plot zooms/pans —' + zoomHint, 'ok');
      return;
    }
    var svg = AC.renderPlot(plots[which]);
    if (!svg) { setMsg('plotMsg', 'That plot could not be built for the selected pair (insufficient overlap?).', 'err'); return; }
    area.innerHTML = svg;
    setMsg('plotMsg', 'Showing ' + which + ' for ' + vs + '.', 'ok');
  }

  // ---- home task cards + per-task setup step -------------------------------
  // Task-first flow: a card opens a setup step that collects ONLY the data that
  // task requires (reusing anything already loaded); Continue enters the
  // workspace. Learn needs no data and launches the tour directly.
  var TASK_SPECS = {
    explore: {
      title: 'Set up: Explore & crossdate',
      intro: 'Load the undated series you want to crossdate. A dated chronology is optional — you only need it for chronology mode.',
      slots: {
        undated: { show: true, required: true, order: 1, label: 'Undated series to crossdate' },
        chron: { show: true, required: false, order: 2, label: 'Dated chronology (optional — for chronology mode)' }
      },
      example: true,
      go: function () { showView('explore'); }
    },
    build: {
      title: 'Set up: Build a chronology',
      intro: "Load the undated series to build the chronology from. You'll pick an anchor series next.",
      slots: {
        undated: { show: true, required: true, order: 1, label: 'Undated series' },
        chron: { show: false }
      },
      example: true,
      go: function () { showView('build'); Actions.startBuilder(); }
    },
    extend: {
      title: 'Set up: Extend a chronology',
      intro: 'Load the dated chronology you want to extend, then the undated series to add to it.',
      slots: {
        chron: { show: true, required: true, order: 1, label: 'Chronology to extend' },
        undated: { show: true, required: true, order: 2, label: 'Undated series to add' }
      },
      example: false,
      go: function () { showView('build'); Actions.startBuilder(); }
    }
  };
  var currentTask = null;

  function configSlot(name, cfg) {
    var slot = $('slot' + name);
    if (!cfg || !cfg.show) { slot.style.display = 'none'; return; }
    slot.style.display = '';
    slot.style.order = cfg.order || 0;
    $('slot' + name + 'Label').textContent = cfg.label;
  }
  function slotSatisfied(name) { return name === 'Undated' ? !!state.undated : !!state.chron; }
  function refreshSetup() {
    if (!currentTask || $('taskSetup').style.display === 'none') return;
    var spec = TASK_SPECS[currentTask];
    var ready = true;
    ['Undated', 'Chron'].forEach(function (name) {
      var cfg = spec.slots[name.toLowerCase()];
      if (!cfg || !cfg.show) return;
      var ok = slotSatisfied(name);
      if (cfg.required && !ok) ready = false;
      var st = $('slot' + name + 'Status');
      if (ok) {
        var detail = name === 'Undated'
          ? AC.seriesNames(state.undated).length + ' series (' + esc(state.undatedName) + ')'
          : AC.seriesNames(state.chron).length + ' members (' + esc(state.chronName) + ')';
        st.innerHTML = '<span class="slot-ok">✓ Loaded: ' + detail + '</span>';
      } else {
        st.innerHTML = cfg.required ? '<span class="slot-need">Required</span>' : '<span class="slot-opt">Optional</span>';
      }
    });
    $('setupContinueBtn').disabled = !ready;
  }
  function openTaskSetup(key) {
    var spec = TASK_SPECS[key];
    if (!spec) return;
    currentTask = key;
    showView('home');
    $('homeChooser').style.display = 'none';
    $('taskSetup').style.display = '';
    $('setupTitle').textContent = spec.title;
    $('setupIntro').textContent = spec.intro;
    configSlot('Undated', spec.slots.undated);
    configSlot('Chron', spec.slots.chron);
    $('setupExample').style.display = spec.example ? '' : 'none';
    setMsg('startMsg', '');
    refreshSetup();
    $('taskSetup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  Actions.openTaskSetup = openTaskSetup;
  function closeTaskSetup() {
    currentTask = null;
    $('taskSetup').style.display = 'none';
    $('homeChooser').style.display = '';
  }

  $('exploreCardBtn').addEventListener('click', function () { openTaskSetup('explore'); });
  $('buildCardBtn').addEventListener('click', function () { openTaskSetup('build'); });
  $('extendCardBtn').addEventListener('click', function () { openTaskSetup('extend'); });
  $('setupBack').addEventListener('click', closeTaskSetup);
  $('setupContinueBtn').addEventListener('click', function () {
    if (!currentTask) return;
    var go = TASK_SPECS[currentTask].go;
    closeTaskSetup();
    go();
  });
  $('tourExploreBtn').addEventListener('click', function () { if (window.Tour) window.Tour.start('explore'); });
  $('tourBuildBtn').addEventListener('click', function () { if (window.Tour) window.Tour.start('build'); });

  // ---- build chronology ----------------------------------------------------
  // Interactive, one-series-at-a-time chronology building driven by RD.createBuilder
  // (via AppCore). The left panel shows the current members + mean/all-series plot
  // and grouped Date / Auto-build / Set-aside sections; the right panel picks a pool
  // candidate, crossdates it, shows the best-3 suggestions + three review plots,
  // and approves/skips it.
  function resetBuildUI() {
    $('buildPanels').style.display = 'none';
    $('anchorWrap').style.display = 'none';
    $('anchorBtnWrap').style.display = 'none';
    setMsg('buildMsg', ''); setMsg('candMsg', '');
    setMsg('dateStatus', ''); setMsg('autoBuildMsg', ''); setMsg('sessionMsg', '');
    $('setAsideList').innerHTML = '';
    $('buildBadge').innerHTML = '';
    clearReviewUI();
  }
  function clearReviewUI() {
    state.review = null;
    $('suggTable').innerHTML = '';
    $('candNote').value = '';
    $('reviewLine').innerHTML = ''; $('reviewSkel').innerHTML = ''; $('reviewHeat').innerHTML = ''; $('reviewBar').innerHTML = '';
    $('approveBtn').disabled = true;
  }
  // Entering the view: nothing auto-runs — the user clicks Start. But keep the
  // start button state honest when there is no data.
  function renderBuild() {
    $('buildStartBtn').disabled = !state.undated;
    syncResumeBanners();
    if (state.builder) refreshBuild();
  }

  Actions.startBuilder = function () {
    if (!state.undated) { setMsg('buildMsg', 'Load undated data first (Home or the Explore settings rail).', 'err'); return false; }
    try {
      state.detrend = detrendUI();
      state.builder = AC.newBuilder({ undated: state.undated, chron: state.chron, detrend: state.detrend });
      clearReviewUI();
      var st = state.builder.state();
      if (st.hasChronology) {
        $('anchorWrap').style.display = 'none'; $('anchorBtnWrap').style.display = 'none';
        setMsg('buildMsg', 'Builder seeded from the loaded chronology (' + st.members.length + ' members). Add series on the right.', 'ok');
        refreshBuild();
      } else {
        // no chronology: let the user pick a first anchor series from the pool.
        fillSelect($('anchorSel'), st.poolIds, function (n) { return n; }, function (n) { return n; });
        $('anchorWrap').style.display = ''; $('anchorBtnWrap').style.display = '';
        $('buildPanels').style.display = 'none';
        setMsg('buildMsg', 'No chronology loaded — pick an anchor series to seed the working set, then Set anchor.', 'ok');
      }
      syncResumeBanners();
      return true;
    } catch (err) { setMsg('buildMsg', 'Error: ' + err.message, 'err'); return false; }
  };
  $('buildStartBtn').addEventListener('click', function () { Actions.startBuilder(); });

  Actions.setAnchor = function (id) {
    if (!state.builder) return;
    id = id || $('anchorSel').value;
    try {
      state.builder.setAnchor(id);
      $('anchorSel').value = id;
      $('anchorWrap').style.display = 'none'; $('anchorBtnWrap').style.display = 'none';
      setMsg('buildMsg', 'Anchor set to ' + id + '. Now add series on the right.', 'ok');
      clearReviewUI();
      refreshBuild();
    } catch (err) { setMsg('buildMsg', 'Error: ' + err.message, 'err'); }
  };
  $('setAnchorBtn').addEventListener('click', function () { Actions.setAnchor(); });

  // Repaint both panels from the current builder state.
  function refreshBuild() {
    var b = state.builder; if (!b) return;
    var st = b.state();
    $('buildPanels').style.display = st.hasChronology ? '' : 'none';
    $('buildBadge').innerHTML = '<span class="pill mode1">' + st.members.length + ' members</span>';
    if (!st.hasChronology) return;

    var sum = b.summary();
    var dated = b.isDated();

    // dating status line (+ warning if a datum series was removed)
    if (st.datumInvalidated) {
      setMsg('dateStatus', 'Dating was cleared — the dated series was removed from the chronology. Re-apply a date below.', 'err');
    } else if (dated && sum.datum && sum.datum.source === 'chronology') {
      setMsg('dateStatus', 'Dated from the loaded chronology — spans ' + sum.span.firstYear + '–' + sum.span.lastYear +
        ' (calendar years). Pin a known ring below to re-date.', 'ok');
    } else if (dated && sum.datum) {
      setMsg('dateStatus', 'Dated: ' + sum.datum.seriesId + ' ' + sum.datum.edge + ' ring = ' + sum.datum.year +
        ' → chronology spans ' + sum.span.firstYear + '–' + sum.span.lastYear + '.', 'ok');
    } else {
      setMsg('dateStatus', 'Undated (floating). Positions ' + sum.span.firstPos + '–' + sum.span.lastPos + '.');
    }

    // summary + members table, span columns labelled calendar years when dated
    var span = dated ? (sum.span.firstYear + '–' + sum.span.lastYear + ' (cal. years)')
                     : (sum.span.firstPos + '–' + sum.span.lastPos + ' (positions)');
    $('buildSummary').textContent = st.members.length + ' member(s); span ' + span + '.';
    var mHead = dated ? '<th>First year</th><th>Last year</th>' : '<th>First pos</th><th>Last pos</th>';
    var tbody = sum.members.map(function (m) {
      var a = dated ? m.firstYear : m.firstPos, c = dated ? m.lastYear : m.lastPos;
      return '<tr data-id="' + esc(m.id) + '"><td>' + esc(m.id) + '</td><td>' + esc(String(m.lag)) +
        '</td><td>' + esc(a) + '</td><td>' + esc(c) +
        '</td><td><button class="btn ghost bld-remove" data-id="' + esc(m.id) + '">Remove</button></td></tr>';
    }).join('');
    $('memberList').innerHTML = '<table class="res"><thead><tr><th>Series</th><th>Lag</th>' + mHead +
      '<th></th></tr></thead><tbody>' + tbody + '</tbody></table>';
    $('memberList').querySelectorAll('.bld-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try { state.builder.remove(btn.getAttribute('data-id')); clearReviewUI(); refreshBuild(); }
        catch (err) { setMsg('buildMsg', 'Error: ' + err.message, 'err'); }
      });
    });

    // dating series picker (members only)
    var memberIds = st.members.map(function (m) { return m.id; });
    fillSelect($('dateSeriesSel'), memberIds, function (n) { return n; }, function (n) { return n; });
    if (sum.datum && sum.datum.seriesId) $('dateSeriesSel').value = sum.datum.seriesId;

    // set-aside table (id, status badge, editable note, Return to pool)
    renderSetAside(st.setAside);

    // mean / all-member-series plot
    var spec = AC.builderChronPlot(b.chronology());
    $('buildChronPlot').innerHTML = spec ? AC.renderPlot(spec) : '<p class="msg err">Not enough member series to plot yet.</p>';

    // candidate pool picker (skipped / review series are not in poolIds)
    fillSelect($('candSel'), st.poolIds, function (n) { return n; }, function (n) { return n; });
    if (!st.poolIds.length) { setMsg('candMsg', 'Pool is empty — no more candidates to add.', 'ok'); clearReviewUI(); }
    else { runCrossdate(); }   // auto-crossdate the selected candidate (no button)

    scheduleAutosave();
  }

  function renderSetAside(setAside) {
    if (!setAside || !setAside.length) { $('setAsideList').innerHTML = '<p class="hint" style="padding:8px">Nothing set aside.</p>'; return; }
    var rows = setAside.map(function (x) {
      return '<tr data-id="' + esc(x.id) + '"><td>' + esc(x.id) + '</td>' +
        '<td><span class="tag ' + (x.status === 'review' ? 'review' : 'skipped') + '">' + esc(x.status) + '</span></td>' +
        '<td><input type="text" class="sa-note" data-id="' + esc(x.id) + '" value="' + esc(x.note || '') + '"></td>' +
        '<td><button class="btn ghost sa-restore" data-id="' + esc(x.id) + '">Return to pool</button></td></tr>';
    }).join('');
    $('setAsideList').innerHTML = '<table class="res"><thead><tr><th>Series</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    $('setAsideList').querySelectorAll('.sa-note').forEach(function (inp) {
      inp.addEventListener('change', function () {
        try { state.builder.setNote(inp.getAttribute('data-id'), inp.value); scheduleAutosave(); }
        catch (err) { setMsg('buildMsg', 'Error: ' + err.message, 'err'); }
      });
    });
    $('setAsideList').querySelectorAll('.sa-restore').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try { state.builder.restore(btn.getAttribute('data-id')); clearReviewUI(); refreshBuild(); }
        catch (err) { setMsg('buildMsg', 'Error: ' + err.message, 'err'); }
      });
    });
  }

  // Crossdate the selected candidate and paint suggestions + review plots.
  function runCrossdate() {
    if (!state.builder) return;
    var id = $('candSel').value;
    if (!id) return;
    try {
      state.review = AC.builderReview(state.builder, id);
      var rv = state.review;
      paintSuggestions(rv.suggestions);
      $('candLag').value = rv.lag;
      $('approveBtn').disabled = false;
      renderReviewPlots(rv);
      setMsg('candMsg', 'Crossdated ' + id + ' — best lag ' + rv.bestLag + '. Review the plots, adjust the lag, then Approve.', 'ok');
    } catch (err) { clearReviewUI(); setMsg('candMsg', 'Error: ' + err.message, 'err'); }
  }
  // Auto-crossdate whenever the selected candidate changes (no Crossdate button).
  $('candSel').addEventListener('change', runCrossdate);
  Actions.selectCandidate = function (id) {
    if (!state.builder) return;
    if (id) $('candSel').value = id;
    runCrossdate();
  };

  function paintSuggestions(suggestions) {
    if (!suggestions || !suggestions.length) { $('suggTable').innerHTML = '<p class="msg err">No lag suggestions (insufficient overlap).</p>'; return; }
    var rank = ['Best', '2nd', '3rd'];
    var rows = suggestions.map(function (s, i) {
      return '<tr><td>' + esc(rank[i] || (i + 1)) + '</td><td>' + esc(String(s.lag)) + '</td><td>' +
        esc(AC.fmtCell(s.R)) + '</td><td>' + esc(AC.fmtP(s.P)) + '</td><td>' + esc(AC.fmtCell(s.overlap)) + '</td></tr>';
    }).join('');
    $('suggTable').innerHTML = '<table class="res"><thead><tr><th>Rank</th><th>Lag</th><th>R</th><th>P</th><th>Overlap</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Line (interactive data-zoom) + heatmap + lead-lag bar for the current review.
  function renderReviewPlots(specs) {
    if (specs.line) PlotZoom.attachDataZoom($('reviewLine'), specs.line, AC.RD.renderSvg);
    else $('reviewLine').innerHTML = '<p class="msg err">Line overlay unavailable for this alignment (thin overlap).</p>';
    $('reviewSkel').innerHTML = specs.skeleton ? AC.renderPlot(specs.skeleton) : '<p class="msg err">Skeleton plot unavailable (thin overlap).</p>';
    $('reviewHeat').innerHTML = specs.heatmap ? AC.renderPlot(specs.heatmap) : '<p class="msg err">Heatmap unavailable (thin overlap).</p>';
    $('reviewBar').innerHTML = specs.leadLagBar ? AC.renderPlot(specs.leadLagBar) : '<p class="msg err">Lead-lag bar unavailable.</p>';
  }

  // Changing the lag re-renders the line + heatmap from the cached crossdate
  // (cn + masterLeadLag) WITHOUT re-crossdating, so alternative alignments preview.
  $('candLag').addEventListener('input', function () {
    if (!state.review) return;
    var id = $('candSel').value;
    var L = Number($('candLag').value) || 0;
    renderReviewPlots(AC.builderPlots(state.review.cn, state.review.masterLeadLag, id, L));
  });

  Actions.approveCandidate = function () {
    if (!state.builder || !state.review) return;
    var id = $('candSel').value;
    var L = Number($('candLag').value) || 0;
    try {
      state.builder.approve(id, L);
      clearReviewUI();
      setMsg('candMsg', 'Added ' + id + ' at lag ' + L + '.', 'ok');
      refreshBuild();
    } catch (err) { setMsg('candMsg', 'Error: ' + err.message, 'err'); }
  };
  $('approveBtn').addEventListener('click', Actions.approveCandidate);
  // Skip / Needs-review move the candidate out of the pool with an optional note.
  function disposition(kind) {
    if (!state.builder) return;
    var id = $('candSel').value;
    if (!id) return;
    var note = $('candNote').value.trim();
    try {
      if (kind === 'review') state.builder.flagReview(id, note);
      else state.builder.skip(id, note);
      clearReviewUI();
      setMsg('candMsg', (kind === 'review' ? 'Flagged for review: ' : 'Skipped: ') + id + ' — moved to Set aside.', 'ok');
      refreshBuild();
    } catch (err) { setMsg('candMsg', 'Error: ' + err.message, 'err'); }
  }
  $('skipBtn').addEventListener('click', function () { disposition('skip'); });
  $('needsReviewBtn').addEventListener('click', function () { disposition('review'); });

  // ---- calendar dating -----------------------------------------------------
  $('applyDateBtn').addEventListener('click', function () {
    if (!state.builder) return;
    var seriesId = $('dateSeriesSel').value;
    var edge = $('dateEdgeSel').value;
    var year = Number($('dateYear').value);
    if (!seriesId) { setMsg('dateStatus', 'Pick a member series to date.', 'err'); return; }
    if (!Number.isFinite(year)) { setMsg('dateStatus', 'Enter a valid calendar year.', 'err'); return; }
    try {
      state.builder.setDatum({ seriesId: seriesId, edge: edge, year: year });
      refreshBuild();
    } catch (err) { setMsg('dateStatus', 'Error: ' + err.message, 'err'); }
  });

  // ---- auto-build ----------------------------------------------------------
  Actions.autoBuild = function () {
    if (!state.builder) { setMsg('autoBuildMsg', 'Start the builder first.', 'err'); return; }
    setMsg('autoBuildMsg', 'Auto-building…');
    setTimeout(function () {
      try {
        var res = state.builder.autoBuild({
          r_val: Number($('ab_r').value) || 0.5,
          p_val: Number($('ab_p').value) || 0.05,
          overlap: Number($('ab_overlap').value) || 30,
          neg_lag: leadlagUI().neg_lag, pos_lag: leadlagUI().pos_lag, complete: leadlagUI().complete
        });
        clearReviewUI();
        refreshBuild();
        var added = (res.added || []).length, notAdded = (res.notAdded || []).length;
        setMsg('autoBuildMsg', 'Added ' + added + ' series; ' + notAdded +
          ' did not pass — left in the pool for review.', 'ok');
      } catch (err) { setMsg('autoBuildMsg', 'Auto-build failed: ' + err.message, 'err'); }
    }, 20);
  };
  $('autoBuildBtn').addEventListener('click', Actions.autoBuild);

  // ---- export menu ---------------------------------------------------------
  // One header menu, scoped to what exists: the Explore section exports the last
  // analysis run; the Build section exports the built chronology. Each report
  // lives next to its own artifact, so the old "builder shadows the run report"
  // trap is gone.
  function builderHasMembers() { return !!(state.builder && state.builder.state().members.length); }
  function openReport(html, msgId) {
    var w = window.open('', '_blank');
    if (!w) { setMsg(msgId, 'Pop-up blocked — allow pop-ups to view the report.', 'err'); return false; }
    w.document.open(); w.document.write(html); w.document.close();
    setMsg(msgId, 'Report opened in a new tab.', 'ok');
    return true;
  }
  function triggerDownload(d) {
    var blob = new Blob([d.content], { type: d.mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = d.filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function dlItem(d, label) {
    var li = document.createElement('li');
    li.innerHTML = '<span><span class="fn">' + esc(d.filename) + '</span><br><span class="mime">' + esc(label) + ' · ' + esc(d.mime) + '</span></span>';
    var btn = document.createElement('button');
    btn.className = 'btn secondary'; btn.textContent = 'Download';
    btn.addEventListener('click', function () { triggerDownload(d); });
    li.appendChild(btn);
    return li;
  }
  function renderRunDownloads() {
    var pair = state.selectedPair || [state.result.aligned.names[1], state.result.aligned.names[2]];
    var plots = AC.buildPlots(state.result, { pair: pair });
    var specs = {
      pairwiseLinePlot: plots.line, pairwiseBarPlot: plots.leadLagBar,
      fullHeatmap: plots.heatmap, detrendedSeriesPlot: plots.detrend
    };
    var dls = AC.downloads(state.result, { plots: specs });
    var ul = $('dlList'); ul.innerHTML = '';
    Object.keys(dls).forEach(function (key) { ul.appendChild(dlItem(dls[key], key)); });
    if (!Object.keys(dls).length) ul.innerHTML = '<li>No downloadable artifacts for this run.</li>';
  }
  function renderBuildDownloads() {
    // Prefer the dated frame (col0 = calendar years) once a datum is set.
    var frame = state.builder.isDated() ? state.builder.datedChronology() : state.builder.exportChronology();
    var ul = $('buildDlList'); ul.innerHTML = '';
    if (!frame) { ul.innerHTML = '<li>Nothing to export yet.</li>'; return; }
    var dls = AC.builderDownloads(frame);
    ul.appendChild(dlItem(dls.chronologyCsv, 'chronology CSV'));
    ul.appendChild(dlItem(dls.chronologyRwl, 'chronology RWL (Tucson)'));
  }
  function renderExportPanel() {
    // On Home both sections show when they have content; in a workspace, that
    // workspace's section leads.
    var showRun = !!state.result && (currentView === 'explore' || currentView === 'home');
    var showBuild = builderHasMembers() && (currentView === 'build' || currentView === 'home');
    $('exportExplore').style.display = showRun ? '' : 'none';
    $('exportBuild').style.display = showBuild ? '' : 'none';
    $('exportEmpty').style.display = (showRun || showBuild) ? 'none' : '';
    setMsg('reportMsg', ''); setMsg('buildReportMsg', '');
    if (showRun) { try { renderRunDownloads(); } catch (err) { $('dlList').innerHTML = '<li>' + esc(err.message) + '</li>'; } }
    if (showBuild) { try { renderBuildDownloads(); } catch (err) { $('buildDlList').innerHTML = '<li>' + esc(err.message) + '</li>'; } }
  }
  Actions.openExport = function () { renderExportPanel(); $('exportPanel').hidden = false; };
  function closeExport() { $('exportPanel').hidden = true; }
  Actions.closeExport = closeExport;
  $('exportBtn').addEventListener('click', function () {
    if ($('exportPanel').hidden) Actions.openExport(); else closeExport();
  });
  document.addEventListener('click', function (e) {
    if (!$('exportPanel').hidden && !e.target.closest('.export')) closeExport();
  });

  // run report (Explore section of the export menu)
  $('reportBtn').addEventListener('click', function () {
    if (!state.result) { setMsg('reportMsg', 'Run an analysis first.', 'err'); return; }
    try {
      var html = AC.report(state.result, {
        chrono: state.result.mode === 2,
        files: { undated: state.undatedName, chrono: state.chronName },
        settings: { verbose: $('rep_verbose').checked, probs: Number($('rep_probs').value), rbarWindow: Number($('rep_eps').value) }
      });
      openReport(html, 'reportMsg');
    } catch (err) { setMsg('reportMsg', 'Error: ' + err.message, 'err'); }
  });
  // built-chronology report (Build section of the export menu)
  $('buildReportBtn').addEventListener('click', function () {
    if (!builderHasMembers()) { setMsg('buildReportMsg', 'Build a chronology first.', 'err'); return; }
    try {
      var html = AC.builderReport(state.builder, {
        date: new Date(),
        verbose: $('b_verbose').checked,
        probWind: Number($('b_probs').value),
        rbarWindow: Number($('b_eps').value)
      });
      openReport(html, 'buildReportMsg');
    } catch (err) { setMsg('buildReportMsg', 'Error: ' + err.message, 'err'); }
  });

  // ---- session save / restore ----------------------------------------------
  var AUTOSAVE_KEY = 'ringdater_autosave_v1';
  var autosaveTimer = null;
  function currentSession() {
    return AC.serializeSession({
      undated: state.undated, chron: state.chron,
      detrend: state.detrend || detrendUI(), builder: state.builder,
      undatedName: state.undatedName, chronName: state.chronName
    });
  }
  function scheduleAutosave() {
    if (!state.builder) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(currentSession())); } catch (e) { /* quota / disabled */ }
    }, 500);
  }
  function hasAutosave() {
    try { return !!localStorage.getItem(AUTOSAVE_KEY); } catch (e) { return false; }
  }
  // The resume banner appears on Home and in Build (same condition, shared class).
  function syncResumeBanners() {
    var show = !state.builder && hasAutosave();
    document.querySelectorAll('.resumeWrap').forEach(function (w) { w.style.display = show ? '' : 'none'; });
  }

  $('sessionSaveBtn').addEventListener('click', function () {
    if (!state.builder) { setMsg('sessionMsg', 'Nothing to save — start the builder first.', 'err'); return; }
    try {
      var json = JSON.stringify(currentSession(), null, 2);
      triggerDownload({ filename: 'ringdater_session_' + isoToday() + '.json', mime: 'application/json', content: json });
      setMsg('sessionMsg', 'Session saved.', 'ok');
    } catch (err) { setMsg('sessionMsg', 'Save error: ' + err.message, 'err'); }
  });

  $('sessionLoadInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { loadSessionText(rd.result, 'sessionMsg'); e.target.value = ''; };
    rd.onerror = function () { setMsg('sessionMsg', 'Could not read the session file.', 'err'); };
    rd.readAsText(f);
  });

  function loadSessionText(text, msgId) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (err) { setMsg(msgId, 'Not a valid session file (bad JSON).', 'err'); return; }
    try {
      var r = AC.restoreSession(obj);
      state.undated = r.undated; state.chron = r.chron; state.detrend = r.detrend; state.builder = r.builder;
      state.result = null; state.filteredTable = null; state.selectedPair = null;
      if (obj.meta) { state.undatedName = obj.meta.undatedName || 'session'; state.chronName = obj.meta.chronName || null; }
      showExploreResults(false);
      renderDataInfo(); onDataChanged();
      clearReviewUI();
      syncResumeBanners();
      setMsg('buildMsg', 'Session restored — ' + state.builder.state().members.length + ' members. Continue editing below.', 'ok');
      setMsg(msgId, 'Session loaded.', 'ok');
      showView('build');
    } catch (err) { setMsg(msgId, 'Restore failed: ' + err.message, 'err'); }
  }

  document.querySelectorAll('.resumeBtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      try { loadSessionText(localStorage.getItem(AUTOSAVE_KEY), 'sessionMsg'); }
      catch (err) { setMsg('sessionMsg', 'Could not resume: ' + err.message, 'err'); }
    });
  });
  document.querySelectorAll('.resumeDismiss').forEach(function (btn) {
    btn.addEventListener('click', function () {
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
      syncResumeBanners(); syncNav();
    });
  });
  function isoToday() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ---- tour hooks ----------------------------------------------------------
  Actions.hasData = function () { return !!state.undated; };
  Actions.hasResult = function () { return !!state.result; };
  Actions.hasBuilder = function () { return !!state.builder; };
  Actions.builderMemberCount = function () { return state.builder ? state.builder.state().members.length : 0; };

  // ---- boot ----------------------------------------------------------------
  window.AppUI = Actions;
  renderDataInfo();
  onDataChanged();
  showExploreResults(false);
  syncPlotControls();
  syncResumeBanners();
})();
