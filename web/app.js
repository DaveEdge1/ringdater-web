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
    chrons: [],            // every loaded chronology: [{ name, frame }] (chron = the active one)
    chronChoice: null,     // Explore "compare against" pick: a chronology name or COMPOSITE
    undatedName: null, chronName: null,
    meta: {},              // per-series metadata keyed by column name (src/io/meta.js); rides beside the Frames
    tridasLinks: {},       // imported derivedSeries provenance: { chronColumn: [memberSeriesId...] }
    detrend: null,         // detrend UI object the current builder was created with (for session save)
    result: null,          // last workflow result
    filteredTable: null,   // current (possibly re-filtered) crossDatRes Frame
    selectedPair: null,    // [s1, s2]
    builder: null,         // RD.createBuilder instance (Build view)
    review: null           // cached crossdate review ({suggestions, cn, masterLeadLag, ...})
  };

  var Actions = {};        // named UI actions; published as window.AppUI below
  var COMPOSITE = '__composite__';   // chron_select value for the chronology composite

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
    // Contextual chronology controls: the "compare against" picker once
    // chronologies are loaded, the load prompt when none are, and an
    // Add-chronology button in either case.
    $('chronPickField').style.display = (chronoMode && state.chrons.length) ? '' : 'none';
    $('modeChronPrompt').style.display = (chronoMode && !state.chrons.length) ? '' : 'none';
    $('modeChronAdd').style.display = chronoMode ? '' : 'none';
    if (chronoMode && state.chrons.length) syncChronSelect();
  }
  // Populate the "compare against" picker: every loaded chronology by name,
  // plus the composite (mean of the detrended chronologies) when there are >=2.
  function syncChronSelect() {
    var items = state.chrons.map(function (c) { return { v: c.name, l: c.name }; });
    if (state.chrons.length >= 2) items.push({ v: COMPOSITE, l: 'Composite — mean of the detrended chronologies' });
    fillSelect($('chron_select'), items, function (it) { return it.v; }, function (it) { return it.l; });
    var want = state.chronChoice != null ? state.chronChoice : state.chronName;
    if (want != null && items.some(function (it) { return it.v === want; })) $('chron_select').value = want;
    state.chronChoice = $('chron_select').value;
  }
  $('chron_select').addEventListener('change', function () {
    state.chronChoice = $('chron_select').value;
    if (state.chronChoice !== COMPOSITE) {
      var c = chronByName(state.chronChoice);
      if (c) { state.chron = c.frame; state.chronName = c.name; }
    }
  });
  function chronByName(name) {
    for (var i = 0; i < state.chrons.length; i++) if (state.chrons[i].name === name) return state.chrons[i];
    return null;
  }
  // Register a loaded chronology: replace a same-name reload, else append;
  // it also becomes the ACTIVE chronology (state.chron — Build tab, sessions).
  function addChron(name, frame) {
    var existing = chronByName(name);
    if (existing) existing.frame = frame;
    else state.chrons.push({ name: name, frame: frame });
    state.chron = frame; state.chronName = name;
    if (state.chronChoice !== COMPOSITE) state.chronChoice = name;
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

  // The union of every loaded series name (undated pool + chronology members),
  // which is exactly the key set the metadata side-channel should cover.
  function allSeriesNames() {
    var out = state.undated ? AC.seriesNames(state.undated) : [];
    state.chrons.forEach(function (c) {
      AC.seriesNames(c.frame).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
    });
    return out;
  }
  // Keep state.meta in step with the loaded series: preserve existing entries
  // (imported TRiDaS fields / user edits), add empties for new series, drop stale.
  function refreshMeta() {
    state.meta = AC.ensureMeta(state.meta || {}, allSeriesNames());
  }

  // Per-series metadata table: read-only identity/dating/unit + EDITABLE taxon,
  // lab code, pith, bark, notes. Edits are captured by a delegated listener
  // (onMetaEdit) that writes straight to state.meta — no re-render, so text
  // inputs keep focus while typing. Dating/unit render "—" when unknown.
  function escA(s) { return esc(s).replace(/"/g, '&quot;'); }
  function txtInput(n, field, v) {
    return '<input class="sm-edit" data-series="' + escA(n) + '" data-field="' + field + '" value="' + escA(v == null ? '' : v) + '">';
  }
  function presenceSelect(n, field, v) {
    var cur = v === true ? 'present' : (v === false ? 'absent' : '');
    var opt = function (val, lab) { return '<option value="' + val + '"' + (val === cur ? ' selected' : '') + '>' + lab + '</option>'; };
    return '<select class="sm-edit" data-series="' + escA(n) + '" data-field="' + field + '">' +
      opt('', '—') + opt('present', 'present') + opt('absent', 'absent') + '</select>';
  }
  function seriesMetaTable(names) {
    if (!names.length) return '';
    var rows = names.map(function (n) {
      var m = (state.meta && state.meta[n]) || {};
      var dating = m.dated === 'absolute' && m.firstYearInternal != null
        ? esc(AC.RD.formatCal(m.firstYearInternal)) + ' start'
        : (m.dated || '—');
      return '<tr><td class="sm-name" title="' + escA(m.title || n) + '">' + esc(m.title || n) + '</td>' +
        '<td>' + txtInput(n, 'taxon', m.taxon) + '</td>' +
        '<td>' + dating + '</td>' +
        '<td>' + (m.unit == null || m.unit === '' ? '—' : esc(m.unit)) + '</td>' +
        '<td>' + txtInput(n, 'labCode', m.labCode) + '</td>' +
        '<td>' + presenceSelect(n, 'pith', m.pith) + '</td>' +
        '<td>' + presenceSelect(n, 'bark', m.bark) + '</td>' +
        '<td>' + txtInput(n, 'notes', m.notes) + '</td></tr>';
    }).join('');
    return '<details class="series-meta"><summary>' + names.length + ' series — details (editable)</summary>' +
      '<div class="sm-wrap"><table><thead><tr><th>Series</th><th>Taxon</th><th>Dating</th><th>Unit</th>' +
      '<th>Lab code</th><th>Pith</th><th>Bark</th><th>Notes</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></details>';
  }
  // Delegated editor: any .sm-edit control writes its field into state.meta.
  function onMetaEdit(e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('sm-edit')) return;
    var series = el.getAttribute('data-series'), field = el.getAttribute('data-field');
    if (!series || !field || !state.meta[series]) return;
    var v = el.value;
    if (field === 'pith' || field === 'bark') v = (v === '' ? null : (v === 'present'));
    else v = (v === '' ? null : v);
    state.meta[series][field] = v;
    scheduleAutosave();
  }
  document.addEventListener('input', onMetaEdit);
  document.addEventListener('change', onMetaEdit);

  // Home is the loader; the Explore rail shows a compact summary of what's
  // loaded. Both repaint from the same state, and the requirement chips update.
  function renderDataInfo() {
    refreshMeta();
    var un = state.undated ? AC.seriesNames(state.undated) : [];
    // rail: compact status lines + an expandable per-series metadata table
    $('undatedInfo').innerHTML = state.undated
      ? '<p class="msg ok">' + un.length + ' undated series loaded.</p>' + seriesMetaTable(un)
      : '<p class="hint">No undated series loaded.</p>';
    $('chronInfo').innerHTML = state.chrons.length
      ? state.chrons.map(function (c) {
          return '<p class="msg ok">Chronology ' + esc(c.name) + ': ' + AC.seriesNames(c.frame).length +
            ' members. <button class="btn ghost chron-remove" data-name="' + escA(c.name) + '">Remove</button></p>' +
            seriesMetaTable(AC.seriesNames(c.frame));
        }).join('')
      : '<p class="hint">No chronology loaded.</p>';
    $('chronInfo').querySelectorAll('.chron-remove').forEach(function (btn) {
      btn.addEventListener('click', function () { Actions.removeChron(btn.getAttribute('data-name')); });
    });
  }
  // Drop one loaded chronology; the active chronology falls back to the last
  // remaining one (or none).
  Actions.removeChron = function (name) {
    state.chrons = state.chrons.filter(function (c) { return c.name !== name; });
    if (state.chronName === name || !state.chrons.length) {
      var lastC = state.chrons[state.chrons.length - 1] || null;
      state.chron = lastC ? lastC.frame : null;
      state.chronName = lastC ? lastC.name : null;
    }
    if (state.chronChoice === name || (state.chronChoice === COMPOSITE && state.chrons.length < 2)) {
      state.chronChoice = state.chronName;
    }
    renderDataInfo();
    onDataChanged();
  };
  // Merge a TRiDaS ingest ({undated,chron,meta,links}) into state, auto-routing
  // its content to the pool / chronology slots. Returns a short summary string.
  function absorbTridas(t, nameLabel) {
    if (t.undated) state.undated = state.undated ? AC.bindUndated(state.undated, t.undated) : t.undated;
    if (t.chron) addChron(nameLabel, t.chron);
    state.meta = Object.assign({}, state.meta, t.meta);
    state.tridasLinks = Object.assign({}, state.tridasLinks, t.links || {});
    var parts = [];
    if (t.undated) parts.push(AC.seriesNames(t.undated).length + ' undated series');
    if (t.chron) parts.push(AC.seriesNames(t.chron).length + '-series chronology');
    return parts.join(' + ');
  }
  // opts (optional): { label, note } — label replaces the joined-filenames pool
  // name (e.g. a folder name), note is appended to the success message.
  function loadUndatedFiles(fileList, msgId, opts) {
    readFilesAsText(fileList, function (descriptors, xlsx) {
      xlsxWarn(xlsx);
      if (xlsx.length && msgId) setMsg(msgId, '.xlsx files skipped — see the warning above.', 'err');
      if (!descriptors.length) { renderDataInfo(); return; }
      var xmls = descriptors.filter(function (d) { return AC.isTridas(d.name); });
      var others = descriptors.filter(function (d) { return !AC.isTridas(d.name); });
      try {
        if (others.length) {
          state.undated = AC.loadUndated(others);
          state.undatedName = (opts && opts.label) || others.map(function (d) { return d.name; }).join(', ');
        }
        if (xmls.length) {
          var label = xmls.map(function (d) { return d.name; }).join(', ');
          absorbTridas(AC.loadTridas(xmls), label);
          if (!state.undatedName) state.undatedName = label;
          if (state.chron) $('mode_select').value = '2';   // a chronology arrived with the pool
        }
        renderDataInfo();
        onDataChanged();
        if (msgId) {
          var loadedMsg = 'Loaded ' + (state.undated ? AC.seriesNames(state.undated).length : 0) + ' undated series' + (state.chron ? ' + chronology' : '') + '.';
          if (opts && opts.note) loadedMsg += ' ' + opts.note;
          var warns = (state.undated && state.undated.warnings) || [];
          if (warns.length) setMsg(msgId, loadedMsg + ' ' + warns.join(' '), 'warn');
          else setMsg(msgId, loadedMsg, 'ok');
        }
      } catch (err) {
        if (msgId) setMsg(msgId, err.message, 'err');
        $('undatedInfo').innerHTML = '<p class="msg err">' + esc(err.message) + '</p>';
      }
    });
  }
  // Each selected file becomes its OWN chronology in state.chrons (reloading a
  // same-named file replaces it), so several can be compared in the Explore rail.
  function loadChronFile(fileList, msgId, cb) {
    readFilesAsText(fileList, function (descriptors, xlsx) {
      xlsxWarn(xlsx);
      if (!descriptors.length) { renderDataInfo(); return; }
      try {
        var warns = [];
        descriptors.forEach(function (d) {
          if (AC.isTridas(d.name)) {
            var t = AC.loadTridas([d]);
            // Chronology input: prefer the file's dated content; if it holds only
            // undated series, treat those as the chronology members.
            if (!t.chron && t.undated) { t = { undated: null, chron: t.undated, meta: t.meta, links: t.links }; }
            absorbTridas(t, d.name);
          } else {
            addChron(d.name, AC.loadChron(d));
          }
          warns = warns.concat((state.chron && state.chron.warnings) || []);
        });
        // A loaded chronology is almost always there to be crossdated against —
        // default the Explore analysis mode to chronology mode.
        $('mode_select').value = '2';
        renderDataInfo();
        onDataChanged();
        if (msgId) {
          var loaded = descriptors.length > 1
            ? 'Loaded ' + descriptors.length + ' chronologies (' + state.chrons.length + ' total).'
            : 'Loaded chronology ' + state.chronName + '.';
          if (warns.length) setMsg(msgId, loaded + ' ' + warns.join(' '), 'warn');
          else setMsg(msgId, loaded, 'ok');
        }
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
  // Folder loading: a webkitdirectory input returns every file in the tree
  // (recursively) and ignores `accept`, so filter to the undated formats here —
  // keeping .xlsx so the existing warning explains why those were skipped.
  var UNDATED_EXT = ['csv', 'txt', 'rwl', 'pos', 'lps', 'xml'];
  $('setupUndatedDirBtn').addEventListener('click', function () { $('setupUndatedDirInput').click(); });
  $('setupUndatedDirInput').addEventListener('change', function (e) {
    var all = Array.prototype.slice.call(e.target.files);
    var files = all.filter(function (f) {
      return f.name.charAt(0) !== '.' && (UNDATED_EXT.indexOf(AC.ext(f.name)) >= 0 || AC.isXlsx(f.name));
    });
    var folder = all.length && all[0].webkitRelativePath ? all[0].webkitRelativePath.split('/')[0] : '';
    e.target.value = '';   // so re-picking the same folder fires change again
    if (!files.length) {
      setMsg('startMsg', 'No data files (.csv, .txt, .rwl, .pos, .lps, .xml) found in ' + (folder ? '"' + folder + '"' : 'that folder') + '.', 'err');
      return;
    }
    var ignored = all.length - files.length;
    loadUndatedFiles(files, 'startMsg', {
      label: folder || null,
      note: ignored ? '(' + ignored + ' non-data file' + (ignored === 1 ? '' : 's') + ' ignored.)' : ''
    });
  });
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
      state.chron = null; state.chronName = null; state.chrons = []; state.chronChoice = null;
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
    refreshMeta();
    var names = state.undated ? AC.seriesNames(state.undated) : [];
    fillSelect($('target_select'), names, function (n) { return n; }, function (n) { return n; });
    var chronLabel = state.chrons.length > 1 ? ' + ' + state.chrons.length + ' chronologies'
      : (state.chrons.length ? ' + chronology' : '');
    $('statusBar').textContent = state.undated
      ? (names.length + ' undated series' + chronLabel + ' loaded')
      : 'No data loaded';
    $('runBtn').disabled = !state.undated;
    // Header Clear + Export appear only once there's data to act on.
    document.querySelector('.header-actions').style.display = state.undated ? '' : 'none';
    syncModeUI();
    syncRingTest();
    refreshSetup();
    if (!state.result) updateExploreEmpty();
    syncNav();
  }

  Actions.clearAll = function () {
    state = { undated: null, chron: null, chrons: [], chronChoice: null, undatedName: null, chronName: null, meta: {}, tridasLinks: {}, detrend: null, result: null, filteredTable: null, selectedPair: null, builder: null, review: null };
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
        (state.chrons.length > 1 ? ' + ' + state.chrons.length + ' chronologies' : (state.chrons.length ? ' + a chronology' : '')) +
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
  // The run is a stepwise AppCore.analysisRunner driven through setTimeout —
  // one workflow / grid / segment chunk per tick — so the progress bar under
  // the Run button paints while the crossdating and the background
  // segment-consensus pass grind (same batched pattern as the ring test).
  Actions.runAnalysis = function (done) {
    if (!state.undated) { setMsg('runMsg', 'Load undated data first.', 'err'); return; }
    var mode = Number($('mode_select').value);
    if (mode === 2 && !state.chrons.length) { setMsg('runMsg', 'Chronology mode needs a loaded chronology (Data section above).', 'err'); return; }
    var target = $('target_select').value || AC.seriesNames(state.undated)[0];
    var runner, segTool = $('seg_enable').checked;
    var fail = function (err) {
      $('runBtn').disabled = false;
      $('runProgress').style.display = 'none';
      setMsg('runMsg', 'Error: ' + err.message, 'err');
      if (done) done(false);
    };
    try {
      // Chronology mode compares against the picked chronology, or the
      // composite (mean of the detrended chronologies) built at run time
      // from the current detrend settings.
      var chronForRun = state.chron, chronNameForRun = state.chronName, chronIsDetrended = false;
      if (mode === 2) {
        if (state.chronChoice === COMPOSITE) {
          chronForRun = AC.compositeChron(state.chrons, detrendUI());
          chronNameForRun = 'composite of ' + state.chrons.length + ' chronologies';
          chronIsDetrended = true;
        } else {
          var pick = chronByName(state.chronChoice) || state.chrons[state.chrons.length - 1];
          chronForRun = pick.frame; chronNameForRun = pick.name;
        }
      }
      runner = AC.analysisRunner({
        mode: mode,
        undated: state.undated, chron: chronForRun,
        chronName: chronNameForRun,
        chronIsDetrended: chronIsDetrended,
        detrend: detrendUI(),
        leadlag: leadlagUI(),
        filter: {
          r_val: 0.5, p_val: 0.05, overlap: 30,
          target: mode === 2 ? 'mean_chronology' : target
        },
        probWind: Number($('rep_probs').value) || 30,
        rbarWindow: Number($('rep_eps').value) || 30,
        // window length: the Segments tool uses its own; the background
        // segment-consensus pass of a plain chronology run has a separate one
        segLen: segTool ? (Number($('seg_len').value) || 60) : (Number($('cons_len').value) || 60),
        keepN: Number($('seg_keep').value) || 5,
        segTool: segTool
      });
    } catch (err) { fail(err); return; }
    $('runBtn').disabled = true;
    $('runProgress').style.display = '';
    $('runBarFill').style.width = '0';
    setMsg('runMsg', '');
    var tick = function () {
      if (!runner.done()) {
        $('runBarLabel').textContent = runner.label() + ' (' + (runner.progress() + 1) + '/' + runner.total() + ')';
        $('runBarFill').style.width = Math.round(100 * runner.progress() / runner.total()) + '%';
        setTimeout(function () {
          try { runner.step(); } catch (err) { fail(err); return; }
          tick();
        }, 15);
        return;
      }
      try {
        $('runBtn').disabled = false;
        $('runProgress').style.display = 'none';
        state.result = runner.result();
        var segNote = '';
        if (segTool) {
          var segCount = 0;
          AC.seriesNames(state.undated).forEach(function (n) {
            segCount += (state.result.segments[n] || []).length;
          });
          segNote = ' Kept the best ' + segCount + ' segments (' + state.result.segLength +
            '-yr sliding windows, up to ' + state.result.keepN + ' per series).';
        }
        state.filteredTable = state.result.crossDatRes;
        state.selectedPair = null;
        var cc = state.result.consensus && state.result.consensus.counts;
        var consNote = cc && (cc.promoted || cc.confirmed || cc.noted)
          ? ' Segment consensus: ' + cc.promoted + ' re-ranked, ' + cc.confirmed + ' confirmed' +
            (cc.noted ? ', ' + cc.noted + ' tentative' : '') + '.'
          : '';
        setMsg('runMsg', 'Analysis complete (' + (mode === 2 ? 'chronology' : 'pairwise') + ' mode).' + segNote + consNote + ' ' +
          state.result.crossDatRes.cols[0].length + ' result rows; ' +
          (state.result.aligned.names.length - 1) + ' aligned series.', 'ok');
        setupResultControls();
        showExploreResults(true);
        renderPlots();
        if (done) done(true);
      } catch (err) { fail(err); }
    };
    setTimeout(tick, 10);
  };
  $('runBtn').addEventListener('click', function () { Actions.runAnalysis(); });

  // ---- results table -------------------------------------------------------
  function setupResultControls() {
    resSort = null;                  // a fresh run starts in the grouped view
    segChecks = {};                  // and with no segments selected for diagnosis
    $('segDiagOut').innerHTML = '';
    updateSegDiagBar();
    var mode = state.result.mode;
    $('resModeBadge').innerHTML = '<span class="pill mode' + mode + '">' + (mode === 2 ? 'Chronology' : 'Pairwise') + ' mode</span>';
    // result.undated is what the run actually crossdated (it differs from
    // state.undated when segmentation was on) — every selector reads from it.
    var runUndated = state.result.undated;
    var names = mode === 2 ? ['mean_chronology'].concat(AC.seriesNames(runUndated)) : AC.seriesNames(runUndated);
    fillSelect($('f_target'), names, function (n) { return n; }, function (n) { return n; });
    $('f_target').value = state.result.target;
    // Plot series selectors from the comparison frame the plots draw from:
    // mode 2 (chronology) compares each undated series to the mean chronology,
    // so list [mean_chronology, ...undated]; mode 1 (pairwise) plots from the
    // full detrended frame, so list every series — that way clicking ANY
    // results row (e.g. a segment pair outside the aligned set) can plot it.
    var compFrame = mode === 2 ? state.result.chronNSeries : state.result.detrended;
    var an = compFrame.names.slice(1);
    fillSelect($('p_series1'), an, function (n) { return n; }, function (n) { return n; });
    fillSelect($('p_series2'), an, function (n) { return n; }, function (n) { return n; });
    if (mode === 2) { $('p_series1').value = state.result.target; if (an[1]) $('p_series2').value = an[1]; }
    else if (an[1]) $('p_series2').value = an[1];
    $('p_lag').value = AC.bestLagFor(state.result, $('p_series1').value, $('p_series2').value);
    fillSelect($('detrendSeriesSel'), AC.seriesNames(runUndated), function (n) { return n; }, function (n) { return n; });
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
        }, state.result.consensus && state.result.consensus.bySeries);
        var keptNote = frame.consensusKept ? ' (' + frame.consensusKept + ' kept by segment consensus)' : '';
        setMsg('resMsg', frame.cols[0].length + ' rows pass the filter' + keptNote + '.', 'ok');
      } catch (err) { setMsg('resMsg', 'Filter error: ' + err.message, 'err'); return; }
    } else { setMsg('resMsg', 'Showing full crossDatRes (' + frame.cols[0].length + ' rows).'); }
    state.filteredTable = frame;
    paintTable(AC.crossDatTable(frame));
  }
  // Column sort for the results table: ▲/▼ in every header. Ascending, then
  // descending, then back to the run's grouped best-3 blocks view. While
  // sorted, header/separator rows are hidden and pair rows are ordered by the
  // column's RAW value (numeric when numeric; blanks always last).
  var resSort = null;               // { idx: original column index, dir: 1 | -1 }
  Actions.sortResults = function (idx, dir) {
    resSort = dir ? { idx: idx, dir: dir } : null;
    renderResults();
  };
  function sortOrder(tbl) {
    var idx = resSort.idx, dir = resSort.dir;
    var bad = function (v) { return v == null || v === '' || (typeof v === 'number' && isNaN(v)); };
    var rows = [];
    tbl.raw.forEach(function (raw, r) {
      var s1 = raw[0], s2 = raw[1];
      if (bad(s1) || bad(s2) || s1 === s2) return;   // skip header/separator rows
      rows.push(r);
    });
    rows.sort(function (a, b) {
      var va = tbl.raw[a][idx], vb = tbl.raw[b][idx];
      var na = bad(va), nb = bad(vb);
      if (na || nb) return na === nb ? a - b : (na ? 1 : -1);       // blanks last either way
      var cmp;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).toLowerCase() < String(vb).toLowerCase() ? -1
        : (String(va).toLowerCase() > String(vb).toLowerCase() ? 1 : 0);
      return (cmp * dir) || (a - b);                                 // stable
    });
    return rows;
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
    thead.innerHTML = '<tr><th></th>' + tbl.columns.map(function (c, i) {
      if (i === dropIdx) return '';
      var cur = resSort && resSort.idx === i ? resSort.dir : 0;
      var arrow = function (dir, glyph) {
        return '<span class="sort-arrow' + (cur === dir ? ' on' : '') + '" data-idx="' + i +
          '" data-dir="' + dir + '" title="Sort ' + (dir === 1 ? 'ascending' : 'descending') + '">' + glyph + '</span>';
      };
      return '<th class="sortable" data-idx="' + i + '">' + esc(pretty(c)) +
        '<span class="sort-arrows">' + arrow(1, '▲') + arrow(-1, '▼') + '</span></th>';
    }).join('') + '</tr>';
    // ▲ = ascending, ▼ = descending; the active arrow again (or the header
    // cycling past descending) restores the grouped view.
    thead.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function (e) {
        var idx = Number(th.getAttribute('data-idx'));
        var arrowDir = e.target.classList && e.target.classList.contains('sort-arrow')
          ? Number(e.target.getAttribute('data-dir')) : null;
        var cur = resSort && resSort.idx === idx ? resSort.dir : 0;
        var dir;
        if (arrowDir != null) dir = (cur === arrowDir) ? 0 : arrowDir;
        else dir = cur === 0 ? 1 : (cur === 1 ? -1 : 0);
        Actions.sortResults(idx, dir);
      });
    });
    tbody.innerHTML = '';
    // A row pairing ONE segment with a complete reference gets a checkbox so
    // several placements of the same series can be diagnosed together.
    var isSegName = function (n) { return /@\d+-\d+$/.test(String(n)); };
    // Alternate-lag selection: cells in the Sec_* / Third_* column groups pick
    // that lag when clicked; anywhere else in the row picks the best (First_lag).
    var lagGroupOf = function (colName) {
      return /^Sec_/.test(String(colName)) ? 'Sec_' : (/^Third_/.test(String(colName)) ? 'Third_' : 'First_');
    };
    var dispCols = tbl.columns.map(function (_, i) { return i; }).filter(function (i) { return i !== dropIdx; });
    var rawLag = function (rIdx, group) {
      var li = tbl.columns.indexOf(group + 'lag');
      var v = li >= 0 ? tbl.raw[rIdx][li] : null;
      return (typeof v === 'number' && !isNaN(v)) ? v : null;
    };
    // Segment-consensus badge on the First-lag cell (chronology runs): the
    // run's background segmentation either re-ranked, confirmed, or tentatively
    // questioned this row's best lag — the badge says which, the tooltip why.
    var consBy = (state.result && state.result.consensus && state.result.consensus.bySeries) || {};
    var consFor = function (s1, s2) {
      var t = state.result && state.result.target;
      var s = s1 === t ? s2 : (s2 === t ? s1 : null);
      return (s && consBy[s]) || null;
    };
    var consBadge = function (c) {
      if (!c || !c.action) return '';
      var minP = AC.fmtP(c.minP);
      if (c.action === 'promoted') {
        return ' <span class="seg-badge promoted" title="Ranked by segment consensus: ' + c.nSegs +
          ' segments independently date this series here (min p ' + escA(minP) +
          '). The r / p shown are the whole-series stats at this lag; the full-series best lag (' + c.engineLag + ') is now 2nd.">' +
          c.nSegs + ' segs</span>';
      }
      if (c.action === 'confirmed') {
        return ' <span class="seg-badge confirmed" title="Segment consensus (' + c.nSegs + ' segments, min p ' + escA(minP) +
          ') independently confirms this lag.">✓ segs</span>';
      }
      return ' <span class="seg-badge noted" title="' + c.nSegs + ' segments tentatively support lag ' + c.lag +
        ' instead (min p ' + escA(minP) + ') — not promoted. Enable the Segments tool to inspect the placements.">? ' + c.lag + '</span>';
    };
    var paintRow = function (row, rIdx) {
      var s1 = row[0], s2 = row[1];       // Series_1 / Series_2 stay at indices 0,1 ("col" is later)
      var isSep = row.every(function (c) { return c === ''; });
      var tr = document.createElement('tr');
      if (isSep) { tr.className = 'sep'; tr.innerHTML = '<td colspan="' + (span + 1) + '"></td>'; tbody.appendChild(tr); return; }
      var seg = null, ref = null;
      if (s1 && s2 && s1 !== s2 && isSegName(s1) !== isSegName(s2)) {
        seg = isSegName(s1) ? s1 : s2;
        ref = isSegName(s1) ? s2 : s1;
      }
      var chk = seg
        ? '<input type="checkbox" class="seg-check" data-seg="' + escA(seg) + '" data-ref="' + escA(ref) + '"' +
          (segChecks[seg + '\u0000' + ref] ? ' checked' : '') + ' title="Select for segment diagnosis">'
        : '';
      var isPair = !!(s1 && s2 && s1 !== s2);
      // Hover model: every pair-row cell knows its own lag-stat group (data-lg,
      // only the lag/R/P/Overlap columns) and the group a CLICK on it would
      // select (data-eff — its own group when it has a valid alternate lag,
      // the best-lag group otherwise). The delegated hover handler below
      // highlights the whole effective group so the pick is visible before the
      // click.
      var lgToken = { First_: 'first', Sec_: 'sec', Third_: 'third' };
      var cells = row.map(function (c, ci) {
        if (ci === dropIdx) return '';
        var attr = '', extra = '';
        if (isPair) {
          var col = String(tbl.columns[ci]);
          var g = lagGroupOf(col);
          var ownGroup = /^(First|Sec|Third)_(lag|R|P|Overlap)$/.test(col) ? g : null;
          var eff = (g !== 'First_' && rawLag(rIdx, g) != null) ? g : 'First_';
          if (g !== 'First_' && rawLag(rIdx, g) != null) {
            attr = ' class="altlag" title="Click: view this pair at its ' + (g === 'Sec_' ? '2nd' : '3rd') + '-best lag"';
          }
          attr += ' data-lg="' + (ownGroup ? lgToken[ownGroup] : '') + '" data-eff="' + lgToken[eff] + '"';
          if (col === 'First_lag') extra = consBadge(consFor(s1, s2));
        }
        return '<td' + attr + '>' + esc(c) + extra + '</td>';
      }).join('');
      tr.innerHTML = '<td class="segchk">' + chk + '</td>' + cells;
      if (isPair) {
        tr.addEventListener('click', function (e) {
          if (e.target && e.target.classList && e.target.classList.contains('seg-check')) return;
          tbody.querySelectorAll('tr').forEach(function (x) { x.classList.remove('sel'); });
          tr.classList.add('sel');
          var lag = null;
          var td = e.target && e.target.closest ? e.target.closest('td') : null;
          if (td && td.cellIndex > 0) {
            var orig = dispCols[td.cellIndex - 1];
            lag = rawLag(rIdx, lagGroupOf(tbl.columns[orig]));
          }
          Actions.selectPair(s1, s2, lag);
        });
      }
      tbody.appendChild(tr);
    };
    if (resSort) sortOrder(tbl).forEach(function (r) { paintRow(tbl.rows[r], r); });
    else tbl.rows.forEach(paintRow);
    tbody.querySelectorAll('.seg-check').forEach(function (cb) {
      cb.addEventListener('change', function () { onSegCheck(cb, tbody); });
    });
  }
  // Delegated once on the (persistent) tbody: hovering a cell highlights every
  // cell of the lag group that clicking there would select (see data-eff above).
  (function () {
    var tbody = $('resTable').querySelector('tbody');
    var mark = function (target, on) {
      var td = target && target.closest ? target.closest('td') : null;
      if (!td || !td.parentElement) return;
      var eff = td.getAttribute('data-eff');
      if (!eff) return;
      Array.prototype.forEach.call(td.parentElement.cells, function (c) {
        if (c.getAttribute('data-lg') === eff) c.classList.toggle('lag-hover', on);
      });
    };
    tbody.addEventListener('mouseover', function (e) { mark(e.target, true); });
    tbody.addEventListener('mouseout', function (e) { mark(e.target, false); });
  })();

  // ---- segment diagnosis ----------------------------------------------------
  // Checking one segment auto-selects its visible siblings (same series, same
  // reference); unchecking removes just that one. The Diagnose button needs
  // >= 2 selections of ONE series against ONE reference.
  var segChecks = {};                // 'seg\u0000ref' -> true
  function segParent(n) { return String(n).replace(/@\d+-\d+$/, ''); }
  function onSegCheck(cb, tbody) {
    var seg = cb.getAttribute('data-seg'), ref = cb.getAttribute('data-ref');
    if (cb.checked) {
      segChecks[seg + '\u0000' + ref] = true;
      tbody.querySelectorAll('.seg-check').forEach(function (o) {
        if (o !== cb && segParent(o.getAttribute('data-seg')) === segParent(seg) && o.getAttribute('data-ref') === ref) {
          o.checked = true;
          segChecks[o.getAttribute('data-seg') + '\u0000' + ref] = true;
        }
      });
    } else {
      delete segChecks[seg + '\u0000' + ref];
    }
    updateSegDiagBar();
  }
  function segSelection() {
    var segs = [], refs = {}, parents = {};
    Object.keys(segChecks).forEach(function (k) {
      var parts = k.split('\u0000');
      segs.push(parts[0]); refs[parts[1]] = true; parents[segParent(parts[0])] = true;
    });
    return { segs: segs, refs: Object.keys(refs), parents: Object.keys(parents) };
  }
  function updateSegDiagBar() {
    var sel = segSelection();
    $('segDiagBar').style.display = sel.segs.length ? '' : 'none';
    var ok = sel.segs.length >= 2 && sel.refs.length === 1 && sel.parents.length === 1;
    $('segDiagBtn').disabled = !ok;
    if (!sel.segs.length) { setMsg('segDiagMsg', ''); return; }
    if (sel.parents.length > 1) setMsg('segDiagMsg', 'Select segments of ONE series (currently: ' + sel.parents.join(', ') + ').', 'err');
    else if (sel.refs.length > 1) setMsg('segDiagMsg', 'Select placements against ONE reference (currently: ' + sel.refs.join(', ') + ').', 'err');
    else if (sel.segs.length < 2) setMsg('segDiagMsg', 'Select at least two segments of ' + sel.parents[0] + '.');
    else setMsg('segDiagMsg', sel.segs.length + ' segments of ' + sel.parents[0] + ' vs ' + sel.refs[0] + ' selected.');
  }
  Actions.diagnoseSegments = function () {
    var sel = segSelection();
    if (!state.result || sel.segs.length < 2) return;
    try {
      renderSegDiag(AC.diagnoseSegments(state.result, sel.segs, sel.refs[0]));
    } catch (err) {
      $('segDiagOut').innerHTML = '<p class="msg err">' + esc(err.message) + '</p>';
    }
  };
  $('segDiagBtn').addEventListener('click', function () { Actions.diagnoseSegments(); });
  Actions.clearSegChecks = function () {
    segChecks = {};
    document.querySelectorAll('#resTable .seg-check').forEach(function (cb) { cb.checked = false; });
    updateSegDiagBar();
  };
  $('segClearBtn').addEventListener('click', Actions.clearSegChecks);

  // Data only — implied ring-1 placements (best + alternate lags), the offset
  // from the previous segment, the whole-series row as context, and the
  // placement plot. Interpretation is the technician's.
  function renderSegDiag(diag) {
    var signed = function (d) { return d == null ? '' : (d >= 0 ? '+' : '') + d; };
    var altCell = function (a) { return a ? a.placement + ' · r ' + AC.fmtCell(a.r) : ''; };
    var rows = diag.entries.map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td><td>' + e.datedStart + '–' + e.datedEnd +
        '</td><td>' + e.placement + '</td><td>' + signed(e.dPrev) + '</td><td>' + AC.fmtCell(e.r) + '</td><td>' +
        AC.fmtP(e.p) + '</td><td>' + e.overlap + '</td><td>' + altCell(e.alts[0]) + '</td><td>' + altCell(e.alts[1]) + '</td></tr>';
    }).join('');
    if (diag.whole) {
      var w = diag.whole;
      rows += '<tr class="sd-whole"><td>' + esc(diag.series) + '</td><td></td><td>' + w.placement +
        '</td><td></td><td>' + AC.fmtCell(w.r) + '</td><td>' + AC.fmtP(w.p) + '</td><td>' + w.overlap + '</td><td></td><td></td></tr>';
    }
    var svg = AC.renderPlot(diag.plot);
    $('segDiagOut').innerHTML =
      '<h3>Segment placements — ' + esc(diag.series) + ' vs ' + esc(diag.reference) + '</h3>' +
      '<div class="tablewrap" style="max-height:260px"><table class="res"><thead><tr><th>Segment</th><th>Dated span</th>' +
      '<th>Ring 1</th><th>Δ prev</th><th>r</th><th>p</th><th>Overlap</th><th>Ring 1 (2nd lag)</th><th>Ring 1 (3rd lag)</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      (svg ? '<div class="plotwrap" style="margin-top:8px">' + svg + '</div>' : '');
    plotSaveBar($('segDiagOut'), 'segment_placements_' + diag.series);
  }

  // Select a pair and render its plots in place (no tab hop). Optional lag
  // overrides the pair's best lag (used by the 2nd/3rd-best-lag table cells).
  Actions.selectPair = function (s1, s2, lag) {
    if (!state.result) return;
    state.selectedPair = [s1, s2];
    if ($('p_series1')) $('p_series1').value = s1;
    if ($('p_series2') && Array.prototype.some.call($('p_series2').options, function (o) { return o.value === s2; })) $('p_series2').value = s2;
    $('p_lag').value = (lag == null) ? AC.bestLagFor(state.result, s1, s2) : lag;
    renderPlots();
    $('explorePlots').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  // First selectable pair in the painted table (tour fallback for "click a row").
  // Skips separator rows and diagonal self-pairs (s1 === s2), which carry no
  // click handler.
  // Read-only handle on the current run bundle (headless tests / debugging).
  Actions.result = function () { return state.result; };
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
    syncFullSeriesBtn();
  }
  // "Review full series at this lag": shown while a plotted series is a
  // segment — swaps in the complete series at the equivalent lag, so a
  // promising segment alignment can be judged over the whole series in one
  // click.
  function isSegPlotName(n) { return /@\d+-\d+$/.test(String(n)); }
  function syncFullSeriesBtn() {
    var show = state.result && $('p_which').value !== 'detrend' &&
      (isSegPlotName($('p_series1').value) || isSegPlotName($('p_series2').value));
    $('fullSeriesWrap').style.display = show ? '' : 'none';
  }
  Actions.reviewFullSeries = function () {
    if (!state.result) return;
    var lag = Number($('p_lag').value) || 0;
    try {
      ['p_series1', 'p_series2'].forEach(function (id, i) {
        var name = $(id).value;
        if (!isSegPlotName(name)) return;
        var conv = AC.fullSeriesLag(state.result, name, lag, i === 1);
        if (!Array.prototype.some.call($(id).options, function (o) { return o.value === conv.series; })) {
          throw new Error(conv.series + ' is not available in the plot selectors.');
        }
        $(id).value = conv.series;
        lag = conv.lag;
      });
      $('p_lag').value = lag;
      renderPlots();
    } catch (err) { setMsg('plotMsg', 'Error: ' + err.message, 'err'); }
  };
  $('fullSeriesBtn').addEventListener('click', function () { Actions.reviewFullSeries(); });
  // One bold header line above a plot stack — plus an optional stats sub-line —
  // as an SVG strip so both are part of the saved composite image too:
  //   "series1 vs series2 — lagged N years"
  //   "First ring … · Last ring … · overlap … · Pearson's r … · p … · Student's T …"
  function headerSvg(text, sub, width) {
    var w = width || 760, h = sub ? 52 : 30;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<rect width="' + w + '" height="' + h + '" fill="white"/>' +
      '<text x="6" y="20" font-family="sans-serif" font-size="15" font-weight="bold">' + esc(text) + '</text>' +
      (sub ? '<text x="6" y="41" font-family="sans-serif" font-size="12" fill="#444">' + esc(sub) + '</text>' : '') +
      '</svg>';
  }
  // stats of the pair at the CHOSEN lag (AC pairStats) -> one display line
  function statsLine(st) {
    if (!st) return '';
    var num = function (v, dp) { return v == null ? '—' : String(Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp)); };
    var parts = [
      'First ring ' + (st.firstRing == null ? '—' : st.firstRing),
      'Last ring ' + (st.lastRing == null ? '—' : st.lastRing),
      'overlap ' + st.overlap,
    ];
    if (st.r != null) {
      parts.push("Pearson's r " + num(st.r, 3), 'p ' + AC.fmtP(st.p), "Student's T " + num(st.t, 2));
    } else {
      parts.push('overlap too thin for correlation');
    }
    return parts.join('   ·   ');
  }
  function headerEl(text, sub) {
    var d = document.createElement('div');
    d.className = 'plot-header';
    d.innerHTML = headerSvg(text, sub);
    return d;
  }

  function renderPlots() {
    if (!state.result) return;
    syncFullSeriesBtn();
    var which = $('p_which').value;
    var area = $('plotArea');

    if (which === 'detrend') {
      var series = $('detrendSeriesSel').value || AC.seriesNames(state.result.undated)[0];
      var dspec = AC.buildPlots(state.result, { detrendSeries: series }).detrend;
      area.innerHTML = dspec ? AC.renderPlot(dspec)
        : '<p class="msg err">Could not build the detrending plot for this series.</p>';
      plotSaveBar(area, 'detrend_' + series);
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
      area.appendChild(headerEl(plots.header, statsLine(plots.stats)));
      var zoomDiv = document.createElement('div');
      area.appendChild(zoomDiv);
      PlotZoom.attachDataZoom(zoomDiv, plots.line, AC.RD.renderSvg);
      plotSaveBar(area, 'line_' + vs);
      setMsg('plotMsg', 'Line plot for ' + vs + '.' + zoomHint, 'ok');
      return;
    }
    if (which === 'combined') {
      area.appendChild(headerEl(plots.header, statsLine(plots.stats)));
      var lineDiv = document.createElement('div');
      area.appendChild(lineDiv);
      if (plots.line) PlotZoom.attachDataZoom(lineDiv, plots.line, AC.RD.renderSvg);
      else lineDiv.innerHTML = '<p class="msg err">Line plot could not be built for ' + esc(vs) + '.</p>';
      var restSvg = AC.combinedPlot([plots.skeleton, plots.leadLagBar, plots.heatmap]);
      if (restSvg) { var restDiv = document.createElement('div'); restDiv.innerHTML = restSvg; area.appendChild(restDiv); }
      // hovering a year on the line plot highlights it on the skeleton rows
      // below (and vice versa) — hotzones are year-tagged, so the lag-axis bar
      // plot never cross-links.
      if (restSvg && plots.line) PlotLink.linkYearHover([lineDiv, restDiv]);
      plotSaveBar(area, 'combined_' + vs);
      setMsg('plotMsg', 'Combined for ' + vs + '. The line plot zooms/pans —' + zoomHint, 'ok');
      return;
    }
    var svg = AC.renderPlot(plots[which]);
    if (!svg) { setMsg('plotMsg', 'That plot could not be built for the selected pair (insufficient overlap?).', 'err'); return; }
    area.appendChild(headerEl(plots.header, statsLine(plots.stats)));
    var plotDiv = document.createElement('div');
    plotDiv.innerHTML = svg;
    area.appendChild(plotDiv);
    plotSaveBar(area, which + '_' + vs);
    setMsg('plotMsg', 'Showing ' + which + ' for ' + vs + '.', 'ok');
  }

  // ---- missing / false ring test -------------------------------------------
  // Exhaustive per-series edit simulation (AppCore.ringTest), batched through
  // setTimeout so the progress line paints while ~2n experiments run.
  var ringRunner = null;
  function syncRingTest() {
    $('ringTestCard').style.display = state.undated ? '' : 'none';
    if (!state.undated) { $('rt_out').innerHTML = ''; $('rt_plots').innerHTML = ''; setMsg('rt_msg', ''); ringRunner = null; ringIter = null; return; }
    var names = AC.seriesNames(state.undated);
    var curSeries = $('rt_series').value;
    fillSelect($('rt_series'), names, function (n) { return n; }, function (n) { return n; });
    if (names.indexOf(curSeries) >= 0) $('rt_series').value = curSeries;
    fillRingRefs();
  }
  function fillRingRefs() {
    var test = $('rt_series').value;
    var items = [];
    state.chrons.forEach(function (c) {
      items.push({ v: 'chron:' + c.name, l: c.name + ' (mean chronology)' });
    });
    if (state.chrons.length >= 2) items.push({ v: 'chron:' + COMPOSITE, l: 'Composite of all chronologies' });
    AC.seriesNames(state.undated).forEach(function (n) {
      if (n !== test) items.push({ v: 'series:' + n, l: n });
    });
    var cur = $('rt_ref').value;
    fillSelect($('rt_ref'), items, function (it) { return it.v; }, function (it) { return it.l; });
    if (items.some(function (it) { return it.v === cur; })) $('rt_ref').value = cur;
  }
  $('rt_series').addEventListener('change', fillRingRefs);

  // Iteration state across "apply & test again" passes: the original series,
  // the current (corrected) name/values, and every edit applied so far. Ring
  // numbers in each pass refer to the series as corrected by the previous
  // passes.
  var ringIter = null;               // { base, series, values, edits: [{type, ring}] }
  var RING_ITER_CAP = 8;
  function buildRingReference() {
    var refV = $('rt_ref').value;
    if (refV.indexOf('chron:') === 0) {
      var cname = refV.slice(6);
      if (cname === COMPOSITE) {
        return { reference: { kind: 'chron', frame: AC.compositeChron(state.chrons, detrendUI()), isDetrended: true }, label: 'composite mean chronology' };
      }
      var c = chronByName(cname);
      return { reference: { kind: 'chron', frame: c.frame }, label: cname + ' mean chronology' };
    }
    var rn = refV.slice(7);
    return { reference: { kind: 'series', name: rn }, label: rn };
  }
  // One test pass over the current iteration state (fresh series, or the
  // corrected values of previous passes).
  function startRingRun(done) {
    var built;
    try {
      built = buildRingReference();
      ringRunner = AC.ringTest({
        undated: state.undated, series: ringIter.series, seriesValues: ringIter.values,
        reference: built.reference, detrend: detrendUI(), leadlag: leadlagUI()
      });
    } catch (err) { setMsg('rt_msg', 'Error: ' + err.message, 'err'); if (done) done(false); return; }
    $('rt_out').innerHTML = '';
    $('rt_plots').innerHTML = '';
    $('rt_run').disabled = true;
    var passNote = ringIter.edits.length ? 'Pass ' + (ringIter.edits.length + 1) + ' — t' : 'T';
    var tick = function () {
      var finished = ringRunner.step(24);
      setMsg('rt_msg', passNote + 'esting single-ring edits… ' + ringRunner.progress() + ' / ' + ringRunner.total);
      if (!finished) { setTimeout(tick, 0); return; }
      $('rt_run').disabled = false;
      paintRingResults(ringIter.series, built.label);
      if (done) done(true);
    };
    setTimeout(tick, 10);
  }
  Actions.runRingTest = function (done) {
    if (!state.undated) { if (done) done(false); return; }
    var series = $('rt_series').value;
    if (!series || !$('rt_ref').value) { setMsg('rt_msg', 'Pick a series and a reference.', 'err'); if (done) done(false); return; }
    ringIter = { base: series, series: series, values: null, edits: [] };
    startRingRun(done);
  };
  $('rt_run').addEventListener('click', function () { Actions.runRingTest(); });
  // Apply one edit to the iteration state and re-test the corrected series.
  function applyAndRerun(exp, done) {
    var c = ringRunner.corrected(exp);
    ringIter.edits.push({ type: exp.type, ring: exp.ring });
    ringIter.series = c.name;
    ringIter.values = c.values;
    startRingRun(done);
  }
  // Auto-iterate: apply the top fruitful edit and re-test, until a pass bears
  // no fruit (or the cap is reached).
  Actions.autoIterateRingTest = function (done) {
    var step = function (ok) {
      if (!ok) { if (done) done(false); return; }
      var top = ringRunner.results().fruitful[0];
      if (!top || ringIter.edits.length >= RING_ITER_CAP) { if (done) done(true); return; }
      applyAndRerun(top, step);
    };
    step(true);
  };

  function num(v, dp) { return v == null ? '—' : String(Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp)); }
  function paintRingResults(series, refLabel) {
    var base = ringRunner.baseline;
    var res = ringRunner.results();
    var top = res.experiments.slice(0, 20);
    var editLabel = function (e) {
      return e.type === 'split' ? 'Split ring ' + e.ring : 'Merge rings ' + e.ring + '–' + (e.ring + 1);
    };
    // iteration history: what has been applied so far + the corrected download
    var iterLabel = function (e) {
      return e.type === 'split' ? 'split ring ' + e.ring : 'merge rings ' + e.ring + '–' + (e.ring + 1);
    };
    var history = ringIter && ringIter.edits.length
      ? '<p class="msg ok">' + ringIter.edits.length + ' correction' + (ringIter.edits.length === 1 ? '' : 's') +
        ' applied to ' + esc(ringIter.base) + ' (' + ringIter.edits.map(iterLabel).join(', ') +
        ') — now testing the corrected series, ' + ringRunner.seriesLength + ' rings. Ring numbers below refer to ' +
        'the corrected series. <button class="btn ghost" id="rt_dlIterBtn">Download corrected .rwl</button></p>'
      : '';
    var verdict;
    if (!res.fruitful.length) {
      verdict = '<p class="msg ok">No single-ring edit meaningfully improves the crossdate — no evidence of a ' +
        'missing or false ring in ' + esc(series) + ' against ' + esc(refLabel) + '.</p>';
      setMsg('rt_msg', 'Done — ' + ringRunner.total + ' edits tested, none bear fruit.' +
        (ringIter && ringIter.edits.length ? ' Iteration complete after ' + ringIter.edits.length + ' correction' + (ringIter.edits.length === 1 ? '' : 's') + '.' : ''), 'ok');
    } else {
      var b = res.experiments[0];
      verdict = '<p class="msg ok"><b>' + editLabel(b) + '</b> gives the biggest improvement ' +
        '(T ' + num(base.t, 2) + ' → ' + num(b.t, 2) + ' at lag ' + esc(String(b.lag)) + ') — consistent with a ' +
        (b.type === 'split' ? 'MISSING ring near ring ' + b.ring : 'FALSE ring near rings ' + b.ring + '–' + (b.ring + 1)) +
        '. ' + res.fruitful.length + ' of ' + ringRunner.total + ' edits bear fruit; nearby edits usually improve too, ' +
        'so read the top of the ranking as a neighbourhood.</p>';
      verdict += ringIter && ringIter.edits.length >= RING_ITER_CAP
        ? '<p class="hint">Iteration cap (' + RING_ITER_CAP + ' corrections) reached — download the corrected series and inspect it manually.</p>'
        : '<p><button class="btn" id="rt_applyBtn">Apply best edit &amp; test again</button> ' +
          '<button class="btn secondary" id="rt_autoBtn">Auto-iterate until clean</button></p>';
      setMsg('rt_msg', 'Done — ' + ringRunner.total + ' edits tested.', 'ok');
    }
    verdict = history + verdict;
    var baseLine = '<p class="hint">Baseline (unedited, ' + ringRunner.seriesLength + ' rings): lag ' +
      esc(String(base.lag)) + ' · r ' + num(base.r, 3) + ' · p ' + AC.fmtP(base.p) + ' · overlap ' + base.overlap +
      ' · T ' + num(base.t, 2) + ' <button class="btn ghost" id="rt_baseBtn">Plot baseline</button></p>';
    var rows = top.map(function (e) {
      return '<tr' + (e.fruitful ? ' class="rt-fruit"' : '') + ' data-type="' + e.type + '" data-ring="' + e.ring +
        '"><td>' + esc(editLabel(e)) + '</td><td>' +
        esc(String(e.lag == null ? '—' : e.lag)) + '</td><td>' + num(e.r, 3) + '</td><td>' + AC.fmtP(e.p) +
        '</td><td>' + (e.overlap == null ? '—' : e.overlap) + '</td><td>' + num(e.t, 2) + '</td><td>' +
        (e.dT == null ? '—' : (e.dT >= 0 ? '+' : '') + num(e.dT, 2)) + '</td></tr>';
    }).join('');
    $('rt_out').innerHTML = verdict + baseLine +
      '<div class="tablewrap" style="max-height:320px"><table class="res"><thead><tr><th>Edit</th><th>Lag</th>' +
      '<th>r</th><th>p</th><th>Overlap</th><th>T</th><th>ΔT</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>' +
      '<p class="hint">Top 20 of ' + ringRunner.total + " edits, ranked by ΔT (improvement in Student's T over the " +
      "baseline at each edit's best lag). Fruitful rows (ΔT ≥ 1 and r above baseline) are highlighted. " +
      'Click a row to review that corrected series — stats and plots vs the reference appear below.</p>';
    var trs = $('rt_out').querySelectorAll('tbody tr');
    trs.forEach(function (tr) {
      tr.addEventListener('click', function () {
        trs.forEach(function (x) { x.classList.remove('sel'); });
        tr.classList.add('sel');
        renderRingReview({ type: tr.getAttribute('data-type'), ring: Number(tr.getAttribute('data-ring')) });
      });
    });
    $('rt_baseBtn').addEventListener('click', function () {
      trs.forEach(function (x) { x.classList.remove('sel'); });
      renderRingReview(null);
    });
    var applyBtn = $('rt_applyBtn');
    if (applyBtn) applyBtn.addEventListener('click', function () { applyAndRerun(res.fruitful[0]); });
    var autoBtn = $('rt_autoBtn');
    if (autoBtn) autoBtn.addEventListener('click', function () { Actions.autoIterateRingTest(); });
    var dlIterBtn = $('rt_dlIterBtn');
    if (dlIterBtn) dlIterBtn.addEventListener('click', function () { triggerDownload(ringRunner.correctedDownload(null)); });
    // show the top-ranked experiment's plots straight away
    if (trs.length) trs[0].click();
  }
  // The four standard pair plots + stats header for one experiment's corrected
  // series (or the unedited baseline when exp is null), rendered like the
  // Explore pair plots: zoomable line, linked year-hover, one save bar.
  function renderRingReview(exp) {
    if (!ringRunner) return;
    var specs;
    try { specs = ringRunner.review(exp); }
    catch (err) { $('rt_plots').innerHTML = '<p class="msg err">' + esc(err.message) + '</p>'; return; }
    var area = $('rt_plots');
    area.innerHTML = '';
    area.appendChild(headerEl(specs.header + (exp ? '' : ' (baseline, unedited)'), statsLine(specs.stats)));
    // download the reviewed corrected series; apply-and-retest for fruitful edits
    var row = exp ? ringRunner.results().experiments.filter(function (x) {
      return x.type === exp.type && x.ring === exp.ring;
    })[0] : null;
    var bar = document.createElement('p');
    bar.innerHTML = '<button class="btn ghost" id="rt_dlBtn">Download ' + esc(ringRunner.corrected(exp).name) + '.rwl</button>' +
      (row && row.fruitful ? ' <button class="btn ghost" id="rt_applyThisBtn">Apply this edit &amp; test again</button>' : '');
    area.appendChild(bar);
    $('rt_dlBtn').addEventListener('click', function () { triggerDownload(ringRunner.correctedDownload(exp)); });
    var applyThis = $('rt_applyThisBtn');
    if (applyThis) applyThis.addEventListener('click', function () { applyAndRerun(exp); });
    var lineDiv = document.createElement('div');
    area.appendChild(lineDiv);
    if (specs.line) PlotZoom.attachDataZoom(lineDiv, specs.line, AC.RD.renderSvg);
    else lineDiv.innerHTML = '<p class="msg err">Line plot unavailable (thin overlap).</p>';
    var restDiv = document.createElement('div');
    var restSvg = AC.combinedPlot([specs.skeleton, specs.leadLagBar, specs.heatmap]);
    if (restSvg) { restDiv.innerHTML = restSvg; area.appendChild(restDiv); }
    if (restSvg && specs.line) PlotLink.linkYearHover([lineDiv, restDiv]);
    plotSaveBar(area, 'ringtest_' + (exp ? exp.type + exp.ring : 'baseline'));
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
        chron: { show: true, required: false, order: 2, label: 'Dated chronology (optional — for chronology mode; load several to compare)' }
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
          : (state.chrons.length > 1
              ? state.chrons.length + ' chronologies (' + esc(state.chrons.map(function (c) { return c.name; }).join(', ')) + ')'
              : AC.seriesNames(state.chron).length + ' members (' + esc(state.chronName) + ')');
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
    $('reviewHeader').innerHTML = '';
    $('reviewLine').innerHTML = ''; $('reviewSkel').innerHTML = ''; $('reviewHeat').innerHTML = ''; $('reviewBar').innerHTML = '';
    var sb = $('reviewPlots').querySelector(':scope > .savebar');
    if (sb) sb.remove();
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

  // Hover-tooltip line list for the chronology plot: each member series by name,
  // plus the mean chronology (from the allSeries spec's exposed data).
  function chronHoverLines(spec) {
    var lines = [], d = spec && spec.data;
    if (d && d.series) d.series.forEach(function (g) { lines.push({ name: g.name, x: g.x, y: g.y }); });
    if (d && d.meanChronology) lines.push({ name: 'mean chronology', x: d.meanChronology.x, y: d.meanChronology.y });
    return lines;
  }

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

    // mean / all-member-series plot — interactive (zoom/pan) + hover-to-name.
    var spec = AC.builderChronPlot(b.chronology());
    var bc = $('buildChronPlot');
    bc.innerHTML = '';
    if (spec) {
      var bz = document.createElement('div');
      bc.appendChild(bz);
      PlotZoom.attachDataZoom(bz, spec, AC.RD.renderSvg, { hoverLines: chronHoverLines(spec) });
      plotSaveBar(bc, 'built_chronology');
    } else {
      bc.innerHTML = '<p class="msg err">Not enough member series to plot yet.</p>';
    }

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
      state.review = AC.builderReview(state.builder, id, null, state.undated, state.chron ? state.chronName : null);
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

  // Line (interactive data-zoom) + skeleton + heatmap + lead-lag bar for the
  // current review. The zoomable line plot renders into an INNER div so the
  // save bar (and container listeners) survive zoom re-renders.
  function renderReviewPlots(specs) {
    $('reviewHeader').innerHTML = specs.header ? headerSvg(specs.header, statsLine(specs.stats)) : '';
    var rl = $('reviewLine');
    rl.innerHTML = '';
    if (specs.line) {
      var zd = document.createElement('div');
      rl.appendChild(zd);
      PlotZoom.attachDataZoom(zd, specs.line, AC.RD.renderSvg);
    } else {
      rl.innerHTML = '<p class="msg err">Line overlay unavailable for this alignment (thin overlap).</p>';
    }
    $('reviewSkel').innerHTML = specs.skeleton ? AC.renderPlot(specs.skeleton) : '<p class="msg err">Skeleton plot unavailable (thin overlap).</p>';
    $('reviewHeat').innerHTML = specs.heatmap ? AC.renderPlot(specs.heatmap) : '<p class="msg err">Heatmap unavailable (thin overlap).</p>';
    $('reviewBar').innerHTML = specs.leadLagBar ? AC.renderPlot(specs.leadLagBar) : '<p class="msg err">Lead-lag bar unavailable.</p>';
    // one save toolbar for the whole review block: SVG/PNG of ALL four plots
    // stacked in a single image
    var cand = $('candSel').value || 'candidate';
    plotSaveBar($('reviewPlots'), 'review_' + cand);
    // hover a year on the line plot -> highlighted on the skeleton rows, and back
    PlotLink.linkYearHover([rl, $('reviewSkel')]);
  }

  // Changing the lag re-renders the line + heatmap from the cached crossdate
  // (cn + masterLeadLag) WITHOUT re-crossdating, so alternative alignments preview.
  $('candLag').addEventListener('input', function () {
    if (!state.review) return;
    var id = $('candSel').value;
    var L = Number($('candLag').value) || 0;
    renderReviewPlots(AC.builderPlots(state.review.cn, state.review.masterLeadLag, id, L, state.undated, state.chron ? state.chronName : null));
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

  // ---- per-plot image saving (SVG / PNG buttons on every plot) --------------
  // Serialise the container's current SVG(s), stripped of transient hover
  // artefacts (linked-cursor lines, hotzones). PNG rasterises at 2x via canvas.
  function cleanSvgXml(svg) {
    var c = svg.cloneNode(true);
    c.querySelectorAll('.rd-cursor, .rd-hot').forEach(function (n) { n.remove(); });
    return new XMLSerializer().serializeToString(c);
  }
  // Stack every SVG in the container into ONE composite SVG (vertically, in DOM
  // order). Each source is nested at its y offset with its ids namespaced so
  // clipPath/gradient references never collide across sources.
  function stackSvgXml(svgs) {
    var parts = [], w = 0, h = 0;
    Array.prototype.forEach.call(svgs, function (svg, i) {
      var sw = Number(svg.getAttribute('width')) || svg.clientWidth || 760;
      var sh = Number(svg.getAttribute('height')) || svg.clientHeight || 300;
      var xml = cleanSvgXml(svg)
        .replace(/id="([^"]+)"/g, 'id="s' + i + '_$1"')
        .replace(/url\(#([^)]+)\)/g, 'url(#s' + i + '_$1)')
        .replace(/^<svg /, '<svg y="' + h + '" ');
      parts.push(xml);
      if (sw > w) w = sw;
      h += sh;
    });
    return {
      xml: '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
        '" viewBox="0 0 ' + w + ' ' + h + '">' +
        '<rect width="' + w + '" height="' + h + '" fill="white"/>' + parts.join('') + '</svg>',
      width: w, height: h,
    };
  }
  // Save ALL plots currently shown in `el` as one image.
  function savePlotImages(el, base, fmt) {
    var svgs = el.querySelectorAll('svg');
    if (!svgs.length) return;
    var name = base.replace(/[^A-Za-z0-9_-]+/g, '_') + '-' + new Date().toISOString().slice(0, 10);
    var st = stackSvgXml(svgs);
    if (fmt === 'svg') {
      triggerDownload({ content: st.xml, mime: 'image/svg+xml', filename: name + '.svg' });
      return;
    }
    var img = new Image();
    var url = URL.createObjectURL(new Blob([st.xml], { type: 'image/svg+xml' }));
    img.onload = function () {
      var cv = document.createElement('canvas');
      cv.width = st.width * 2; cv.height = st.height * 2;    // 2x for a crisp raster
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      cv.toBlob(function (blob) {
        var u = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = u; a.download = name + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
      }, 'image/png');
    };
    img.src = url;
  }
  // Small overlay toolbar (top-right of a plot container). Re-call after each
  // render; PlotZoom re-renders must target an INNER div so the bar survives.
  function plotSaveBar(el, base) {
    var old = el.querySelector(':scope > .savebar');
    if (old) old.remove();
    if (!el.querySelector('svg')) return;
    if (!el.style.position) el.style.position = 'relative';
    var bar = document.createElement('div');
    bar.className = 'savebar';
    ['svg', 'png'].forEach(function (fmt) {
      var b = document.createElement('button');
      b.className = 'btn ghost'; b.type = 'button';
      b.textContent = fmt.toUpperCase();
      b.title = 'Save this plot as ' + fmt.toUpperCase();
      b.addEventListener('click', function () { savePlotImages(el, base, fmt); });
      bar.appendChild(b);
    });
    el.appendChild(bar);
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
    try {
      var tri = AC.builderTridasDownloads({
        builder: state.builder, undated: state.undated, meta: state.meta,
        chronName: state.chronName || 'chronology', projectTitle: state.undatedName || 'RingdateR chronology'
      });
      ul.appendChild(dlItem(tri.chronologyTridasSelfContained, 'chronology TRiDaS (self-contained, for Tellervo)'));
      ul.appendChild(dlItem(tri.chronologyTridasDerivedOnly, 'chronology TRiDaS (derivedSeries only)'));
    } catch (err) {
      var li = document.createElement('li'); li.textContent = 'TRiDaS export unavailable: ' + err.message; ul.appendChild(li);
    }
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
      undatedName: state.undatedName, chronName: state.chronName,
      seriesMeta: state.meta
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
      state.meta = r.seriesMeta || {};
      state.result = null; state.filteredTable = null; state.selectedPair = null;
      if (obj.meta) { state.undatedName = obj.meta.undatedName || 'session'; state.chronName = obj.meta.chronName || null; }
      state.chrons = r.chron ? [{ name: state.chronName || 'chronology', frame: r.chron }] : [];
      state.chronChoice = state.chronName;
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
  Actions.seriesMeta = function () { return state.meta; };   // read accessor (tour/console/tests)
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
