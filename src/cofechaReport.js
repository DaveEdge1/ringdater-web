'use strict';
// ============================================================================
// cofechaReport.js — renders a cofecha() result as the eight-part output
// described in Grissino-Mayer (2001), pp. 210-214 ("OUTPUT PRODUCED BY
// COFECHA"), as a self-contained HTML string (inline CSS, no external deps).
//
//   Part 1  Title page, options selected, summary, absent rings
//   Part 2  Histogram of time spans
//   Part 3  Master series with sample depth and absent rings
//   Part 4  Bar plot of the master dating series
//   Part 5  Correlation of each series with the master
//   Part 6  Potential problems  [A] alternate positions  [B] year leverage
//           [C] divergent year-to-year change  [D] absent rings  [E] outliers
//   Part 7  Descriptive statistics
//   Part 8  Undated series adjustments  (see note in the rendered output)
//
// Option 8 (p. 210) lets the user choose which parts to print; `opts.parts`
// reproduces that — an array or set of part numbers, default all of 1-7.
//
// Two places where the presentation deliberately improves on the 1982 output,
// both noted in the page itself so the reader is never misled:
//   * Part 5 prints each segment's TRUE span in its tooltip. COFECHA lays the
//     matrix on a fixed global grid and fills columns in order, so a segment's
//     heading can differ from the years it covers (Table 3: LLC001A's 1725-1774
//     segment prints under the 1700-1749 heading).
//   * Part 4's letter codes are kept (they are a real COFECHA convention) but
//     drawn as bars rather than typewriter overstrike.
// ============================================================================

const { cofecha } = require('./stats/cofecha.js');
const { heatmapPlot } = require('./viz/heatmapPlot.js');
const { toSVG } = require('./viz/render.js');
const { formatCal } = require('./io/year.js');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fx = (v, d) => (isNum(v) ? v.toFixed(d) : '');
// COFECHA prints correlations without the leading zero (".67", "-.13").
const fr = (v, d = 2) => (isNum(v) ? (v < 0 ? '-' : '') + Math.abs(v).toFixed(d).replace(/^0/, '') : '');

// ---------------------------------------------------------------------------
// Part 4 letter code (p. 212): "@" is a value very close to the mean; each
// successive letter is a further 0.25 SD departure, upper case for rings wider
// than the mean and lower case for narrower.
// ---------------------------------------------------------------------------
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function letterCode(z) {
  if (!isNum(z)) return ' ';
  const k = Math.floor(Math.abs(z) / 0.25);
  if (k === 0) return '@';
  const ch = ALPHA[Math.min(k - 1, ALPHA.length - 1)];
  return z > 0 ? ch : ch.toLowerCase();
}

function kv(label, value) {
  return '<p class="kv"><b>' + esc(label) + '</b>' + esc(value) + '</p>';
}

// Years are astronomical in the data (0 = 1 BC) but read as calendar years, so
// anything shown to a person goes through formatCal. Only matters for the BC
// chronologies, which ut550 and ut528 both are.
const yr = y => (Number.isFinite(+y) ? (+y <= 0 ? formatCal(y) : String(+y)) : '');

// ---- Verdict page ----------------------------------------------------------
// Everything below this on the page is evidence. This is the answer.
function verdictSection(verdict) {
  if (!verdict) return '';
  const S = verdict.summary;
  const need = verdict.series.filter(v => v.status !== 'dated' && v.status !== 'too-short');
  const short = verdict.series.filter(v => v.status === 'too-short');

  const headline = need.length === 0
    ? '<p class="ok-big">All ' + S.nSeries + ' series date against the rest of the collection.</p>'
    : '<p class="bad-big">' + need.length + ' of ' + S.nSeries + ' series need attention.</p>';

  const rows = need.map(v => {
    const where = v.bracket ? yr(v.bracket[0]) + ' to ' + yr(v.bracket[1]) : '—';
    return '<tr>' +
      '<td class="l">' + esc(v.id) + '</td>' +
      '<td class="l"><span class="tag t-' + esc(v.status) + '">' + esc(v.status) + '</span></td>' +
      '<td>' + yr(v.first) + '&ndash;' + yr(v.last) + '</td>' +
      '<td>' + (Number.isFinite(v.corrWithMaster) ? fx(v.corrWithMaster, 3) : '') + '</td>' +
      '<td>' + esc(where) + '</td>' +
      '<td class="l">' + esc(v.message) + '</td></tr>';
  }).join('');

  const table = need.length
    ? '<table><thead><tr><th class="l">Series</th><th class="l">Verdict</th><th>Span</th>' +
      '<th>r</th><th>Where</th><th class="l">What it looks like</th></tr></thead><tbody>' +
      rows + '</tbody></table>'
    : '';

  const coll = verdict.collection && verdict.collection.length
    ? '<h3>Across the collection</h3><ul class="coll">' +
      verdict.collection.map(c => '<li><b>' + esc(c.kind) + '</b> &mdash; ' + esc(c.message) + '</li>').join('') +
      '</ul>'
    : '';

  const shortNote = short.length
    ? '<p class="note">' + short.length + ' series ' + (short.length === 1 ? 'is' : 'are') +
      ' too short for a running window (' + short.map(v => esc(v.id)).join(', ') +
      '); judge those from the segment table in Part 5.</p>'
    : '';

  return '<h2 class="verdict-h">Verdict</h2>' + headline +
    '<p class="note">Each series is correlated against a chronology built from every <em>other</em> ' +
    'series, in a ' + esc(verdict.options.win) + '-year running window, at every dating position ' +
    'from &minus;' + esc(verdict.options.shift) + ' to +' + esc(verdict.options.shift) + '. ' +
    'A series whose best-fitting position holds steady is dated; one where it steps and stays ' +
    'stepped has a dating error, and the step locates it. The bracket is the step year ' +
    '&plusmn; half the window &mdash; a single year would be false precision.</p>' +
    table + coll + shortNote;
}

