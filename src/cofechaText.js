'use strict';
// ============================================================================
// cofechaText.js — write a cofecha() result in COFECHA's own fixed-width layout.
//
// WHY. Someone moving off COFECHA has no way to check a replacement except by
// running both and comparing. An HTML report cannot be diffed against a .OUT
// listing; this can. The layout below is taken from a real COFECHA 6.06 run
// (UT550COF.OUT, produced by Cofecha_MRWE.exe on chronologies/ut550.rwl), and
// tools/cofecha_compare.js — written to read COFECHA's output — parses what
// this emits, which is how the round-trip test verifies the columns.
//
// It is a re-implementation of the LAYOUT, not a byte-exact forgery: the header
// line names RingdateR rather than claiming to be COFECHA, and the parts that
// are known not to reproduce (see cofecha.js) are the same ones that differ
// here. Anything reading this should be able to tell where it came from.
//
// COFECHA prints correlations without a leading zero (".671", "-.132") and pads
// to fixed columns; both are reproduced, because a diff tool keyed to those
// columns is the entire point.
// ============================================================================

const { formatCal } = require('./io/year.js');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
// ".67" / "-.13" — COFECHA's correlation format
const fr = (v, w, d) => {
  d = d == null ? 2 : d;
  const t = isNum(v) ? (v < 0 ? '-' : '') + Math.abs(v).toFixed(d).replace(/^0/, '') : '';
  return t.padStart(w == null ? 5 : w);
};
const fn = (v, w, d) => (isNum(v) ? v.toFixed(d) : '').padStart(w);
const fi = (v, w) => String(v == null ? '' : v).padStart(w);
const fs_ = (v, w) => String(v == null ? '' : v).padEnd(w);

function rule(n) { return '-'.repeat(n); }

// Part 5 spans several pages; its body emits this wherever a new page header
// belongs, and the assembler swaps in a real one so numbering stays sequential.
const PAGE_BREAK = 'PAGE';

// COFECHA's page header, which is also how a reader (and tools/cofecha_compare)
// finds each part:  "PART 5:  CORRELATION OF SERIES BY SEGMENTS: ut550 ... Page 5"
const PART_TITLES = {
  1: 'OPTIONS, SUMMARY AND ABSENT RINGS',
  2: 'TIME PLOT OF TREE-RING SERIES',
  3: 'Master Dating Series',
  5: 'CORRELATION OF SERIES BY SEGMENTS',
  6: 'POTENTIAL PROBLEMS',
  7: 'DESCRIPTIVE STATISTICS',
};
function header(title, part, page) {
  const left = 'PART ' + part + ':  ' + PART_TITLES[part] + ': ' + (title || '');
  const right = 'RingdateR  Page ' + fi(page, 4);
  const pad = Math.max(2, 132 - left.length - right.length);
  return [left + ' '.repeat(pad) + right, rule(132), ''];
}

// ---------------------------------------------------------------------------
// Part 1 — options, summary, absent rings by series
// ---------------------------------------------------------------------------
function part1(res, o) {
  const op = res.options, S = res.summary;
  const L = [];
  L.push(' QUALITY CONTROL AND DATING CHECK OF TREE-RING MEASUREMENTS', '');
  L.push(' Title of run:           ' + (o.title || ''));
  L.push(' File of DATED series:   ' + (o.file || ''), '');
  L.push(' RUN CONTROL OPTIONS SELECTED                             VALUE', '');
  L.push('         1  Cubic smoothing spline 50% wavelength cutoff for filtering');
  L.push(' '.repeat(60) + fi(op.splineLength, 4) + ' years');
  L.push('         2  Segments examined are' + fi(op.segLength, 29) +
    ' years lagged successively by ' + fi(op.segLag, 3) + ' years');
  L.push('         3  Autoregressive model applied' + ' '.repeat(21) +
    (op.arModel ? 'A  Residuals are used in master dating series and testing'
                : 'N  Not applied'));
  L.push('         4  Series transformed to logarithms' + ' '.repeat(17) +
    (op.logTransform ? 'Y  Each series log-transformed for master dating series and testing'
                     : 'N  Not transformed'));
  L.push('         5  CORRELATION is Pearson (parametric, quantitative)');
  L.push('            Critical correlation, ' +
    (100 * (1 - op.pcrit)).toFixed(0) + '% confidence level  ' +
    fn(res.series.length ? criticalOf(res) : NaN, 6, 4));
  L.push('         9  Absent rings are ' +
    (op.omitAbsent ? 'omitted from' : 'included in') +
    ' master series and segment correlations', '');
  L.push(' Time span of Master dating series is ' + fi(S.interval[0], 6) + ' to ' +
    fi(S.interval[1], 6) + fi(S.interval[1] - S.interval[0] + 1, 6) + ' years', '');

  // absent rings that are not narrow in the master — COFECHA's ">>" lines
  for (const s of res.series) {
    for (const a of s.problems.absent) {
      if (!a.notNarrow) continue;
      L.push(' >> ' + fs_(s.id, 10) + fi(a.year, 6) + ' absent in ' + fi(a.totalAbsent, 3) +
        ' of ' + fi(a.sampleDepth, 3) + ' series, but is not usually narrow: master index is ' +
        fn(a.masterZ, 7, 3));
    }
  }
  L.push('');
  return L;
}

