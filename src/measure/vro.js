'use strict';
// ============================================================================
// vro.js — wire protocol for a Velmex VRO measuring stage on a serial port.
//
// PURE protocol layer: framing, parsing and mode detection only. It never
// touches navigator.serial or the DOM, so it runs and is tested under node
// (test/measure_test.js). The browser transport lives in web/measure.js.
//
// The port settings and the frame format below were read out of Tellervo's own
// driver (org.tellervo.desktop.hardware.device.VRODevice in tellervo-1.5.3.jar),
// so a VRO already measuring in Tellervo needs no reconfiguration here:
//
//   9600 baud, 8 data bits, 1 stop bit, no parity, no flow control
//   frames terminated by CR (0x0D) — NOT CRLF
//   payload is an ASCII decimal in millimetres; Tellervo scales by 1000 and
//   keeps integer microns, which we do too so repeated edits never drift
//
// The VRO appends a unit suffix whenever it is NOT in millimetre mode:
//   "...in"  -> readout is configured for inches
//   "...ct"  -> readout is emitting raw encoder counts (never configured)
// Both are reported as errors rather than being silently mis-scaled, matching
// Tellervo's behaviour — a core measured in inches and read as mm is exactly
// the kind of error that survives to publication.
//
// One deliberate divergence: Tellervo matches values with [\d\.]+, which drops
// a leading minus sign and turns backwards stage travel into a positive width.
// We keep the sign so the operator sees the mistake.
// ============================================================================

// Passed straight to SerialPort.open() — the Web Serial option names are used
// verbatim so the transport layer needs no translation table.
const PORT_OPTIONS = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  bufferSize: 4096,
};

const MICRONS_PER_MM = 1000;

// ---------------------------------------------------------------------------
// outbound commands
// ---------------------------------------------------------------------------
// The VRO accepts single-character commands terminated by the same CR it sends.
// Both were recovered from the bytecode of Tellervo's VRODevice: zeroMeasurement()
// loads the literal "C" and requestMeasurement() loads "S", each handed to
// sendRequest(), which appends the line terminator before writing.
//
//   ZERO    "C\r"  clear — zeroes the readout where it stands
//   REQUEST "S\r"  send  — transmit the current position without a pedal press
//
// Zeroing after every recorded ring is what Tellervo does, and it turns an
// absolute-position readout into a direct ring-width reader: the number on the
// VRO is then the ring currently being measured rather than distance from the
// pith, and nothing accumulates.
const ZERO = 'C';
const REQUEST = 'S';
const COMMAND_TERMINATOR = '\r';

// commandBytes(cmd) -> Uint8Array ready for a serial writer.
function commandBytes(cmd) {
  const text = String(cmd) + COMMAND_TERMINATOR;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

// A frame is a run of bytes ending in CR or LF. LF is accepted as well as CR so
// a readout configured for CRLF still frames one value per line instead of
// gluing the whole session into a single token.
const TERMINATOR = /\r\n|\r|\n/;

// Anything longer than this without a terminator means the readout is not
// speaking the protocol we think it is; drop it rather than grow forever.
const MAX_PENDING = 512;

const VALUE_RE = /[-+]?(?:\d+\.?\d*|\.\d+)/;

// Parse outcomes. `value` is the only one that carries a measurement.
const VALUE = 'value';
const UNITS = 'units';
const NOISE = 'noise';

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

// createFramer() -> push(chunk) -> string[]
//
// Serial data arrives in arbitrary chunks that split mid-number, so the framer
// holds a remainder between calls. `chunk` may be a string, a Uint8Array or an
// ArrayBuffer (what a Web Serial reader yields); bytes are decoded as ASCII,
// which is all the VRO emits.
function createFramer() {
  let pending = '';

  function decode(chunk) {
    if (chunk == null) return '';
    if (typeof chunk === 'string') return chunk;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  return {
    push(chunk) {
      pending += decode(chunk);
      const parts = pending.split(TERMINATOR);
      pending = parts.pop();               // trailing fragment, awaiting its CR
      if (pending.length > MAX_PENDING) pending = '';
      return parts.map(s => s.trim()).filter(s => s.length > 0);
    },
    // Flush whatever is buffered; used on disconnect so a final unterminated
    // frame is not lost.
    flush() {
      const rest = pending.trim();
      pending = '';
      return rest ? [rest] : [];
    },
    reset() { pending = ''; },
  };
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// parseLine(line) -> { status, microns?, mm?, raw, message? }
//
// status is 'value' (usable measurement), 'units' (readout in the wrong mode)
// or 'noise' (no number present — banner text, line noise, a bare prompt).
function parseLine(line) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw) return { status: NOISE, raw, message: 'empty frame' };

  const lower = raw.toLowerCase();
  if (/in$/.test(lower)) {
    return {
      status: UNITS,
      raw,
      message: 'The VRO is transmitting inches. Switch the readout to ' +
               'millimetres (see the VRO Quick Start Guide) and reconnect.',
    };
  }
  if (/ct$/.test(lower)) {
    return {
      status: UNITS,
      raw,
      message: 'The VRO is transmitting raw encoder counts, so it has not been ' +
               'configured yet. Set it to millimetres per the VRO Quick Start Guide.',
    };
  }

  const match = VALUE_RE.exec(raw);
  if (!match) return { status: NOISE, raw, message: 'no numeric value in frame' };

  const mm = Number(match[0]);
  if (!Number.isFinite(mm)) return { status: NOISE, raw, message: 'unparseable number' };

  return { status: VALUE, raw, mm, microns: Math.round(mm * MICRONS_PER_MM) };
}

// ---------------------------------------------------------------------------
// mode detection
// ---------------------------------------------------------------------------
//
// Labs run VROs in one of two configurations and the readout does not announce
// which. Rather than make the operator know, we infer it from the first few
// presses of the foot switch:
//
//   cumulative  — the readout reports absolute distance from the last zero, so
//                 a ring width is the difference between consecutive presses.
//                 Values climb monotonically. This is Tellervo's assumption and
//                 the usual VRO setup.
//   incremental — the readout zeroes itself after each press, so every value IS
//                 a ring width. Values wander up and down.
//
// Ring widths almost never increase monotonically for many rings running (that
// is one ordering out of n!), so a strictly rising run is strong evidence of
// cumulative travel. Below 4 readings we report low confidence and let the
// operator confirm.
const CUMULATIVE = 'cumulative';
const INCREMENTAL = 'incremental';

function detectMode(microns) {
  const xs = (microns || []).filter(x => Number.isFinite(x));
  if (xs.length < 2) {
    return {
      mode: null, confidence: 'none', samples: xs.length,
      reason: 'Press the foot switch a few times to identify the readout mode.',
    };
  }

  let rising = true;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[i - 1]) { rising = false; break; }

  if (rising) {
    return {
      mode: CUMULATIVE,
      confidence: xs.length >= 4 ? 'high' : 'low',
      samples: xs.length,
      reason: xs.length + ' readings rose monotonically, so the readout is ' +
              'reporting absolute stage position.',
    };
  }

  return {
    mode: INCREMENTAL,
    confidence: xs.length >= 4 ? 'high' : 'low',
    samples: xs.length,
    reason: 'Readings went both up and down, so each frame is already a ring ' +
            'width rather than an absolute position.',
  };
}

module.exports = {
  PORT_OPTIONS, MICRONS_PER_MM, MAX_PENDING,
  VALUE, UNITS, NOISE, CUMULATIVE, INCREMENTAL,
  ZERO, REQUEST, COMMAND_TERMINATOR,
  createFramer, parseLine, detectMode, commandBytes,
};
