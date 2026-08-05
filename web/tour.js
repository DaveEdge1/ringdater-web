/* ============================================================================
 * tour.js — an interactive, dependency-free guided tour ("coach-marks") that
 * drives the REAL RingdateR app with the bundled example data. Each step
 * highlights a live control, explains it, and either performs the real action
 * (via window.AppUI, defined in app.js) or waits for the user to do it.
 *
 * The tour never simulates the UI — every action is the same code path a button
 * click runs, so exiting mid-tour leaves a genuine, usable worked example.
 * ==========================================================================*/
(function () {
  'use strict';
  var UI = null;                       // window.AppUI (resolved lazily on start)
  var $ = function (id) { return document.getElementById(id); };

  // ---- overlay elements (created once, on first start) ---------------------
  var highlight = null, popover = null, waitCleanup = null;

  function ensureDom() {
    if (popover) return;
    highlight = document.createElement('div');
    highlight.className = 'tour-highlight';
    highlight.style.display = 'none';
    document.body.appendChild(highlight);

    popover = document.createElement('div');
    popover.className = 'tour-popover';
    popover.style.display = 'none';
    document.body.appendChild(popover);
  }

  // ---- tour state ----------------------------------------------------------
  var steps = [], idx = 0, running = false;

  function target(step) {
    if (!step.target) return null;
    return typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
  }

  function positionFor(el) {
    if (!el) {                                    // centered, no highlight
      highlight.style.display = 'none';
      popover.style.top = '50%'; popover.style.left = '50%';
      popover.style.transform = 'translate(-50%,-50%)';
      return;
    }
    popover.style.transform = 'none';
    var r = el.getBoundingClientRect();
    var pad = 6;
    highlight.style.display = 'block';
    highlight.style.top = (r.top - pad) + 'px';
    highlight.style.left = (r.left - pad) + 'px';
    highlight.style.width = (r.width + pad * 2) + 'px';
    highlight.style.height = (r.height + pad * 2) + 'px';

    // popover: prefer below, else above, else to the side; clamp to viewport.
    var pw = popover.offsetWidth || 340, ph = popover.offsetHeight || 160;
    var vw = window.innerWidth, vh = window.innerHeight, gap = 14;
    var top, left = Math.min(Math.max(8, r.left), vw - pw - 8);
    if (r.bottom + gap + ph <= vh) top = r.bottom + gap;
    else if (r.top - gap - ph >= 0) top = r.top - gap - ph;
    else { top = Math.max(8, Math.min(vh - ph - 8, r.top)); left = (r.right + gap + pw <= vw) ? r.right + gap : Math.max(8, r.left - pw - gap); }
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
  }

  function reposition() {
    if (!running) return;
    positionFor(target(steps[idx]));
  }
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  function render() {
    var step = steps[idx];
    if (waitCleanup) { waitCleanup(); waitCleanup = null; }

    // run the step's side effect (load data, switch view, run analysis…)
    if (step.onEnter) { try { step.onEnter(UI); } catch (e) { /* keep the tour alive */ } }

    var el = target(step);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    var waitLabel = step.advanceOn ? (step.waitText || 'Do this to continue…') : null;
    var backBtn = idx > 0 ? '<button class="btn ghost" data-tour-back>Back</button>' : '';
    var nextLabel = idx === steps.length - 1 ? 'Finish' : 'Next →';
    var nextBtn = step.advanceOn ? '' : '<button class="btn" data-tour-next>' + nextLabel + '</button>';
    var foot = waitLabel
      ? '<span class="tour-wait">' + esc(waitLabel) + '</span>' + backBtn
      : '<span class="tour-count">Step ' + (idx + 1) + ' of ' + steps.length + '</span>' + backBtn + nextBtn;

    popover.innerHTML =
      '<button class="tour-x" data-tour-exit title="Exit tour">✕</button>' +
      '<h3>' + esc(step.title) + '</h3>' +
      '<p>' + step.body + '</p>' +
      '<div class="tour-foot">' + foot + '</div>';
    popover.style.display = 'block';

    // let layout settle, then place (popover size is now known)
    positionFor(el);
    setTimeout(function () { positionFor(target(steps[idx])); }, 60);

    var b = popover.querySelector('[data-tour-back]'); if (b) b.onclick = back;
    var n = popover.querySelector('[data-tour-next]'); if (n) n.onclick = next;
    popover.querySelector('[data-tour-exit]').onclick = stop;

    // wait-for-user-action steps: listen once on a live element, then advance.
    if (step.advanceOn) {
      var watchEl = step.advanceTarget ? document.querySelector(step.advanceTarget) : el;
      if (watchEl) {
        var handler = function () { watchEl.removeEventListener(step.advanceOn, handler); waitCleanup = null; setTimeout(next, 250); };
        watchEl.addEventListener(step.advanceOn, handler);
        waitCleanup = function () { watchEl.removeEventListener(step.advanceOn, handler); };
      }
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function next() { if (idx < steps.length - 1) { idx++; render(); } else stop(); }
  function back() { if (idx > 0) { idx--; render(); } }
  function stop() {
    running = false;
    if (waitCleanup) { waitCleanup(); waitCleanup = null; }
    if (highlight) highlight.style.display = 'none';
    if (popover) popover.style.display = 'none';
  }

  // ---- step chapters -------------------------------------------------------
  // onEnter runs each step's real action; advanceOn waits for the user instead
  // of showing a Next button.
  function exploreSteps() {
    return [
      { title: 'Welcome to RingdateR', target: null,
        body: 'This tour crossdates a set of undated tree-ring series against each other, using the bundled example data. Crossdating finds the calendar (or relative) alignment where two ring-width series correlate best. Click <b>Next</b> to begin.' },
      { title: 'Load the example data', target: '#railData',
        onEnter: function (ui) { if (!ui.ensureExampleData()) stop(); ui.showView('explore'); },
        body: 'We\'ve loaded 13 undated example series. You normally load your own .csv / .rwl / .pos files (and an optional dated chronology) when you pick a task on the <b>Home</b> page; the rail\'s <b>Data</b> section just shows what\'s loaded.' },
      { title: 'Pairwise vs chronology mode', target: '#railMode',
        body: 'Your first decision: in <b>pairwise</b> mode every series is crossdated against every other. In <b>chronology</b> mode each series is crossdated against the mean of a loaded dated chronology. We\'ll use pairwise here.' },
      { title: 'Choose a detrending method', target: '#railDetrend',
        body: 'Detrending removes each series\' slow age-related growth trend so only the year-to-year climate signal — the part that crossdates — remains. The default <b>spline</b> works well for most datasets; the window controls how stiff the fitted curve is.' },
      { title: 'Set the lead/lag search', target: '#railLags',
        onEnter: function () { var d = document.getElementById('railLags'); if (d) d.open = true; },
        body: 'These are collapsed by default. They bound how far RingdateR slides one series past another looking for the best match. <b>Auto lag limits</b> tries every possible overlap — good when you have no idea where a series sits.' },
      { title: 'Run the analysis', target: '#runBtn',
        advanceOn: 'click', waitText: 'Click “Run analysis” to continue…',
        body: 'Click <b>Run analysis</b>. RingdateR detrends every series and crossdates all pairs — it takes a moment.' },
      { title: 'Read the results table', target: '#exploreResults',
        body: 'Each pair gets its best 3 lag matches. Look at <b>R</b> (correlation — higher is better), <b>P</b> (significance — lower is better) and <b>Overlap</b> (years in common — more is safer). A convincing match has high R, tiny P, and generous overlap.' },
      { title: 'Filter to the strong matches', target: '.plot-controls',
        advanceTarget: '#exploreResults',
        body: 'Tick <b>Apply filter</b> and raise <b>Min R</b> / lower <b>Max p</b> to hide weak pairs. Handy on real datasets with dozens of series.' },
      { title: 'Pick a pair to plot', target: '#resTable',
        advanceOn: 'click', advanceTarget: '#resTable tbody', waitText: 'Click any result row to continue…',
        body: 'Click any row in the table. Its two series load into the plots below, aligned at that row\'s best lag.' },
      { title: 'The line-plot overlay', target: '#explorePlots',
        onEnter: function (ui) { ui.setPlotType('line'); },
        body: 'This overlays the two detrended series at the crossdate lag — peaks and troughs should line up. It\'s interactive: scroll to zoom time, Shift+scroll to zoom width, drag to pan, double-click to reset.' },
      { title: 'The running-correlation heatmap', target: '#explorePlots',
        onEnter: function (ui) { ui.setPlotType('heatmap'); },
        body: 'This shows how the correlation holds up across the series and at nearby lags — a solid horizontal band at one lag is the signature of a real match, not a coincidence.' },
      { title: 'The detrending diagnostic', target: '#explorePlots',
        onEnter: function (ui) { ui.setPlotType('detrend'); },
        body: 'Switch the <b>Show</b> selector to any plot type. The <b>Detrending diagnostic</b> shows a raw series, the fitted trend curve, the detrended result, and its autocorrelation — use it to sanity-check your detrend settings.' },
      { title: 'Export your run', target: '#exportBtn',
        onEnter: function (ui) { ui.setPlotType('combined'); },
        body: 'The <b>Export</b> menu (top right) downloads the results table, plots and data for this run, or generates a self-contained HTML report. That\'s the Explore workflow! Next, try the <b>Build a chronology</b> tour from the Home page.' }
    ];
  }

  function buildSteps() {
    return [
      { title: 'Build a chronology', target: null,
        onEnter: function (ui) { if (!ui.ensureExampleData()) stop(); ui.showView('build'); },
        body: 'A chronology is a mean curve built from many correctly-aligned series. This tour grows one from the example data, one series at a time. Click <b>Next</b>.' },
      { title: 'Start the builder', target: '#buildStartBtn',
        onEnter: function (ui) { if (!ui.hasBuilder()) ui.startBuilder(); },
        body: 'The builder starts from your loaded data using the current detrend settings. With no chronology loaded, it first asks you to choose an <b>anchor</b> — the seed series everything else aligns to.' },
      { title: 'Pick an anchor series', target: '#anchorWrap',
        body: 'Pick a long series you measured with high confidence as the anchor — plenty of rings and clean measurements give the growing chronology a strong backbone for everything else to align to. Then <b>Set anchor</b>. On the next step we\'ll set one for you so the working chronology has a single member to grow from.' },
      { title: 'The candidate pool', target: '#candSel',
        onEnter: function (ui) { if (ui.hasBuilder() && ui.builderMemberCount() === 0) ui.setAnchor(); },
        body: 'With the anchor set, pick a <b>candidate</b> from the pool of not-yet-added series. RingdateR immediately crossdates it against the current mean chronology.' },
      { title: 'Best-lag suggestions', target: '#suggTable',
        body: 'The top 3 lags are ranked by strength. The best one is pre-filled as the lag to use, but you\'re in control — the review plots below help you judge whether it\'s trustworthy.' },
      { title: 'Review the alignment', target: '#reviewLine',
        body: 'The overlay, heatmap and lead-lag bar show how this candidate fits at the chosen lag. Edit the <b>Lag</b> field to preview a different alignment without re-crossdating.' },
      { title: 'Approve the candidate', target: '#approveBtn',
        onEnter: function (ui) { if (ui.hasBuilder()) ui.approveCandidate(); },
        body: 'Happy with it? <b>Approve</b> adds it to the chronology at the chosen lag (we just did). The mean updates and the next candidate is crossdated automatically.' },
      { title: 'Skip or flag doubtful series', target: '#skipBtn',
        body: 'Not every series belongs. <b>Skip</b> or <b>Needs review</b> moves a candidate to the <b>Set aside</b> list (in the left panel) with an optional note explaining why — so your decisions stay documented.' },
      { title: 'Auto-build the rest', target: '#autoBuildSection',
        body: 'Open <b>Auto-build</b> to crossdate the whole remaining pool at once and add everything that passes your R / p / overlap thresholds. Everything it does stays fully editable afterward.' },
      { title: 'Date the chronology', target: '#dateSection',
        body: 'A freshly built chronology is <b>floating</b> (positions, not years). Open <b>Date the chronology</b> and pin a known ring on a member series to a calendar year — the whole chronology then reads in calendar years.' },
      { title: 'Export & report', target: '#exportBtn',
        body: 'The <b>Export</b> menu saves the chronology as CSV or Tucson RWL and generates a report listing members, set-aside series, and Rbar/EPS statistics. You can save your session anytime and resume later. That\'s the Build workflow — happy crossdating!' }
    ];
  }

  // ---- public API ----------------------------------------------------------
  function start(chapter) {
    UI = window.AppUI;
    if (!UI) { window.alert('The app is still loading — try the tour again in a moment.'); return; }
    ensureDom();
    steps = chapter === 'build' ? buildSteps() : exploreSteps();
    idx = 0; running = true;
    render();
  }

  window.Tour = { start: start, stop: stop };
})();
