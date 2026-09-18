'use strict';
// ============================================================================
// cofecha_compare.js — diff src/stats/cofecha.js against the REAL COFECHA.
//
//   node tools/cofecha_compare.js <cofecha-output.OUT> <measurements.rwl>
//   node tools/cofecha_compare.js UT550COF.OUT chronologies/ut550.rwl
//
// Cofecha_MRWE.exe is COFECHA 6.06 built with Silverfrost FTN95 in "MRWE" mode:
// a GUI-subsystem binary that reads its own window, so it cannot be driven by
// piped stdin, a response file or a command-line argument. Produce the .OUT
// interactively once (see cofecha_run/HOWTO.txt), then point this at it.
//
// Three things are read back out of the listing and compared:
//   Part 3  the master dating series, with sample depth and absent-ring counts
//   Part 5  the segment correlation matrix and its A/B flags
//   Part 7  the per-series descriptive statistics
//
// Exact agreement is not the goal and is not achievable: COFECHA computes in
// single-precision Fortran and prints 2-3 decimals. What matters is that the
// same series are found over the same intervals, cut into the same segments,
// and reach the same verdict about each one.
// ============================================================================

const fs = require('fs');
const path = require('path');
const RD = require('../src/index.js');

let lines = [];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
// COFECHA prints correlations without the leading zero: ".671", "-.132"
function num(t) {
  t = String(t).trim();
  if (!/^-?(\d+)?\.?\d+$/.test(t)) return NaN;
  return Number(t.replace(/^-\./, '-0.').replace(/^\./, '0.'));
}

// Importable: `require('./cofecha_compare.js').parse(outPath)` returns the three
// parsed sections, so the test suite can diff against a real COFECHA listing.
function parse(outPath) {
  lines = fs.readFileSync(outPath, 'latin1').replace(/\r/g, '').split('\n');
  return { part7: parsePart7(), part5: parsePart5(), part3: parsePart3() };
}
module.exports = { parse };

const args = process.argv.filter(a => a !== '--verbose').slice(2);
if (require.main !== module) return;
const VERBOSE = process.argv.includes('--verbose');
if (args.length < 2) {
  console.error('usage: node tools/cofecha_compare.js <cofecha-output.OUT> <measurements.rwl> [--verbose]');
  process.exit(2);
}
const [outPath, rwlPath] = args;
lines = fs.readFileSync(outPath, 'latin1').replace(/\r/g, '').split('\n');


