'use strict';
// ============================================================================
// Validates the measuring layer (src/measure/vro.js + src/measure/series.js).
// No hardware and no R ground truth are needed: correctness is pinned to
//   (a) the port settings and frame grammar of Tellervo's VRODevice, which is
//       the reference implementation this protocol was read from;
//   (b) invariants of the acquisition modes (cumulative differencing is the
//       exact inverse of a running sum; incremental is the identity);
//   (c) a full synthetic session — chunked bytes -> framer -> parser -> series
//       -> Frame -> writeRwl -> readRWL — round-tripping back to the widths
//       that were pressed in, which ties the new code to the already
//       R-validated Tucson writer.
// Exits nonzero on any failure.
// ============================================================================
const V = require('../src/measure/vro.js');
const { createMeasureSeries, restoreMeasureSeries, BARK_TO_PITH } = require('../src/measure/series.js');
const { writeRwl, readRWL } = require('../src/io/load.js');

let allPass = true;
function check(name, cond, detail) {
  if (!cond) allPass = false;
  console.log(name.padEnd(52), cond ? 'PASS' : 'FAIL', cond ? '' : (detail || ''));
}
function eqArr(a, b, tol) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > (tol || 0)) return false;
  return true;
}

// ---- port settings, straight from VRODevice.setDefaultPortParams() ---------
const P = V.PORT_OPTIONS;
check('port params match Tellervo VRODevice',
  P.baudRate === 9600 && P.dataBits === 8 && P.stopBits === 1 &&
  P.parity === 'none' && P.flowControl === 'none',
  JSON.stringify(P));

// ---- outbound commands -----------------------------------------------------
// Recovered from VRODevice bytecode: zeroMeasurement() loads "C",
// requestMeasurement() loads "S", and sendRequest() appends the CR terminator.
check('zero command is C', V.ZERO === 'C');
check('request command is S', V.REQUEST === 'S');
(function () {
  const z = V.commandBytes(V.ZERO);
  check('zero command is sent as "C" + CR',
    z instanceof Uint8Array && z.length === 2 && z[0] === 0x43 && z[1] === 0x0d,
    Array.from(z).join(','));
  const s = V.commandBytes(V.REQUEST);
  check('request command is sent as "S" + CR',
    s.length === 2 && s[0] === 0x53 && s[1] === 0x0d, Array.from(s).join(','));
})();

// With auto-zero on, the readout clears after every ring, so the frames ARE
// widths — the incremental path — and no differencing must be applied.
(function () {
  const widths = [1200, 800, 1500, 300];
  const s = createMeasureSeries({ id: 'AZ1', mode: V.INCREMENTAL });
  widths.forEach(w => s.addReading(w));
  check('auto-zeroed frames are taken as widths verbatim',
    eqArr(s.state().rings.map(r => r.width), widths));
})();

// ---- framing ---------------------------------------------------------------
// The VRO terminates on CR, and chunk boundaries fall anywhere — including
// mid-number, which is the case that corrupts a naive reader.
(function () {
  const f = V.createFramer();
  const a = f.push('1.2');
  const b = f.push('34\r5.678\r9.0');
  check('framer holds a partial frame', a.length === 0 && b.length === 2 && b[0] === '1.234', JSON.stringify([a, b]));
  check('framer flushes the tail', eqArrStr(f.flush(), ['9.0']));

  const g = V.createFramer();
  check('framer accepts CRLF', eqArrStr(g.push('1.0\r\n2.0\r\n'), ['1.0', '2.0']));
  check('framer accepts bare LF', eqArrStr(g.push('3.0\n'), ['3.0']));

  // Bytes, as a Web Serial reader actually yields them.
  const h = V.createFramer();
  const bytes = new Uint8Array([0x31, 0x2e, 0x35, 0x0d]);   // "1.5\r"
  check('framer decodes Uint8Array chunks', eqArrStr(h.push(bytes), ['1.5']));

  // A readout that never sends a terminator must not grow the buffer forever.
  const i = V.createFramer();
  i.push('x'.repeat(V.MAX_PENDING + 10));
  check('framer discards a runaway frame', i.flush().length === 0);
})();

