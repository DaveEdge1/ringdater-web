'use strict';
// ============================================================================
// report.js — headless port of RingdateR's run-report (inst/report.Rmd and
// inst/chron_report.Rmd), which RingServer renders via rmarkdown::render in the
// summary_report_tmp / chron_evaluate downloadHandlers.
//
// renderReport(state, { date, chrono }) -> a SELF-CONTAINED HTML string (inline
// CSS, no external deps) reproducing the report's run-log CONTENT:
//   - title, run time, data / chronology loaded
//   - detrending method (the 1..7 det_val switch, incl. "<n> year spline")
//     + prewhitening / log-transform / verbose / problem-sample window
//   - the "correlations with replacement" table (correl_replace output)
//   - the EPS/Rbar window, sample-distribution and per-sample sections
//     (headings + values; optional embedded plot SVGs if the host supplies specs)
//   - run duration
//
// The two Rmd templates differ only in wiring: report.Rmd (pairwise / "summary")
// shows BOTH file1 (data) and file2 (chronology) and reads summary_* inputs;
// chron_report.Rmd (chronology-eval) shows a single loaded file (file2) and
// reads chron_eval_* inputs. `chrono:true` selects the chron_report layout.
//
// `state` is a plain, tolerant object (all fields optional):
//   { files:    { undated, chrono },                 // input$file1$name / file2$name
//     detrend:  { detrending_select, splinewindow, ARmod, logT },
//     settings: { verbose, probs, rbarWindow },       // summary_/chron_eval_*
//     correlReplace: Frame,                           // correl_replace() result
//     probCheck: { message, samples, intervals },     // prob_check() result
//     plots:    { chron, sampleDist } }               // optional prebuilt SVG specs
// ============================================================================

const { toSVG } = require('./viz/render.js');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ringdater det_val (as.numeric(input$detrending_select)) -> method label.
function detMethod(detrend = {}) {
  const v = Number(detrend.detrending_select);
  switch (v) {
    case 1: return 'No detrending applied';
    case 2: return 'Convert to z-scores';
    case 3: return `${detrend.splinewindow} year spline`;
    case 4: return 'Mod. negative exponential';
    case 5: return 'Friedman';
    case 6: return 'ModHugershoff';
    case 7: return 'First difference';
    default: return 'no number';
  }
}