// The critical value COFECHA prints is the one for a full-length segment.
function criticalOf(res) {
  for (const s of res.series) {
    for (const g of s.segments) if (g.n === res.options.segLength) return g.crit;
  }
  const any = res.series.find(s => s.segments.length);
  return any ? any.segments[0].crit : NaN;
}

// ---------------------------------------------------------------------------
// Part 2 — time plot of the series
// ---------------------------------------------------------------------------
function part2(res) {
  // COFECHA puts the time plot on the LEFT and the identification columns on the
  // right: a row of year labels, a row of ticks, then one line per series with
  // "." at each tick and "<===>" spanning the years it covers.
  const L = [];
  const [lo, hi] = res.summary.interval;
  const span = Math.max(1, hi - lo);
  // one 5-character column per step; choose a step so the plot stays ~100 wide
  const step = Math.max(50, Math.ceil(span / 20 / 50) * 50);
  const first = Math.floor(lo / step) * step;
  const nCol = Math.floor((hi - first) / step) + 1;
  const colOf = y => Math.round((y - first) / step * 5);   // character offset
  const width = (nCol - 1) * 5 + 1;

  let labels = '';
  for (let c = 0; c < nCol; c++) labels += fi(first + c * step, 5);
  let ticks = '';
  for (let c = 0; c < nCol; c++) ticks += '    :';

  L.push(labels + ' Ident   Seq Time-span  Yrs');
  L.push(ticks + ' -------- --- ---- ---- ----');
  for (const t of res.timeSpans) {
    const row = ticks.split('').map(ch => (ch === ':' ? '.' : ' '));
    const a = Math.max(0, Math.min(width - 1, colOf(t.first)));
    const b = Math.max(a, Math.min(width - 1, colOf(t.last)));
    row[a] = '<';
    for (let i = a + 1; i < b; i++) row[i] = '=';
    if (b > a) row[b] = '>';
    L.push(row.join('') + ' ' + fs_(t.id, 8) + fi(t.seq, 4) + fi(t.first, 5) +
      fi(t.last, 5) + fi(t.nYears, 5));
  }
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// Part 3 — master dating series with sample depth and absent rings
// ---------------------------------------------------------------------------
function part3(res) {
  const L = [];
  const cols = 6;
  const head = [], sep = [];
  for (let c = 0; c < cols; c++) { head.push('  Year  Value  No Ab'); sep.push('  ' + rule(18)); }
  L.push(head.join('  '), sep.join('  '));
  const rows = [];
  for (let i = 0; i < res.years.length; i++) {
    if (!isNum(res.master.z[i])) continue;
    rows.push(fi(res.years[i], 6) + fn(res.master.z[i], 7, 3) + fi(res.master.sampleDepth[i], 4) +
      (res.master.absent[i] ? fi(res.master.absent[i], 3) : '   '));
  }
  const per = Math.ceil(rows.length / cols) || 1;
  for (let r = 0; r < per; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const idx = c * per + r;
      line.push(idx < rows.length ? rows[idx] : ' '.repeat(20));
    }
    L.push(line.join('  ').replace(/\s+$/, ''));
  }
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// Part 5 — correlation of each series by segment, on COFECHA's global grid
// ---------------------------------------------------------------------------
function part5(res, perPage) {
  perPage = perPage || 20;
  const L = [];
  const bins = res.grid.binStarts, len = res.grid.segLength;
  const crit = criticalOf(res);
  for (let p0 = 0; p0 < bins.length; p0 += perPage) {
    const page = bins.slice(p0, p0 + perPage);
    L.push(PAGE_BREAK);
    L.push(' Correlations of ' + fi(len, 3) + '-year dated segments, lagged ' +
      fi(res.grid.segLag, 3) + ' years');
    L.push(' Flags:  A = correlation under ' + fn(crit, 7, 4) +
      ' but highest as dated;  B = correlation higher at other than dated position', '');
    L.push(' Seq Series  Time_span  ' + page.map(b => fi(b, 5)).join(''));
    L.push('                        ' + page.map(b => fi(b + len - 1, 5)).join(''));
    L.push(' --- -------- ---------  ' + page.map(() => '----').join(' '));
    for (const s of res.series) {
      const cells = page.map(() => '    ');
      let any = false;
      for (const g of s.segments) {
        const c = g.col - p0;
        if (c < 0 || c >= page.length) continue;
        any = true;
        cells[c] = (fr(g.r, 4) + (g.flag || '')).slice(-4).padStart(4);
      }
      if (!any) continue;
      L.push(fi(s.seq, 4) + ' ' + fs_(s.id, 8) + fi(s.first, 5) + fi(s.last, 5) + '  ' +
        cells.join(' ').replace(/\s+$/, ''));
    }
    L.push('');
  }
  return L;
}

// ---------------------------------------------------------------------------
// Part 6 — potential problems, per series
// ---------------------------------------------------------------------------
function part6(res, verdict) {
  const L = [];
  const shift = res.options.shift;
  const vmap = {};
  if (verdict) verdict.series.forEach(v => { vmap[v.id + '|' + v.first + '|' + v.last] = v; });
  let any = false;
  for (const s of res.series) {
    const P = s.problems;
    if (!(s.nFlags || P.divergent.length || P.absent.length || P.outliers.length)) continue;
    any = true;
    L.push('', ' ' + fs_(s.id, 9) + fi(s.first, 6) + ' to ' + fi(s.last, 6) + fi(s.nYears, 7) +
      ' years' + ' '.repeat(50) + 'Series ' + fi(s.seq, 4));

    const v = vmap[s.id + '|' + s.first + '|' + s.last];
    if (v && v.status !== 'dated') {
      // Not a COFECHA section. Marked so, because a reader diffing this against a
      // real listing must be able to see what is not COFECHA's.
      L.push('', ' [V] VERDICT (RingdateR, not part of COFECHA output)');
      L.push('     ' + v.message);
    }

    const flagged = s.segments.filter(g => g.flag);
    if (flagged.length) {
      L.push('', ' [A] Segment   High' +
        Array.from({ length: 2 * shift + 1 }, (_, k) => fi((k - shift > 0 ? '+' : '') + (k - shift), 5)).join(''));
      L.push('    ' + rule(9) + '  ' + rule(4) + '  ' +
        Array.from({ length: 2 * shift + 1 }, () => '---').join('  '));
      for (const g of flagged) {
        const cells = [];
        for (let d = -shift; d <= shift; d++) {
          const r = g.rByShift[d - g.shiftMin];
          const n = g.nByShift[d - g.shiftMin];
          const sig = isNum(r) && r > 0 && n >= 3 && r >= g.crit;
          cells.push((fr(r, 4) + (sig ? '*' : d === 0 ? '|' : ' ')).padStart(5));
        }
        L.push('    ' + fi(g.start, 4) + fi(g.end, 5) + fi(g.flag === 'B' ? g.high : 0, 5) + ' ' +
          cells.join(''));
      }
    }

    const lev = P.leverage;
    if (lev.entire) {
      const pair = a => a.map(e => fi(e.year, 6) + fr(e.delta, 7, 3)).join('  ');
      L.push('', ' [B] Entire series, effect on correlation (' + fn(lev.entire.r, 6, 3) + ') is:');
      L.push('       Lower  ' + pair(lev.entire.lower) + '   Higher  ' + pair(lev.entire.higher));
      for (const g of lev.segments) {
        L.push('     ' + g.start + ' to ' + g.end + ' segment:');
        L.push('       Lower  ' + pair(g.lower) + '   Higher  ' + pair(g.higher));
      }
    }

    if (P.divergent.length) {
      L.push('', ' [C] Year-to-year changes diverging by ' + res.options.divergeSD +
        ' SD or more from the mean change in all other series');
      for (const d of P.divergent) L.push('     ' + fi(d.year, 6) + fn(d.sd, 8, 1) + ' SD');
    }

    if (P.absent.length) {
      L.push('', ' [D] ' + fi(P.absent.length, 4) + ' Absent rings:  Year   Master  N series Absent');
      for (const a of P.absent) {
        L.push(' '.repeat(24) + fi(a.year, 6) + fn(a.masterZ, 9, 3) + fi(a.sampleDepth, 8) +
          fi(a.totalAbsent, 8) + (a.notNarrow ? '   ring is not normally narrow' : ''));
      }
    }

    if (P.outliers.length) {
      L.push('', ' [E] Outliers   ' + fi(P.outliers.length, 4) + ' 3.0 SD above or 4.5 SD below mean for year');
      for (const x of P.outliers) {
        L.push(' '.repeat(5) + fi(x.year, 6) + fn(x.sd, 8, 1) + ' SD');
      }
    }
  }
  if (!any) L.push(' No series raised any of the Part 6 diagnostics.');
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// Part 7 — descriptive statistics
// ---------------------------------------------------------------------------
function part7(res) {
  const S = res.summary;
  const L = [];
  L.push(' '.repeat(48) + 'Corr   //-------- Unfiltered --------\\\\  //---- Filtered -----\\\\');
  L.push(' '.repeat(27) + 'No.    No.    No.    with   Mean   Max     Std   Auto   Mean   Max' +
    '     Std   Auto  AR');
  L.push(' Seq Series   Interval   Years  Segmt  Flags   Master  msmt   msmt    dev   corr' +
    '   sens  value    dev   corr  ()');
  L.push(' --- -------- ---------  -----  -----  -----   ------ -----  -----  -----  -----' +
    '  -----  -----  -----  -----  --');
  for (const s of res.series) {
    const t = s.stats;
    L.push(fi(s.seq, 4) + ' ' + fs_(s.id, 8) + fi(s.first, 5) + fi(s.last, 5) +
      fi(s.nYears, 7) + fi(s.nSegments, 7) + fi(s.nFlags, 7) + '  ' +
      fn(s.corrWithMaster, 6, 3) + fn(t.meanMsmt, 7, 2) + fn(t.maxMsmt, 7, 2) +
      fn(t.sdMsmt, 7, 3) + fn(t.ac1Msmt, 7, 3) + fn(t.meanSens, 7, 3) +
      fn(t.maxIndex, 7, 2) + fn(t.sdIndex, 7, 3) + fn(t.ac1Index, 7, 3) + fi(s.arOrder, 4));
  }
  L.push(' --- -------- ---------  -----  -----  -----   ------ -----  -----  -----  -----' +
    '  -----  -----  -----  -----  --');
  L.push(' Total or mean:' + fi(Math.round(S.meanLength), 21) + fi(S.nSegments, 7) +
    fi(S.nFlags, 7) + '  ' + fn(S.meanCorr, 6, 3) + ' '.repeat(28) + fn(S.meanSens, 7, 3));
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// renderCofechaText(res, opts) -> string
//   opts.title / opts.file  run identification
//   opts.parts              which parts to print (default 1,2,3,5,6,7)
//   opts.verdict            optional crossdateVerdict result, added to Part 6
//                           under a [V] heading and clearly marked as ours
// ---------------------------------------------------------------------------
function renderCofechaText(res, opts) {
  opts = opts || {};
  const want = new Set(opts.parts || [1, 2, 3, 5, 6, 7]);
  const title = opts.title || '';
  let out = [];
  let page = 1;
  const add = (n, lines) => { out = out.concat(header(title, n, page++), lines); };
  if (want.has(1)) add(1, part1(res, opts));
  if (want.has(2)) add(2, part2(res));
  if (want.has(3)) add(3, part3(res));
  if (want.has(5)) {
    for (const ln of part5(res)) {
      if (ln === PAGE_BREAK) out = out.concat(header(title, 5, page++));
      else out.push(ln);
    }
  }
  if (want.has(6)) add(6, part6(res, opts.verdict));
  if (want.has(7)) add(7, part7(res));
  return out.join('\n') + '\n';
}

module.exports = { renderCofechaText };