function eqArrStr(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---- parsing ---------------------------------------------------------------
check('parses plain millimetres', V.parseLine('12.345').microns === 12345);
check('parses with whitespace and unit text', V.parseLine('  12.345 mm ').microns === 12345);
check('parses a zero reading', V.parseLine('0.000').microns === 0);
// Tellervo's [\d\.]+ would return +1250 here; keeping the sign is deliberate.
check('keeps the sign on backwards travel', V.parseLine('-1.250').microns === -1250);
check('flags inch mode', V.parseLine('0.5in').status === V.UNITS);
check('flags raw-count mode', V.parseLine('1234ct').status === V.UNITS);
check('reports noise as noise', V.parseLine('VRO ready').status === V.NOISE);
check('reports an empty frame as noise', V.parseLine('   ').status === V.NOISE);

// ---- mode detection --------------------------------------------------------
check('detects cumulative from a rising run',
  V.detectMode([1000, 2400, 3100, 4900]).mode === V.CUMULATIVE);
check('cumulative detection is confident at 4 samples',
  V.detectMode([1000, 2400, 3100, 4900]).confidence === 'high');
check('detects incremental from wandering values',
  V.detectMode([1400, 800, 2100, 900]).mode === V.INCREMENTAL);
check('declines to guess from one reading',
  V.detectMode([1000]).mode === null);

// ---- cumulative acquisition ------------------------------------------------
// Differencing consecutive positions must invert a running sum exactly.
(function () {
  const widths = [1200, 800, 1500, 300, 2200];
  let pos = 0;
  const positions = widths.map(w => (pos += w));
  const s = createMeasureSeries({ id: 'CUM1' });
  positions.forEach(p => s.addReading(p));
  check('cumulative differencing recovers widths',
    eqArr(s.state().rings.map(r => r.width), widths),
    JSON.stringify(s.state().rings.map(r => r.width)));
  check('cumulative tracks the last boundary', s.state().reference === positions[4]);
})();

// A reading behind the previous boundary is kept and flagged, not dropped.
(function () {
  const s = createMeasureSeries({ id: 'NEG1' });
  s.addReading(1000);
  const back = s.addReading(600);
  check('backwards travel yields a flagged negative', back.width === -400 && /negative/.test(back.note));
})();

// zeroAt sets the inner edge without recording a ring.
(function () {
  const s = createMeasureSeries({ id: 'ZER1' });
  s.addReading(5000);            // drive to the pith, press once
  s.zeroAt();                    // ...and call that the origin
  check('zeroAt does not add a ring', s.length === 1);
  const first = s.addReading(6200);
  check('zeroAt rebases the next width', first.width === 1200, String(first.width));
})();

// ---- incremental acquisition ----------------------------------------------
(function () {
  const widths = [1200, 800, 1500];
  const s = createMeasureSeries({ id: 'INC1', mode: V.INCREMENTAL });
  widths.forEach(w => s.addReading(w));
  check('incremental takes frames as widths',
    eqArr(s.state().rings.map(r => r.width), widths));
})();

// ---- absent rings, editing, undo ------------------------------------------
(function () {
  const s = createMeasureSeries({ id: 'EDT1' });
  s.addReading(1000); s.addReading(2000);
  const absent = s.addAbsent();
  check('absent ring is zero width', absent.width === 0);
  check('absent ring does not advance the stage reference', s.state().reference === 2000);

  s.setWidth(0, 1111);
  check('setWidth edits in place', s.state().rings[0].width === 1111);
  s.undo();
  check('undo restores the edited width', s.state().rings[0].width === 1000);

  s.insert(1, 555);
  check('insert places a ring', s.state().rings[1].width === 555 && s.length === 4);
  s.remove(1);
  check('remove drops it again', s.length === 3 && s.state().rings[1].width === 1000);

  const before = s.length;
  s.addReading(9999);
  s.undo();
  check('undo reverses a stray press', s.length === before);
})();

// ---- Frame contract --------------------------------------------------------
(function () {
  const s = createMeasureSeries({ id: 'FRM1' });
  [1000, 2000, 3500].forEach(p => s.addReading(p));
  const f = s.toFrame();
  check('frame is indexed by ring, not year', f.names[0] === 'ring' && f.names[1] === 'FRM1');
  check('ring index counts from 1', eqArr(f.cols[0], [1, 2, 3]));
  check('frame carries millimetres', eqArr(f.cols[1], [1.0, 1.0, 1.5], 1e-12), JSON.stringify(f.cols[1]));
})();

// A core measured bark-to-pith comes off the stage youngest-first; every
// downstream routine assumes oldest-first, so the frame must be reversed.
(function () {
  const s = createMeasureSeries({ id: 'REV1', mode: V.INCREMENTAL, direction: BARK_TO_PITH });
  [500, 1500, 2500].forEach(w => s.addReading(w));
  check('bark-to-pith frame is reversed to oldest-first',
    eqArr(s.toFrame().cols[1], [2.5, 1.5, 0.5], 1e-12));
  check('...while the measured order is untouched',
    eqArr(s.widthsMm(), [0.5, 1.5, 2.5], 1e-12));
})();

// ---- full synthetic session, ending in the R-validated RWL writer ----------
(function () {
  const widths = [1240, 880, 2010, 0, 1550, 990, 3120, 460, 1780, 2240, 1130];
  let pos = 0;
  // Serialise as the VRO would, then re-chunk at awkward boundaries.
  const wire = widths.map(w => (pos += w)).map(p => (p / 1000).toFixed(3) + '\r').join('');
  const chunks = [];
  for (let i = 0; i < wire.length; i += 7) chunks.push(wire.slice(i, i + 7));

  const framer = V.createFramer();
  const s = createMeasureSeries({ id: 'SESS1' });
  chunks.forEach(c => framer.push(c).forEach(line => {
    const r = V.parseLine(line);
    if (r.status === V.VALUE) s.addReading(r.microns);
  }));

  check('session recovers every ring', s.length === widths.length, s.length + ' of ' + widths.length);
  check('session recovers every width',
    eqArr(s.state().rings.map(r => r.width), widths),
    JSON.stringify(s.state().rings.map(r => r.width)));

  const frame = s.toFrame();
  const text = writeRwl(frame, { precision: 0.001 });
  const back = readRWL(text, { fileName: 'SESS1.rwl' });
  check('measured series round-trips through writeRwl/readRWL',
    eqArr(back.cols[1], frame.cols[1], 1e-9),
    JSON.stringify(back.cols[1]));
  check('round-trip preserves the absent ring as zero', back.cols[1][3] === 0);
})();

// ---- loading an existing series to amend -----------------------------------
// The Measure view can put a series that already exists back on the table. The
// contract is that loadWidthsMm is the exact inverse of toFrame: what the app
// holds goes in, and what comes back out is the same series until it is edited.
(function () {
  const s = createMeasureSeries({ id: 'AMEND1', mode: V.INCREMENTAL });
  const widths = [1.2, 0.88, 2.01, 0, 1.55];
  s.loadWidthsMm(widths);
  check('load takes every ring', s.length === widths.length, String(s.length));
  check('load round-trips through toFrame',
    eqArr(s.toFrame().cols[1], widths, 1e-9), JSON.stringify(s.toFrame().cols[1]));
  check('a zero ring loads as locally absent',
    s.state().rings[3].note === 'locally absent', s.state().rings[3].note);
  check('loaded rings carry no stage position',
    s.state().rings.every(r => r.position === null));

  // Measuring carries on from the last loaded ring rather than starting over.
  s.addReading(940);
  check('a press appends to the loaded series', s.length === 6 && s.state().rings[5].width === 940,
    JSON.stringify(s.state().rings[5]));
  check('amended series exports loaded + new rings',
    eqArr(s.toFrame().cols[1], widths.concat([0.94]), 1e-9),
    JSON.stringify(s.toFrame().cols[1]));

  // Undo returns to whatever was on the table before the load, so a load into
  // the wrong series is recoverable rather than destructive.
  s.undo(); s.undo();
  check('undo unwinds the load itself', s.length === 0, String(s.length));
})();

// A bark-to-pith core is stored oldest-first but measured backwards, so a load
// must flip it into measurement order — otherwise the next press would extend
// the wrong end of the core.
(function () {
  const s = createMeasureSeries({ id: 'BP1', mode: V.INCREMENTAL, direction: BARK_TO_PITH });
  const ordered = [0.5, 1.0, 1.5];         // oldest ring first, as the Frame holds it
  s.loadWidthsMm(ordered);
  check('bark-to-pith load is flipped into measurement order',
    eqArr(s.widthsMm(), [1.5, 1.0, 0.5], 1e-9), JSON.stringify(s.widthsMm()));
  check('bark-to-pith load still round-trips oldest-first',
    eqArr(s.toFrame().cols[1], ordered, 1e-9), JSON.stringify(s.toFrame().cols[1]));
  s.addReading(200);
  check('a press extends the bark end of a reversed core',
    eqArr(s.toFrame().cols[1], [0.2].concat(ordered), 1e-9),
    JSON.stringify(s.toFrame().cols[1]));
})();

// Widths held as integer microns end to end: reloading an exported series must
// not drift, however many times it goes round.
(function () {
  const widths = [1.234, 0.001, 3.999, 0.087];
  const s = createMeasureSeries({ id: 'RT1', mode: V.INCREMENTAL });
  s.loadWidthsMm(widths);
  for (let i = 0; i < 5; i++) s.loadWidthsMm(s.toFrame().cols[1]);
  check('repeated load/export cycles do not drift',
    eqArr(s.toFrame().cols[1], widths, 1e-12), JSON.stringify(s.toFrame().cols[1]));
})();

// A pool column is bottom-padded with nulls to the longest series; a padded
// value is not a ring, and the UI trims it, but a null that reaches here must
// still not become NaN and poison every downstream statistic.
(function () {
  const s = createMeasureSeries({ id: 'NA1', mode: V.INCREMENTAL });
  s.loadWidthsMm([1.1, null, 1.3]);
  check('a missing value loads as zero, flagged',
    s.state().rings[1].width === 0 && s.state().rings[1].note === 'missing in source',
    JSON.stringify(s.state().rings[1]));
  check('no NaN reaches the exported frame',
    s.toFrame().cols[1].every(v => typeof v === 'number' && !Number.isNaN(v)));
})();

// ---- series names through the Tucson id field ------------------------------
// A core named CMP519B was saved as .rwl and came back off disk as CMP519: the
// standard Tucson layout gives the id columns 1-6 and the decade columns 9-12
// (NOAA's treeinfo.txt), and write.tucson truncates to fit. That default is the
// only id width that is safe everywhere and stays the default; dplR's long.names
// layout spends the slack columns on the id instead, and is what the Measure
// view offers when the operator chooses to keep a longer name.
(function () {
  const { writeRwl, readRWL, fixNames } = require('../src/io/load.js');
  const dated = years => ({ names: ['years', 'CMP519B'], cols: [years, years.map(() => 1.2)] });
  const yrs = [1980, 1981, 1982];

  const short = readRWL(writeRwl(dated(yrs), { precision: 0.001 }), { fileName: 'x.rwl' });
  check('the default layout is unchanged dplR write.tucson (id cut to 6)',
    short.names[1] === 'CMP519', short.names[1]);

  const longText = writeRwl(dated(yrs), { precision: 0.001, longNames: true });
  check('long names keep a 7-character id',
    readRWL(longText, { fileName: 'x.rwl' }).names[1] === 'CMP519B',
    readRWL(longText, { fileName: 'x.rwl' }).names[1]);
  check('both layouts put the decade in columns 9-12',
    longText.substring(8, 12) === '1980' &&
    writeRwl(dated(yrs), { precision: 0.001 }).substring(8, 12) === '1980',
    JSON.stringify(longText.substring(0, 12)));
  check('both layouts start the data at column 13',
    longText.indexOf('  1200') === 12, JSON.stringify(longText.split('\r\n')[0]));

  const f8 = { names: ['years', 'CMP519BX'], cols: [yrs, [1.2, 1.2, 1.2]] };
  check('a full 8-character id survives long names',
    readRWL(writeRwl(f8, { precision: 0.001, longNames: true }), { fileName: 'x.rwl' })
      .names[1] === 'CMP519BX');

  // dplR: "Setting long.names = TRUE allows series IDs to be 8 characters long,
  // or 7 in case there are year numbers using 5 characters" — and the narrower
  // limit applies to every id in the file, not only the series with long years.
  const bc = { names: ['years', 'CMP519BX'], cols: [[-1002, -1001, -1000], [1.2, 1.2, 1.2]] };
  const bcText = writeRwl(bc, { precision: 0.001, longNames: true });
  check('a 5-column year narrows every id to 7',
    bcText.substring(0, 7) === 'CMP519B' && bcText.substring(7, 12) === '-1002',
    JSON.stringify(bcText.substring(0, 12)));
  check('...and the data still starts at column 13',
    bcText.indexOf('  1200') === 12, JSON.stringify(bcText.split('\r\n')[0]));
  check('a 5-column year round-trips under long names',
    readRWL(bcText, { fileName: 'x.rwl' }).cols[0][0] === -1002,
    JSON.stringify(readRWL(bcText, { fileName: 'x.rwl' }).cols[0]));

  // What the UI shows the operator before writing, so the two cannot disagree.
  check('fixNames reports the id the file will actually carry',
    fixNames(['sample_b', 'CMP-519B', 'waytoolongname'], 8).join(',') ===
    'sampleb,CMP519B,waytoolo',
    fixNames(['sample_b', 'CMP-519B', 'waytoolongname'], 8).join(','));
})();

// ---- autosave: state() -> JSON -> restoreMeasureSeries --------------------
// What the Measure view mirrors into localStorage after every press. The
// round trip has to be exact, because the copy in the browser IS the core
// until it is saved to a file.
(function () {
  const s = createMeasureSeries({ id: 'CMP519B', mode: V.CUMULATIVE, direction: BARK_TO_PITH });
  [1200, 2450, 3600, 4000].forEach(m => s.addReading(m));
  s.addAbsent();
  s.addReading(5100);
  s.setWidth(0, 1150);
  const before = s.state();
  const back = restoreMeasureSeries(JSON.parse(JSON.stringify(before)));
  const after = back.state();
  check('restore keeps id, mode and direction',
    after.id === before.id && after.mode === before.mode && after.direction === before.direction,
    JSON.stringify([after.id, after.mode, after.direction]));
  check('restore keeps every ring, in microns, with its note',
    JSON.stringify(after.rings) === JSON.stringify(before.rings),
    JSON.stringify(after.rings.slice(0, 2)));
  check('restore keeps the stage reference and last position',
    after.reference === before.reference && after.lastPosition === before.lastPosition,
    after.reference + ' / ' + after.lastPosition);
  check('a restored series writes the same Frame',
    JSON.stringify(back.toFrame()) === JSON.stringify(s.toFrame()),
    JSON.stringify(back.toFrame().cols[1]));
  check('measuring continues from where the restore left the stage',
    (back.addReading(5600).width) === 500, String(back.state().rings[6].width));
  // The history is a record of an editing sitting, not of the wood.
  check('a restored series has nothing to undo', back.state().canUndo === false ||
    restoreMeasureSeries(before).state().canUndo === false);
  // Rubbish in a snapshot must not become NaN mm downstream.
  const junk = restoreMeasureSeries({ id: 'X', rings: [{ width: 'abc' }, { width: 1200, position: 'x' }, null] });
  check('a corrupt ring lands as 0 mm, not NaN',
    junk.widthsMm().every(w => Number.isFinite(w)) && junk.widthsMm()[0] === 0,
    JSON.stringify(junk.widthsMm()));
  check('...and a bad position becomes null', junk.state().rings[1].position === null);
  check('an empty restore is an empty series', restoreMeasureSeries().length === 0 &&
    restoreMeasureSeries({}).id === 'NEW1');
})();

console.log(allPass ? '\nALL PASS' : '\nFAILURES');
process.exit(allPass ? 0 : 1);