// ---------------------------------------------------------------------------
// Part 7 — per-series descriptive statistics.
// ---------------------------------------------------------------------------
function parsePart7() {
  const rows = [];
  let inPart = false;
  const RE = new RegExp(
    '^\\s*(\\d+)\\s+(\\S+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)' +
    '\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)' +
    '\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(\\d+)\\s*$');
  for (const ln of lines) {
    if (/PART 7/.test(ln)) { inPart = true; continue; }
    if (/PART [1-6]|PART 8/.test(ln)) inPart = false;
    if (!inPart) continue;
    const m = RE.exec(ln);
    if (!m) continue;
    rows.push({
      seq: +m[1], id: m[2], first: +m[3], last: +m[4], nYears: +m[5],
      nSegments: +m[6], nFlags: +m[7], corr: num(m[8]),
      meanMsmt: num(m[9]), maxMsmt: num(m[10]), sdMsmt: num(m[11]),
      acMsmt: num(m[12]), meanSens: num(m[13]),
      maxFilt: num(m[14]), sdFilt: num(m[15]), acFilt: num(m[16]), ar: +m[17],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Part 5 — the segment correlation matrix. Each page carries its own header of
// column years; cells are four characters wide, the fourth holding any flag.
// A series spans several pages, so cells accumulate per series across them.
// ---------------------------------------------------------------------------
function parsePart5() {
  const out = {};
  let cols = null, inPart = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/PART 5/.test(ln)) { inPart = true; cols = null; continue; }
    if (/PART [1-46-8]/.test(ln)) { inPart = false; cols = null; }
    if (!inPart) continue;
    if (/^\s*Seq Series/.test(ln) && /Time_span/.test(ln)) {
      const rule = lines[i + 2] || '';
      const groups = [];
      const re = /-{3,}/g; let g;
      while ((g = re.exec(rule)) !== null) groups.push([g.index, g.index + g[0].length]);
      cols = groups.slice(3).map(([a, b]) => {
        const y = ln.slice(Math.max(0, a - 1), b + 1).trim();
        return { a, b, year: /^-?\d+$/.test(y) ? +y : null };
      });
      i += 2; continue;
    }
    if (!cols || /Av segment/.test(ln)) continue;
    const m = /^\s*(\d+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)/.exec(ln);
    if (!m) continue;
    const key = m[2] + '|' + m[3] + '|' + m[4];
    const rec = out[key] || (out[key] = []);
    for (const c of cols) {
      const cell = ln.slice(Math.max(0, c.a - 1), c.b + 1).trim();
      if (!cell) continue;
      const cm = /^(-?\.\d+|-?\d+\.\d+)([AB])?$/.exec(cell);
      if (!cm) continue;
      rec.push({ year: c.year, r: num(cm[1]), flag: cm[2] || null });
    }
  }
  for (const k of Object.keys(out)) out[k].sort((p, q) => p.year - q.year);
  return out;
}

// ---------------------------------------------------------------------------
// Part 3 — the master dating series, printed in six side-by-side blocks.
// ---------------------------------------------------------------------------
function parsePart3() {
  const master = {};
  const hdr = lines.find(l => l.trim().startsWith('Year  Value  No Ab'));
  if (!hdr) return master;
  const offs = [];
  const re = /Year/g; let m;
  while ((m = re.exec(hdr)) !== null) offs.push(m.index);
  const width = offs.length > 1 ? offs[1] - offs[0] : 22;
  let inPart = false;
  for (const ln of lines) {
    if (/PART 3/.test(ln)) { inPart = true; continue; }
    if (/PART [1245678]/.test(ln)) inPart = false;
    if (!inPart || /Year/.test(ln) || !ln.trim() || /^[-\s]+$/.test(ln)) continue;
    for (const o of offs) {
      const cell = ln.slice(o - 2, o - 2 + width);
      if (!cell.trim()) continue;
      const cm = /^\s*(-?\d+)\s+(-?\d+\.\d+)\s+(\d+)\s*(\d*)\s*$/.exec(cell);
      if (!cm) continue;
      master[+cm[1]] = { v: +cm[2], n: +cm[3], ab: cm[4] ? +cm[4] : 0 };
    }
  }
  return master;
}

const c7 = parsePart7();
const c5 = parsePart5();
const c3 = parsePart3();

if (!c7.length) {
  console.error('\nNo Part 7 table recognised in ' + outPath + ' — was it printed?');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Ours, on the same file, with COFECHA's own defaults.
// ---------------------------------------------------------------------------
const frame = RD.readRWL(fs.readFileSync(rwlPath, 'utf8'), { fileName: path.basename(rwlPath) });
const mine = RD.cofecha(frame, {});
// An id can appear twice (two stop-marked records), so key on id + interval.
const byKey = {};
for (const s of mine.series) byKey[s.id + '|' + s.first + '|' + s.last] = s;

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
function agree(label, pairs, tol, dec) {
  dec = dec == null ? 3 : dec;
  let n = 0, ok = 0, worst = null;
  for (const [id, a, b] of pairs) {
    if (!isNum(a) || !isNum(b)) continue;
    n++;
    const d = Math.abs(a - b);
    if (d <= tol) ok++;
    if (!worst || d > worst.d) worst = { id, a, b, d };
  }
  console.log('  ' + label.padEnd(24) + String(ok).padStart(5) + '/' + String(n).padEnd(6) +
    pct(ok, n).padStart(7) +
    (worst && worst.d > tol ? '    worst ' + worst.id + '  ' + worst.a.toFixed(dec) + ' vs ' + worst.b.toFixed(dec) : ''));
}

console.log('\nCOFECHA : ' + outPath);
console.log('data    : ' + rwlPath);
console.log('series  : COFECHA ' + c7.length + '   ours ' + mine.series.length +
  (c7.length === mine.series.length ? '   (match)' : '   *** DIFFERENT ***'));

const matched = c7.filter(c => byKey[c.id + '|' + c.first + '|' + c.last]);
const unmatched = c7.filter(c => !byKey[c.id + '|' + c.first + '|' + c.last]);
console.log('matched on id + interval: ' + matched.length + '/' + c7.length +
  (unmatched.length ? '   missing: ' + unmatched.map(c => c.id + ' ' + c.first + '-' + c.last).join(', ') : ''));

const pair = (f, g) => matched.map(c => [c.id, f(c), g(byKey[c.id + '|' + c.first + '|' + c.last])]);

console.log('\n== Part 7: series identification and unfiltered statistics ==');
agree('years', pair(c => c.nYears, m => m.nYears), 0, 0);
agree('segments tested', pair(c => c.nSegments, m => m.nSegments), 0, 0);
agree('mean measurement', pair(c => c.meanMsmt, m => m.stats.meanMsmt), 0.005, 2);
agree('max measurement', pair(c => c.maxMsmt, m => m.stats.maxMsmt), 0.005, 2);
agree('std dev', pair(c => c.sdMsmt, m => m.stats.sdMsmt), 0.0005);
agree('autocorrelation', pair(c => c.acMsmt, m => m.stats.ac1Msmt), 0.0005);
agree('mean sensitivity', pair(c => c.meanSens, m => m.stats.meanSens), 0.0005);

console.log('\n== Part 7: derived from the transform chain ==');
agree('corr with master', pair(c => c.corr, m => m.corrWithMaster), 0.05);
agree('AR order', pair(c => c.ar, m => m.arOrder), 0, 0);
agree('flags per series', pair(c => c.nFlags, m => m.nFlags), 0, 0);

if (Object.keys(c3).length) {
  console.log('\n== Part 3: master dating series ==');
  const A = [], B = [], dep = [];
  for (let i = 0; i < mine.years.length; i++) {
    const c = c3[mine.years[i]];
    if (!c) continue;
    dep.push([String(mine.years[i]), c.n, mine.master.sampleDepth[i]]);
    if (isNum(mine.master.z[i])) { A.push(c.v); B.push(mine.master.z[i]); }
  }
  agree('sample depth', dep, 0, 0);
  agree('absent-ring count',
    mine.years.map((y, i) => [String(y), c3[y] ? c3[y].ab : NaN, mine.master.absent[i]]), 0, 0);
  let ma = 0, mb = 0;
  for (let i = 0; i < A.length; i++) { ma += A[i]; mb += B[i]; }
  ma /= A.length; mb /= A.length;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < A.length; i++) { const x = A[i] - ma, y = B[i] - mb; s += x * y; sa += x * x; sb += y * y; }
  console.log('  ' + 'master correlation'.padEnd(24) + (s / Math.sqrt(sa * sb)).toFixed(4).padStart(12) +
    '     over ' + A.length + ' years');
}

if (Object.keys(c5).length) {
  console.log('\n== Part 5: segment correlations and flags ==');
  let n = 0, ok05 = 0, ok10 = 0, worst = null;
  let both = 0, same = 0, cofOnly = [], ourOnly = [], neither = 0;
  for (const k of Object.keys(c5)) {
    const m = byKey[k];
    if (!m) continue;
    const cells = c5[k];
    for (let i = 0; i < Math.min(cells.length, m.segments.length); i++) {
      const c = cells[i], g = m.segments[i];
      if (!isNum(c.r) || !isNum(g.r)) continue;
      n++;
      const d = Math.abs(c.r - g.r);
      if (d <= 0.05) ok05++;
      if (d <= 0.10) ok10++;
      if (!worst || d > worst.d) worst = { id: m.id, seg: g.start + '-' + g.end, a: c.r, b: g.r, d };
      if (c.flag && g.flag) { both++; if (c.flag === g.flag) same++; }
      else if (c.flag) cofOnly.push(m.id + ' ' + g.start + '-' + g.end + '  COFECHA ' + c.flag + ' r=' + c.r.toFixed(2) + ', ours r=' + g.r.toFixed(2));
      else if (g.flag) ourOnly.push(m.id + ' ' + g.start + '-' + g.end + '  ours ' + g.flag + ' r=' + g.r.toFixed(2) + ', COFECHA r=' + c.r.toFixed(2));
      else neither++;
    }
  }
  console.log('  ' + 'correlation within 0.05'.padEnd(24) + String(ok05).padStart(5) + '/' + String(n).padEnd(6) + pct(ok05, n).padStart(7));
  console.log('  ' + 'correlation within 0.10'.padEnd(24) + String(ok10).padStart(5) + '/' + String(n).padEnd(6) + pct(ok10, n).padStart(7) +
    (worst ? '    worst ' + worst.id + ' ' + worst.seg + '  ' + worst.a.toFixed(2) + ' vs ' + worst.b.toFixed(2) : ''));
  console.log('  ' + 'SAME VERDICT'.padEnd(24) + String(neither + both).padStart(5) + '/' + String(n).padEnd(6) + pct(neither + both, n).padStart(7) +
    '    (' + neither + ' agreed clean, ' + both + ' agreed flagged, ' + same + ' same letter)');
  console.log('  ' + 'flagged by COFECHA only'.padEnd(24) + String(cofOnly.length).padStart(5));
  console.log('  ' + 'flagged by us only'.padEnd(24) + String(ourOnly.length).padStart(5));
  if (VERBOSE) {
    cofOnly.forEach(x => console.log('      COFECHA only: ' + x));
    ourOnly.forEach(x => console.log('      ours only   : ' + x));
  } else if (cofOnly.length || ourOnly.length) {
    console.log('      (--verbose lists them; they are borderline segments whose');
    console.log('       correlations straddle the critical value)');
  }
}

console.log('\nrun summary        COFECHA        ours');
const cofFlags = c7.reduce((a, b) => a + b.nFlags, 0);
const cofSeg = c7.reduce((a, b) => a + b.nSegments, 0);
const cofCorr = c7.reduce((a, b) => a + b.corr, 0) / c7.length;
const cofSens = c7.reduce((a, b) => a + b.meanSens, 0) / c7.length;
const row = (l, a, b) => console.log('  ' + l.padEnd(18) + String(a).padStart(8) + String(b).padStart(12));
row('series', c7.length, mine.summary.nSeries);
row('segments', cofSeg, mine.summary.nSegments);
row('flagged', cofFlags, mine.summary.nFlags);
row('mean corr', cofCorr.toFixed(4), mine.summary.meanCorr.toFixed(4));
row('mean sensitivity', cofSens.toFixed(4), mine.summary.meanSens.toFixed(4));
console.log('');
