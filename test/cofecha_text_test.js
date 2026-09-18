'use strict';
// ============================================================================
// The fixed-width .OUT emitter.
//
// The point of writing COFECHA's layout is that a user leaving COFECHA can diff
// our output against a real run of it. That only works if the columns land where
// COFECHA puts them — so the test is a round trip through tools/cofecha_compare,
// the parser that was written to read REAL COFECHA listings, with no knowledge
// of this emitter. If that parser reads our file and recovers the same numbers,
// the layout is right.
//
// Where UT550COF.OUT is present the column positions are also compared against
// it directly.
// ============================================================================
const fs = require('fs');
const path = require('path');
const RD = require('../src/index.js');
const { parse } = require('../tools/cofecha_compare.js');

let allPass = true;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (!ok) { allPass = false; log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else log('  ok    ' + name);
}

const RWL = path.join(__dirname, '..', 'chronologies', 'ut550.rwl');
if (!fs.existsSync(RWL)) {
  log('# .OUT emitter — skipped (chronologies/ut550.rwl not present)');
  process.exit(0);
}

const frame = RD.readRWL(fs.readFileSync(RWL, 'utf8'), { fileName: 'ut550.rwl' });
const res = RD.cofecha(frame);
const out = path.join(require('os').tmpdir(), 'ringdater_cofecha_roundtrip.OUT');
fs.writeFileSync(out, RD.renderCofechaText(res, { title: 'UT550', file: 'ut550.rwl' }));

log('# round trip through the COFECHA parser');
const back = parse(out);
const key = x => x.id + '|' + x.first + '|' + x.last;
const mine = {};
res.series.forEach(s => { mine[key(s)] = s; });

check('every series is recovered from Part 7',
  back.part7.length === res.series.length, back.part7.length + '/' + res.series.length);
check('every series is recovered from Part 5',
  Object.keys(back.part5).length === res.series.length,
  Object.keys(back.part5).length + '/' + res.series.length);
check('every master year is recovered from Part 3',
  Object.keys(back.part3).length === res.years.length,
  Object.keys(back.part3).length + '/' + res.years.length);

{
  let n = 0, ok = 0, bad = [];
  for (const r of back.part7) {
    const m = mine[key(r)];
    if (!m) continue;
    n++;
    const same = r.nYears === m.nYears && r.nSegments === m.nSegments && r.nFlags === m.nFlags &&
      r.ar === m.arOrder &&
      Math.abs(r.corr - m.corrWithMaster) < 5e-4 &&
      Math.abs(r.meanSens - m.stats.meanSens) < 5e-4 &&
      Math.abs(r.meanMsmt - m.stats.meanMsmt) < 5e-3;
    if (same) ok++; else bad.push(r.id);
  }
  check('Part 7 values survive the round trip', ok === n && n > 0,
    ok + '/' + n + (bad.length ? '  differing: ' + bad.slice(0, 5).join(', ') : ''));
}

{
  let n = 0, okR = 0, okF = 0;
  for (const k of Object.keys(back.part5)) {
    const m = mine[k];
    if (!m) continue;
    const cells = back.part5[k];
    for (let i = 0; i < Math.min(cells.length, m.segments.length); i++) {
      n++;
      if (Math.abs(cells[i].r - m.segments[i].r) < 5e-3) okR++;
      if ((cells[i].flag || null) === (m.segments[i].flag || null)) okF++;
    }
  }
  check('Part 5 correlations survive', okR === n && n > 3000, okR + '/' + n);
  check('Part 5 A/B flags survive', okF === n, okF + '/' + n);
}

{
  let n = 0, ok = 0;
  for (let i = 0; i < res.years.length; i++) {
    const e = back.part3[res.years[i]];
    if (!e) continue;
    n++;
    if (e.n === res.master.sampleDepth[i] && e.ab === res.master.absent[i] &&
        Math.abs(e.v - res.master.z[i]) < 5e-4) ok++;
  }
  check('Part 3 master, sample depth and absent counts survive', ok === n && n > 2000, ok + '/' + n);
}

log('\n# layout matches the real listing');
{
  const REAL = path.join(__dirname, '..', 'UT550COF.OUT');
  const ours = fs.readFileSync(out, 'utf8').split('\n');
  const headerOurs = ours.find(l => /^PART 5:/.test(l));
  check('the Part 5 page header uses COFECHA\'s form', !!headerOurs, String(headerOurs));

  if (fs.existsSync(REAL)) {
    const real = fs.readFileSync(REAL, 'latin1').replace(/\r/g, '').split('\n');
    const colLine = a => a.find(l => /^ Seq Series {2}Time_span/.test(l));
    const ruleLine = a => a.find(l => /^ --- -------- --------- {2}----/.test(l));
    check('the Part 5 column header is byte-identical up to the year list',
      colLine(ours).slice(0, 24) === colLine(real).slice(0, 24),
      JSON.stringify(colLine(ours).slice(0, 24)) + ' vs ' + JSON.stringify(colLine(real).slice(0, 24)));
    check('the Part 5 rule line matches',
      ruleLine(ours).slice(0, 30) === ruleLine(real).slice(0, 30));
    // a data row: seq, id and the two span years must occupy the same columns
    const dataOurs = ours.find(l => /^ {2}21 RCB059A/.test(l));
    const dataReal = real.find(l => /^ {2}21 RCB059A/.test(l));
    check('a Part 5 data row puts seq, id and span in COFECHA\'s columns',
      dataOurs && dataReal && dataOurs.slice(0, 24) === dataReal.slice(0, 24),
      JSON.stringify(dataOurs && dataOurs.slice(0, 24)) + ' vs ' +
      JSON.stringify(dataReal && dataReal.slice(0, 24)));
    const p7Ours = ours.find(l => /^ Seq Series {3}Interval/.test(l));
    const p7Real = real.find(l => /^ Seq Series {3}Interval/.test(l));
    check('the Part 7 column header matches', p7Ours === p7Real,
      JSON.stringify(p7Ours) + ' vs ' + JSON.stringify(p7Real));
  } else {
    log('        (UT550COF.OUT not present — column comparison skipped)');
  }
}

log('\n# it does not pretend to be COFECHA');
{
  const txt = fs.readFileSync(out, 'utf8');
  check('the page header identifies RingdateR', /RingdateR/.test(txt));
  const withV = RD.renderCofechaText(res, {
    title: 'UT550', verdict: RD.crossdateVerdict(res),
  });
  check('a verdict section, when included, is marked as not part of COFECHA',
    !/\[V\] VERDICT/.test(withV) || /not part of COFECHA output/.test(withV));
}

log('\n# options');
{
  const only7 = RD.renderCofechaText(res, { title: 'X', parts: [7] });
  check('parts can be selected', /^PART 7:/m.test(only7) && !/^PART 5:/m.test(only7));
  check('pages are numbered sequentially',
    (fs.readFileSync(out, 'utf8').match(/Page\s+(\d+)/g) || [])
      .map(s => +s.replace(/\D/g, '')).every((v, i, a) => i === 0 || v === a[i - 1] + 1));
}

try { fs.unlinkSync(out); } catch (e) { /* leave it */ }
log(allPass ? '\nAll .OUT emitter checks passed.' : '\nFAILURES above.');
process.exit(allPass ? 0 : 1);