// ---- Chronology statistics -------------------------------------------------
function chronSection(cs) {
  if (!cs) return '';
  if (cs.error) return '<h2>Chronology statistics</h2><p class="muted">' + esc(cs.error) + '</p>';
  const S = cs.summary, T = cs.trees;
  const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d == null ? 3 : d) : '—');

  const grouping = T.grouped
    ? '<p class="kv"><b>Grouping: </b>' + T.nCores + ' cores in ' + T.nTrees + ' trees (' +
      T.multiCore + ' trees contributed more than one core)' +
      (T.inferred ? ', inferred from the core ids' : ', supplied') + '.</p>' +
      '<p class="note">Two radii of one tree share wood, not just climate, so counting them as ' +
      'independent replicates overstates the sampling. EPS is given both ways; the tree basis is ' +
      'the conservative one. If this grouping is wrong for your naming scheme, supply it.</p>'
    : '<p class="note">No tree grouping was detected in the series ids, so every series is ' +
      'treated as its own tree &mdash; the same convention COFECHA and dplR use by default.</p>';

  const eps = cs.windows.length
    ? '<div class="scroll"><table class="mat"><thead><tr><th>Window</th><th>Cores</th><th>Trees</th>' +
      '<th>rbar.wt</th><th>rbar.bt</th><th>rbar.eff</th><th>EPS (trees)</th><th>EPS (cores)</th>' +
      '<th>SNR</th></tr></thead><tbody>' +
      cs.windows.map(w => {
        const ok = Number.isFinite(w.eps) && w.eps >= S.epsThreshold;
        return '<tr><td>' + yr(w.startYear) + '&ndash;' + yr(w.endYear) + '</td>' +
          '<td>' + w.nCores + '</td><td>' + w.nTrees + '</td>' +
          '<td>' + num(w.rbarWt) + '</td><td>' + num(w.rbarBt) + '</td><td>' + num(w.rbarEff) + '</td>' +
          '<td class="' + (ok ? 'good' : 'bad') + '">' + num(w.eps) + '</td>' +
          '<td>' + num(w.epsCores) + '</td><td>' + num(w.snr, 1) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<p class="muted">Not enough overlap for a running window.</p>';

  return '<h2>Chronology statistics</h2>' +
    '<p class="statement">' + esc(S.statement) + '</p>' +
    grouping +
    '<p class="kv"><b>Mean correlation: </b>within tree ' + num(S.rbarWt) +
    ', between trees ' + num(S.rbarBt) + ', effective ' + num(S.rbarEff) + '</p>' +
    '<p class="kv"><b>EPS: </b>mean ' + num(S.epsMean) + ', most recent window ' + num(S.epsLatest) +
    '  &middot;  <b>SNR </b>' + num(S.snr, 1) + '</p>' +
    '<p class="note">EPS asks whether enough trees agree, not whether they are correctly dated: a ' +
    'chronology can score well here and still carry a dating error in one member, which is what ' +
    'the Verdict above is for. COFECHA reports neither statistic.</p>' +
    eps;
}

// ---- Per-series evidence ---------------------------------------------------
// The heatmap IS the evidence for the verdict, so it is drawn for any series
// that did not come back cleanly dated.
function heatmapFor(v) {
  if (!v || !v.heatmap) return '';
  let svg;
  try {
    svg = toSVG(heatmapPlot(v.heatmap, {
      s1: 'chronology without this series', s2: v.id, width: 820, height: 260,
    }));
  } catch (e) { return ''; }
  const ridge = v.runs && v.runs.length
    ? '<p class="note">Best-fitting position: ' +
      v.runs.map(r => 'lag ' + (r.lag > 0 ? '+' : '') + r.lag + ' from ' + yr(r.from) + ' to ' +
        yr(r.to) + ' (mean r ' + r.meanR.toFixed(2) + ')').join('; ') + '.</p>'
    : '';
  return '<div class="hm">' + svg + ridge + '</div>';
}

// ---- Part 1 ---------------------------------------------------------------
function part1(res, opts) {
  const o = res.options, S = res.summary;
  const det = o.splineLength > 0
    ? o.splineLength + '-year spline (50% frequency response)'
    : 'none — untransformed measurements';
  const rows = [
    ['1  Spline rigidity for filtering', det],
    ['2  Segment length / lag', o.segLength + ' years, lagged ' + o.segLag +
      ' (' + Math.round(100 * (1 - o.segLag / o.segLength)) + '% overlap)'],
    ['3  Autoregressive modelling', o.arModel ? 'yes' : 'no'],
    ['4  Log transformation', o.logTransform ? 'yes (constant = mean/6)' : 'no'],
    ['5  Critical level', (100 * (1 - o.pcrit)).toFixed(0) + '% one-tailed (p = ' + o.pcrit + '), Pearson'],
    ['9  Absent rings in the master', o.omitAbsent ? 'omitted' : 'included'],
    ['F  First differences', o.firstDiff ? 'yes' : 'no'],
    ['   Alternate dating positions', '-' + o.shift + ' to +' + o.shift + ' years'],
  ].map(r => '<tr><td class="l">' + esc(r[0]) + '</td><td class="l">' + esc(r[1]) + '</td></tr>').join('');

  // absent rings listed by series (p. 211) — flagged when the master is not narrow
  const withAbsent = res.series.filter(s => s.problems.absent.length);
  let absentHtml;
  if (!withAbsent.length) {
    absentHtml = '<p class="muted">No absent rings (zero measurements) in the data set.</p>';
  } else {
    absentHtml = '<table><thead><tr><th class="l">Series</th><th class="l">Absent rings</th></tr></thead><tbody>' +
      withAbsent.map(s => '<tr><td class="l">' + esc(s.id) + '</td><td class="l">' +
        s.problems.absent.map(a => esc(a.year) + (a.notNarrow ? '<span class="bad" title="ring is not normally narrow — the master shows no narrow ring that year">&#8810;</span>' : '')).join(', ') +
        '</td></tr>').join('') + '</tbody></table>' +
      '<p class="note">&#8810; marks an absent ring that is <em>not</em> narrow in the other series — check the placement of the missing ring.</p>';
  }

  const interp = S.meanCorr >= 0.5
    ? 'At or above the 0.50 generally considered desirable for a site chronology (p. 214), though the value that counts as high depends on species, location and climate.'
    : 'Below the 0.50 generally considered desirable for a site chronology (p. 214) — expected for some species and settings, but worth checking against the flagged segments below.';

  return '<h2>Part 1 &mdash; Options, summary and absent rings</h2>' +
    '<h3>Options selected</h3>' +
    '<table class="opts"><tbody>' + rows + '</tbody></table>' +
    '<h3>Summary</h3>' +
    kv('Series analysed: ', S.nSeries) +
    kv('Interval covered: ', S.interval[0] + ' to ' + S.interval[1]) +
    kv('Average series length: ', fx(S.meanLength, 1) + ' years') +
    kv('Segments tested: ', S.nSegments) +
    kv('Segments flagged: ', S.nFlags + (isNum(S.pctFlagged) ? '  (' + S.pctFlagged.toFixed(1) + '%)' : '')) +
    kv('Average interseries correlation: ', fx(S.meanCorr, 3)) +
    kv('Average mean sensitivity: ', fx(S.meanSens, 3)) +
    '<p class="note">' + esc(interp) + '</p>' +
    '<h3>Absent rings by series</h3>' + absentHtml;
}

// ---- Part 2 ---------------------------------------------------------------
function part2(res) {
  const lo = res.summary.interval[0], hi = res.summary.interval[1];
  const span = Math.max(1, hi - lo);
  const rows = res.timeSpans.map(t => {
    const left = 100 * (t.first - lo) / span;
    const width = Math.max(0.6, 100 * (t.last - t.first) / span);
    return '<tr><td class="l">' + esc(t.seq) + '</td><td class="l">' + esc(t.id) + '</td>' +
      '<td class="bar"><span style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%"></span></td>' +
      '<td>' + esc(t.first) + '</td><td>' + esc(t.last) + '</td><td>' + esc(t.nYears) + '</td></tr>';
  }).join('');
  return '<h2>Part 2 &mdash; Histogram of time spans</h2>' +
    '<p class="note">Each series against the ' + esc(lo) + '&ndash;' + esc(hi) + ' range covered by all series. ' +
    'SEQ is the position of the series in the data file and is used throughout the rest of the output.</p>' +
    '<table><thead><tr><th class="l">Seq</th><th class="l">Series</th>' +
    '<th class="l">' + esc(lo) + '&nbsp;&rarr;&nbsp;' + esc(hi) + '</th>' +
    '<th>First</th><th>Last</th><th>Years</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ---- Part 3 + Part 4 ------------------------------------------------------
function part34(res, wantMaster, wantBar) {
  const y = res.years, M = res.master;
  const rows = [];
  for (let i = 0; i < y.length; i++) {
    if (!isNum(M.z[i])) continue;
    const z = M.z[i];
    const code = letterCode(z);
    // bar: centre at 50%, extend left for narrow rings and right for wide ones
    const mag = Math.min(Math.abs(z), 3) / 3 * 50;
    const bar = z >= 0
      ? '<span class="pos" style="left:50%;width:' + mag.toFixed(2) + '%"></span>'
      : '<span class="neg" style="left:' + (50 - mag).toFixed(2) + '%;width:' + mag.toFixed(2) + '%"></span>';
    rows.push('<tr><td>' + esc(y[i]) + '</td><td>' + fx(z, 3) + '</td>' +
      '<td>' + esc(M.sampleDepth[i]) + '</td><td>' + (M.absent[i] || '') + '</td>' +
      (wantBar ? '<td class="code">' + esc(code) + '</td><td class="bar mbar">' + bar + '</td>' : '') +
      '</tr>');
  }
  let out = '';
  if (wantMaster || wantBar) {
    out += '<h2>Part 3' + (wantBar ? ' &amp; 4' : '') + ' &mdash; Master dating series' +
      (wantBar ? ', with bar plot' : ' with sample depth and absent rings') + '</h2>' +
      '<p class="note">The master is standardized to mean 0 and standard deviation 1. Negative values are ' +
      'narrow rings, positive values wide; values beyond &plusmn;2.0 are rare and make useful marker rings. ' +
      '<b>No</b> is the sample depth for that year and <b>Ab</b> the number of absent rings.' +
      (wantBar ? ' In the bar plot each letter is a further 0.25 SD from the mean &mdash; upper case wider, lower case narrower, <b>@</b> very close to the mean.' : '') +
      '</p>' +
      '<div class="scroll"><table><thead><tr><th>Year</th><th>Index</th><th>No</th><th>Ab</th>' +
      (wantBar ? '<th>Code</th><th class="l">narrow &nbsp;&larr;&nbsp;|&nbsp;&rarr;&nbsp; wide</th>' : '') +
      '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  return out;
}

// ---- Part 5 ---------------------------------------------------------------
function part5(res) {
  const bins = res.grid.binStarts, L = res.grid.segLength;
  const head1 = bins.map(b => '<th>' + esc(b) + '</th>').join('');
  const head2 = bins.map(b => '<th>' + esc(b + L - 1) + '</th>').join('');
  const rows = res.series.map(s => {
    const cells = new Array(bins.length).fill('<td></td>');
    for (const g of s.segments) {
      if (!(g.col >= 0 && g.col < bins.length)) continue;
      const cls = g.flag === 'B' ? 'flagB' : (g.flag === 'A' ? 'flagA' : '');
      const tip = 'segment ' + g.start + '–' + g.end + ', n = ' + g.n +
        ', r = ' + fx(g.r, 3) + ', critical r = ' + fx(g.crit, 3) +
        (g.flag === 'B' ? '; higher r = ' + fx(g.rHigh, 3) + ' at shift ' + (g.high > 0 ? '+' : '') + g.high : '');
      cells[g.col] = '<td class="' + cls + '" title="' + esc(tip) + '">' + fr(g.r) + (g.flag || '') + '</td>';
    }
    return '<tr><td class="l">' + esc(s.seq) + '</td><td class="l">' + esc(s.id) + '</td>' +
      '<td class="l">' + esc(s.first) + ' ' + esc(s.last) + '</td>' + cells.join('') + '</tr>';
  }).join('');
  return '<h2>Part 5 &mdash; Correlation of each series with the master</h2>' +
    '<p class="note">Each segment is correlated against the master with the tested series removed from it. ' +
    'A segment is flagged when its correlation is not positive and significant at the chosen level: ' +
    '<span class="flagA k">A</span> no better match was found within &plusmn;' + esc(res.options.shift) +
    ' years, <span class="flagB k">B</span> a higher correlation was found at another dating position. ' +
    'Hover a cell for the segment&rsquo;s true span, <em>n</em>, and critical value &mdash; segments at the ' +
    'start and end of a series do not line up with the column headings.</p>' +
    '<div class="scroll"><table class="mat"><thead>' +
    '<tr><th class="l">Seq</th><th class="l">Series</th><th class="l">Time span</th>' + head1 + '</tr>' +
    '<tr><th></th><th></th><th></th>' + head2 + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ---- Part 6 ---------------------------------------------------------------
function part6(res, vmap) {
  const shifts = [];
  for (let d = -res.options.shift; d <= res.options.shift; d++) shifts.push(d);
  const blocks = [];

  for (const s of res.series) {
    const P = s.problems;
    const hasAny = s.nFlags || P.divergent.length || P.absent.length || P.outliers.length;
    if (!hasAny) continue;
    const parts = [];

    // [A] alternate dating positions for flagged segments
    const flagged = s.segments.filter(g => g.flag);
    if (flagged.length) {
      const hd = shifts.map(d => '<th>' + (d > 0 ? '+' : '') + d + '</th>').join('');
      const rows = flagged.map(g => {
        const cells = shifts.map(d => {
          const r = g.rByShift[d - g.shiftMin];
          const n = g.nByShift[d - g.shiftMin];
          const sig = isNum(r) && r > 0 && n >= 3 && r >= g.crit;
          const best = d !== 0 && d === g.high && g.flag === 'B';
          return '<td class="' + (best ? 'best' : '') + '">' + fr(r) + (sig ? '<sup>*</sup>' : '') + '</td>';
        }).join('');
        return '<tr><td class="l">' + esc(g.start) + ' ' + esc(g.end) + '</td>' +
          '<td class="hi">' + (g.flag === 'B' ? (g.high > 0 ? '+' : '') + g.high : '') + '</td>' + cells + '</tr>';
      }).join('');
      parts.push('<h4>[A] Correlations at alternate dating positions</h4>' +
        '<div class="scroll"><table class="mat"><thead><tr><th class="l">Segment</th><th>High</th>' + hd +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="note"><b>High</b> is the shift giving the best correlation: +1 means the segment correlates ' +
        'better one year later. <sup>*</sup> marks a correlation significant at the chosen level.</p>');
    }

    // [B] years that most lower / raise the correlation
    const lev = P.leverage;
    if (lev.entire || lev.segments.length) {
      const fmtPairs = a => a.map(e => esc(e.year) + '&nbsp;' + fr(e.delta, 3)).join('&nbsp;&nbsp; ');
      const bits = [];
      if (lev.entire) {
        bits.push('<p class="lev"><b>Entire series</b>, effect on correlation (' + fr(lev.entire.r, 3) + ') is:<br>' +
          '<span class="lo">Lower &nbsp;</span>' + fmtPairs(lev.entire.lower) + '<br>' +
          '<span class="hiy">Higher</span> ' + fmtPairs(lev.entire.higher) + '</p>');
      }
      for (const g of lev.segments) {
        bits.push('<p class="lev"><b>' + esc(g.start) + ' to ' + esc(g.end) + '</b> segment (' + fr(g.r, 3) + '):<br>' +
          '<span class="lo">Lower &nbsp;</span>' + fmtPairs(g.lower) + '<br>' +
          '<span class="hiy">Higher</span> ' + fmtPairs(g.higher) + '</p>');
      }
      parts.push('<h4>[B] Years most affecting the correlation</h4>' + bits.join('') +
        '<p class="note">A negative value is the amount by which including that year&rsquo;s ring <em>lowers</em> ' +
        'the correlation. In a misdated segment these years cluster in the errant portion.</p>');
    }

    // [C] divergent year-to-year change
    if (P.divergent.length) {
      parts.push('<h4>[C] Year-to-year changes diverging from all other series</h4>' +
        '<table><thead><tr><th>Year</th><th>Change</th><th>Mean change</th><th>SD</th><th>Departure</th></tr></thead><tbody>' +
        P.divergent.map(d => '<tr><td>' + esc(d.year) + '</td><td>' + fx(d.change, 3) + '</td><td>' +
          fx(d.meanOther, 3) + '</td><td>' + fx(d.sdOther, 3) + '</td><td class="bad">' +
          fx(d.sd, 1) + ' SD</td></tr>').join('') + '</tbody></table>' +
        '<p class="note">A change of &plusmn;' + esc(res.options.divergeSD) + ' SD or more from the mean change in ' +
        'all other series &mdash; where a false ring was inserted or a missing ring passed over.</p>');
    }

    // [D] absent rings
    if (P.absent.length) {
      parts.push('<h4>[D] Absent rings</h4>' +
        '<table><thead><tr><th>Year</th><th>Master</th><th>Depth</th><th>Absent in all series</th><th class="l"></th></tr></thead><tbody>' +
        P.absent.map(a => '<tr><td>' + esc(a.year) + '</td><td>' + fx(a.masterZ, 3) + '</td><td>' +
          esc(a.sampleDepth) + '</td><td>' + esc(a.totalAbsent) + '</td><td class="l' + (a.notNarrow ? ' bad' : '') + '">' +
          (a.notNarrow ? 'ring is not normally narrow' : '') + '</td></tr>').join('') + '</tbody></table>');
    }

    // [E] outliers
    if (P.outliers.length) {
      parts.push('<h4>[E] Outlier measurements</h4>' +
        '<table><thead><tr><th>Year</th><th>Index</th><th>Mean of others</th><th>SD</th><th>Departure</th></tr></thead><tbody>' +
        P.outliers.map(x => '<tr><td>' + esc(x.year) + '</td><td>' + fx(x.value, 3) + '</td><td>' +
          fx(x.meanOther, 3) + '</td><td>' + fx(x.sdOther, 3) + '</td><td class="bad">' +
          fx(x.sd, 1) + ' SD ' + esc(x.side) + '</td></tr>').join('') + '</tbody></table>' +
        '<p class="note">More than ' + esc(res.options.outlierHigh) + ' SD above or ' + esc(res.options.outlierLow) +
        ' SD below the mean of all other series for that year &mdash; re-measure, or a clue to where a segment is misdated.</p>');
    }

    // The verdict for this series, and the heatmap it came from, lead the block:
    // a reader should know whether this series is actually misdated before
    // reading the segment diagnostics that follow.
    const v = vmap ? vmap[s.id + '|' + s.first + '|' + s.last] : null;
    const head = v && v.status !== 'dated'
      ? '<p class="v-lead v-' + esc(v.status) + '">' + esc(v.message) + '</p>' + heatmapFor(v)
      : (v ? '<p class="v-lead v-dated">' + esc(v.message) +
             ' The diagnostics below are worth a look for measurement problems, ' +
             'but none of them indicates a dating error.</p>' : '');

    blocks.push('<div class="ser"><h3>' + esc(s.seq) + '&nbsp; ' + esc(s.id) + '&nbsp; <span class="muted">' +
      yr(s.first) + ' to ' + yr(s.last) + ' (' + esc(s.nYears) + ' years), ' + s.nFlags + ' flagged segment' +
      (s.nFlags === 1 ? '' : 's') + '</span></h3>' + head + parts.join('') + '</div>');
  }

  return '<h2>Part 6 &mdash; Potential problems</h2>' +
    (blocks.length ? blocks.join('') : '<p class="muted">No series raised any of the Part 6 diagnostics.</p>');
}

// ---- Part 7 ---------------------------------------------------------------
function part7(res) {
  const S = res.summary;
  const rows = res.series.map(s => '<tr>' +
    '<td class="l">' + esc(s.seq) + '</td><td class="l">' + esc(s.id) + '</td>' +
    '<td class="l">' + esc(s.first) + ' ' + esc(s.last) + '</td>' +
    '<td>' + esc(s.nYears) + '</td><td>' + esc(s.nSegments) + '</td>' +
    '<td class="' + (s.nFlags ? 'bad' : '') + '">' + esc(s.nFlags) + '</td>' +
    '<td>' + fx(s.corrWithMaster, 3) + '</td>' +
    '<td>' + fx(s.stats.meanMsmt, 3) + '</td><td>' + fx(s.stats.maxMsmt, 3) + '</td>' +
    '<td>' + fx(s.stats.sdMsmt, 3) + '</td><td>' + fx(s.stats.ac1Msmt, 3) + '</td>' +
    '<td>' + fx(s.stats.meanSens, 3) + '</td>' +
    '<td>' + fx(s.stats.maxIndex, 3) + '</td><td>' + fx(s.stats.sdIndex, 3) + '</td>' +
    '<td>' + fx(s.stats.ac1Index, 3) + '</td><td>' + esc(s.arOrder) + '</td></tr>').join('');
  return '<h2>Part 7 &mdash; Descriptive statistics</h2>' +
    '<div class="scroll"><table class="mat"><thead>' +
    '<tr><th colspan="7"></th><th colspan="5">Unfiltered measurements</th><th colspan="4">Detrended series</th></tr>' +
    '<tr><th class="l">Seq</th><th class="l">Series</th><th class="l">Interval</th><th>Years</th>' +
    '<th>Segmt</th><th>Flags</th><th>Corr w/ master</th>' +
    '<th>Mean</th><th>Max</th><th>Std dev</th><th>Auto corr</th><th>Mean sens</th>' +
    '<th>Max</th><th>Std dev</th><th>Auto corr</th><th>AR</th></tr></thead><tbody>' + rows +
    '<tr class="tot"><td colspan="3" class="l">Total or mean</td><td>' + fx(S.meanLength, 0) + '</td>' +
    '<td>' + esc(S.nSegments) + '</td><td>' + esc(S.nFlags) + '</td><td>' + fx(S.meanCorr, 3) + '</td>' +
    '<td colspan="4"></td><td>' + fx(S.meanSens, 3) + '</td><td colspan="4"></td></tr>' +
    '</tbody></table></div>' +
    '<p class="note">High standard deviation and mean sensitivity are desirable; low autocorrelation is. ' +
    'Mean sensitivity below 0.20 is low, 0.20&ndash;0.29 intermediate, above 0.30 sensitive (p. 214). ' +
    'Autocorrelation on the detrended series should be near zero once the AR model has done its work; ' +
    '<b>AR</b> is the order selected.</p>';
}

const CSS = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--mut:#6b7280;--line:#d4d9de;
  --head:#f2f4f6;--bad:#a3322a;--badbg:#fbeceb;--warn:#8a6300;--warnbg:#fdf4e0;
  --ok:#2f6f4f;--bar:#8a6529;--barbg:#efe6d6}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#16181a;--mut:#9aa3ad;
  --line:#3a4046;--head:#22262a;--bad:#f09a92;--badbg:#3a2220;--warn:#e8c477;
  --warnbg:#3a3020;--ok:#8fd4ae;--bar:#c8a86a;--barbg:#2c2a24}}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;
  color:var(--fg);background:var(--bg);max-width:1100px;margin:0 auto;padding:28px 20px}
h1{font-size:1.7rem;margin:0 0 .2rem;border-bottom:2px solid var(--line);padding-bottom:.35rem}
h2{font-size:1.25rem;margin:2.2rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.2rem}
h3{font-size:1.05rem;margin:1.4rem 0 .4rem}
h4{font-size:.95rem;margin:1rem 0 .3rem;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
p{margin:.35rem 0}
.sub{color:var(--mut);margin:0 0 1rem}
.kv{margin:.1rem 0}.kv b{display:inline-block;min-width:16rem}
.muted{color:var(--mut)}.note{color:var(--mut);font-size:.86rem;margin:.4rem 0 .2rem}
.bad{color:var(--bad)}
table{border-collapse:collapse;font-size:.85rem;width:100%;margin:.5rem 0}
th,td{border:1px solid var(--line);padding:3px 7px;text-align:right;white-space:nowrap}
th{background:var(--head);font-weight:600}
.l{text-align:left}
table.opts td{white-space:normal}table.opts{width:auto}
.scroll{overflow-x:auto;max-width:100%}
table.mat{width:auto;min-width:100%;font-variant-numeric:tabular-nums}
td.flagA{background:var(--warnbg);color:var(--warn);font-weight:700}
td.flagB{background:var(--badbg);color:var(--bad);font-weight:700}
td.best{background:var(--badbg);font-weight:700}
td.hi{font-weight:700}
.k{display:inline-block;padding:0 5px;border-radius:3px;font-weight:700}
td.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:700}
td.bar{position:relative;width:45%;min-width:180px;background:var(--barbg);padding:0;height:1.1rem}
td.bar>span{position:absolute;top:2px;bottom:2px;background:var(--bar);border-radius:1px}
td.mbar>span.neg{background:var(--bad)}td.mbar>span.pos{background:var(--ok)}
tr.tot td{font-weight:700;background:var(--head)}
.ser{margin:1.4rem 0 1.8rem;padding-left:.8rem;border-left:3px solid var(--line)}
.lev{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.82rem;
  background:var(--head);padding:6px 9px;border-radius:4px;margin:.4rem 0}
.lo{color:var(--bad);font-weight:700}.hiy{color:var(--ok);font-weight:700}
sup{font-size:.7em}
h2.verdict-h{margin-top:1rem;border-bottom-width:2px}
h2.ev-h{margin-top:2.6rem;border-bottom-width:2px}
.ok-big{font-size:1.15rem;font-weight:600;color:var(--ok);margin:.4rem 0}
.bad-big{font-size:1.15rem;font-weight:600;color:var(--bad);margin:.4rem 0}
.statement{background:var(--head);border-left:3px solid var(--bar);padding:.6rem .9rem;
  margin:.6rem 0;font-size:.95rem}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.72rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.03em}
.t-dating-error{background:var(--badbg);color:var(--bad)}
.t-offset{background:var(--badbg);color:var(--bad)}
.t-unstable,.t-no-signal{background:var(--warnbg);color:var(--warn)}
.t-dated{background:var(--head);color:var(--ok)}
ul.coll{font-size:.9rem;margin:.4rem 0 .4rem 1.1rem}ul.coll li{margin:.25rem 0}
.v-lead{font-size:.95rem;padding:.5rem .8rem;border-radius:4px;margin:.4rem 0;
  background:var(--head);border-left:3px solid var(--line)}
.v-lead.v-dating-error,.v-lead.v-offset{background:var(--badbg);border-left-color:var(--bad)}
.v-lead.v-unstable,.v-lead.v-no-signal{background:var(--warnbg);border-left-color:var(--warn)}
.hm{margin:.6rem 0}.hm svg{max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px}
td.good{color:var(--ok);font-weight:600}
`;

// ---------------------------------------------------------------------------
// renderCofecha(resultOrFrame, opts) -> HTML string.
// Accepts either a cofecha() result or a raw Frame (which it runs first).
//   opts.title   run identification (COFECHA's job identification, p. 206)
//   opts.file    name of the measurement file
//   opts.date    run time
//   opts.parts   array of part numbers to print (Option 8, p. 210); default 1-7
// ---------------------------------------------------------------------------
function renderCofecha(input, opts) {
  opts = opts || {};
  const res = (input && input.summary && input.series) ? input : cofecha(input, opts.cofecha || {});
  const want = new Set(opts.parts || [1, 2, 3, 4, 5, 6, 7]);
  const when = opts.date != null ? String(opts.date) : new Date().toString();

  // The verdict and chronology statistics are optional: pass them in and the
  // report leads with the answer, omit them and it is the plain COFECHA layout.
  const verdict = opts.verdict || null;
  const chron = opts.chron || null;
  const vmap = {};
  if (verdict) verdict.series.forEach(v => { vmap[v.id + '|' + v.first + '|' + v.last] = v; });

  const body = [];
  body.push('<h1>' + esc(opts.title || 'Crossdating quality check') + '</h1>');
  body.push('<p class="sub">COFECHA-equivalent analysis &middot; ' + esc(when) +
    (opts.file ? ' &middot; ' + esc(opts.file) : '') + '</p>');
  if (verdict) body.push(verdictSection(verdict));
  if (chron) body.push(chronSection(chron));
  if (verdict || chron) {
    body.push('<h2 class="ev-h">Evidence</h2><p class="note">Everything below is the COFECHA ' +
      'output in its own numbering and vocabulary &mdash; the same eight parts, the same A/B flags, ' +
      'the same critical value &mdash; so it can be read by anyone used to COFECHA and diffed ' +
      'against a real run.</p>');
  }
  if (want.has(1)) body.push(part1(res, opts));
  if (want.has(2)) body.push(part2(res));
  if (want.has(3) || want.has(4)) body.push(part34(res, want.has(3), want.has(4)));
  if (want.has(5)) body.push(part5(res));
  if (want.has(6)) body.push(part6(res, vmap));
  if (want.has(7)) body.push(part7(res));
  body.push('<h2>Part 8 &mdash; Undated series</h2>' +
    '<p class="note">COFECHA&rsquo;s Part 8 places undated series against the master. In RingdateR that is the ' +
    'job of the crossdating run itself (Explore &rarr; lead/lag), which searches every possible overlap rather ' +
    'than the eleven best matches per segment, so it is not duplicated here.</p>');
  body.push('<p class="note">Diagnostics follow Grissino-Mayer, H.D. (2001) <em>Evaluating crossdating accuracy: ' +
    'a manual and tutorial for the computer program COFECHA</em>, Tree-Ring Research 57(2):205&ndash;221; ' +
    'COFECHA itself is by Richard L. Holmes (1983). Page references above are to that paper. ' +
    'As its author stresses, this is a quality check on crossdating &mdash; not a substitute for it: the decision ' +
    'whether a series is correctly dated rests with the dendrochronologist.</p>');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(opts.title || 'Crossdating quality check') + '</title>' +
    '<style>' + CSS + '</style></head>\n<body>\n' + body.join('\n') + '\n</body></html>\n';
}

module.exports = { renderCofecha, letterCode };