// knitr::kable-style HTML table from a Frame ({ names, cols }). Numbers are
// printed at full precision (kable digits = 32); NA/null render blank. A leading
// row-number column reproduces row.names(the_data) <- 1:nrow.
function frameTable(frame) {
  if (!frame || !frame.names || !frame.cols || !frame.cols.length) {
    return '<p class="muted">No data.</p>';
  }
  const nrow = frame.cols[0] ? frame.cols[0].length : 0;
  const cell = v => {
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) return '';
    return esc(v);
  };
  const head = ['', ...frame.names].map(h => `<th>${esc(h)}</th>`).join('');
  const rows = [];
  for (let r = 0; r < nrow; r++) {
    const tds = [`<td class="rn">${r + 1}</td>`];
    for (let c = 0; c < frame.cols.length; c++) tds.push(`<td>${cell(frame.cols[c][r])}</td>`);
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// prob_check() result -> a small summary (flagged samples + intervals, or the
// "no problems"/error message).
function probSummary(pc) {
  if (!pc) return '<p class="muted">Problem checker was not run.</p>';
  if (pc.message) return `<p>${esc(pc.message)}</p>`;
  if (!pc.samples || !pc.samples.length) {
    return '<p>Problem checker could not detect problems with any sample.</p>';
  }
  const rows = pc.samples.map((s, i) =>
    `<tr><td>${esc(s)}</td><td>${esc((pc.intervals && pc.intervals[i]) || '')}</td></tr>`).join('');
  return `<table><thead><tr><th>Flagged sample</th><th>Interval</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// rBarEps() rows -> a running Rbar / EPS table (mid.year, n.trees, n, rbar.tot,
// eps). Null (diagnostic threw / not supplied) degrades to a friendly note.
function rbarTable(re) {
  if (re == null) return '<p class="muted">EPS / Rbar table unavailable (try a smaller window).</p>';
  if (!re.length) return '<p class="muted">No complete windows for the chosen window length.</p>';
  const num = v => (v == null || (typeof v === 'number' && Number.isNaN(v))) ? '' : esc(v);
  const rows = re.map(w =>
    `<tr><td>${num(w.midYear)}</td><td>${num(w.nTrees)}</td><td>${num(w.n)}</td>` +
    `<td>${num(w.rbarTot)}</td><td>${num(w.eps)}</td></tr>`).join('');
  return `<table><thead><tr><th>mid.year</th><th>n.trees</th><th>n</th>` +
    `<th>rbar.tot</th><th>EPS</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const CSS = `
:root{color-scheme:light dark}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  line-height:1.5;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.9rem;border-bottom:2px solid #ddd;padding-bottom:.3rem}
h2{font-size:1.4rem;margin-top:2rem}
h3{font-size:1.15rem;margin-top:1.6rem}
p{margin:.35rem 0}
.kv{margin:.15rem 0}.kv b{display:inline-block;min-width:11rem}
.muted{color:#777;font-style:italic}
.note{color:#555;font-size:.9rem}
table{border-collapse:collapse;margin:.6rem 0;font-size:.9rem;width:100%;
  display:block;overflow-x:auto}
th,td{border:1px solid #ccc;padding:.25rem .5rem;text-align:right}
th{background:#f2f2f2}td.rn,th:first-child{color:#999;text-align:right}
svg{max-width:100%;height:auto;border:1px solid #eee}
@media (prefers-color-scheme:dark){
  body{color:#e6e6e6}h1{border-color:#444}th{background:#2a2a2a}
  th,td{border-color:#444}.muted{color:#999}svg{border-color:#333;background:#fff}}
`;

// renderReport(state, { date, chrono }) -> HTML string.
function renderReport(state = {}, opts = {}) {
  const chrono = !!opts.chrono;
  const files = state.files || {};
  const detrend = state.detrend || {};
  const settings = state.settings || {};
  const runTime = opts.date != null ? String(opts.date) : new Date().toString();

  // In chron_report.Rmd the single loaded file is the chronology (file2); in
  // report.Rmd file1 is the data and file2 the chronology.
  const dataLoaded = chrono ? (files.chrono != null ? files.chrono : 'No data loaded')
                            : (files.undated != null ? files.undated : 'No data loaded');

  const method = detMethod(detrend);
  const parts = [];
  parts.push(`<h1>RingdateR output log</h1>`);
  parts.push(`<p class="kv"><b>Run time:</b> ${esc(runTime)}</p>`);
  parts.push(`<p class="kv"><b>Data loaded:</b> ${esc(dataLoaded)}</p>`);
  if (!chrono) {
    const chronName = files.chrono != null ? files.chrono : 'No data loaded';
    parts.push(`<p class="kv"><b>Chronology loaded:</b> ${esc(chronName)}</p>`);
  }

  parts.push(`<h3>Detrending and report settings applied:</h3>`);
  parts.push(`<p class="kv"><b>Detrending mode:</b> ${esc(method)}</p>`);
  parts.push(`<p class="kv"><b>Prewhitening:</b> ${esc(fmtBool(detrend.ARmod))}</p>`);
  parts.push(`<p class="kv"><b>Log Transform:</b> ${esc(fmtBool(detrend.logT))}</p>`);
  parts.push(`<p class="kv"><b>Verbose:</b> ${esc(fmtBool(settings.verbose))}</p>`);
  parts.push(`<p class="note">If verbose = TRUE: all possible leads and lags are evaluated.<br>` +
             `If verbose = FALSE: lead-lag analysis is limited to a +/-20 year range of lags.</p>`);
  parts.push(`<p class="kv"><b>Problem sample window:</b> ${esc(settings.probs)} years (with 50% overlap)</p>`);

  parts.push(`<h3>Correlations between each series and the arithmetic mean chronology with replacement</h3>`);
  parts.push(`<p class="note">(The sample being analysed is excluded from the chronology)</p>`);
  parts.push(frameTable(state.correlReplace));

  parts.push(`<h3>Chronology and EPS plots</h3>`);
  parts.push(`<p class="kv"><b>EPS and Rbar window:</b> ${esc(settings.rbarWindow)} years with 50% overlap</p>`);
  if ('rBarEps' in state) parts.push(rbarTable(state.rBarEps));
  if (state.plots && state.plots.chron) parts.push(toSVG(state.plots.chron));

  parts.push(`<h3>Distribution of aligned samples</h3>`);
  if (state.plots && state.plots.sampleDist) parts.push(toSVG(state.plots.sampleDist));

  parts.push(`<h2>Overview of correlations between each series and the arithmetic mean chronology</h2>`);
  parts.push(probSummary(state.probCheck));

  const runDur = opts.runDuration != null ? String(opts.runDuration) : '—';
  parts.push(`<p class="kv"><b>Run duration:</b> ${esc(runDur)}</p>`);

  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>RingdateR output log</title><style>${CSS}</style></head>\n<body>\n` +
    parts.join('\n') + `\n</body></html>\n`;
}

// R prints logicals as "TRUE"/"FALSE"; keep other values verbatim.
function fmtBool(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return v;
}

module.exports = { renderReport, detMethod, frameTable, probSummary, rbarTable };
