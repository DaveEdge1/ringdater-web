'use strict';
// ============================================================================
// loadPos: port of ringdater::load_pos (R/load_pos_function.R).
//
// Reads an Image-Pro ".pos" coordinate file (a stateful geometry walk along a
// measured transect) and returns ring widths as a Frame (see analysis/comb.js).
//
// .pos FORMAT (as consumed by R's load_pos):
//   * R does `read.table(sep = "/")`, and coordinate lines contain no "/", so
//     every physical line is ONE field == the whole line string.
//   * The loop runs `for i in 2:nrow`, i.e. LINE 1 IS A HEADER and is skipped.
//   * read.table drops blank lines, so we drop empty lines here too.
//   * A normal point line is "x,y".
//   * A GAP point line starts with 'D' (e.g. "D20,0"); the 'D' is stripped and
//     the point flagged as a gap marker.
//   * A LATERAL-JUMP line holds TWO coordinates separated by a DOUBLE space:
//     "xa,ya  xb,yb". The width is measured to the FIRST coord; the SECOND coord
//     becomes the anchor for the next width (the pen jumped sideways).
//
// PARSED ROW SHAPE (matches R's POSdata columns A,B,C,D):
//   normal   -> [NA, NA, x, y]        (naFill = c(NA,NA))
//   gap      -> [NA, 1,  x, y]        (gapFill = c(NA,1))
//   lateral  -> [xa, ya, xb, yb]
//   width geometry uses C/D (cols 2,3) as the "main" point and A/B (cols 0,1)
//   as the lateral first-point.
//
// GEOMETRY: widths are Euclidean distances between successive main points, with
// gap segments subtracted out, and the whole width vector is REVERSED at the end
// (R: `cbind(1:length(ringWidths), rev(ringWidths))`).
//
// distGap BUG (see flag near branch 1 below): R's load_pos uses `distGap` in the
// lastGap branch without ever initialising it at function scope. It is only
// created inside the gapCount==2 branch, which — in a well-formed 2-marker gap —
// always runs BEFORE lastGap becomes TRUE, so the reference happens to succeed.
// It is a LATENT bug: a malformed file that set lastGap without a preceding
// gapCount==2 would throw "object 'distGap' not found" in R. We reproduce R's
// actual behavior faithfully (no silent fix); see the flagged comment.
// ============================================================================

const NA = null;

// R semantics: sqrt((x1-x2)^2 + (y1-y2)^2). NA propagates to NaN (as in R).
function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
}

// Parse one raw .pos data line into [A,B,C,D] + flags, mirroring R exactly.
function parseLine(raw) {
  let currentLine = raw;
  let gapSwitch = false;
  let latSwitch = false;

  // if (gregexpr('D', currentLine)[[1]][1] == 1): starts with 'D' -> gap marker.
  if (currentLine.indexOf('D') === 0) {
    gapSwitch = true;
    // R: gsub("D","",currentLine) removes ALL 'D's from the line.
    currentLine = currentLine.replace(/D/g, '');
  }

  // if (gregexpr('  ', currentLine)[[1]] != -1): contains a double space.
  if (currentLine.indexOf('  ') !== -1) {
    latSwitch = true;
    // R: strsplit(currentLine, "  ") -> pieces, then split each by "," and take
    // c(piece1_nums, piece2_nums) = [xa, ya, xb, yb].
    const pieces = currentLine.split('  ');
    const a = pieces[0].split(',').map(Number);
    const b = pieces[1].split(',').map(Number);
    return { row: [a[0], a[1], b[0], b[1]], gapSwitch, latSwitch };
  }

  // Non-lateral: [naFill/gapFill, x, y] where naFill=[NA,NA], gapFill=[NA,1].
  const xy = currentLine.split(',').map(Number);
  const head = gapSwitch ? [NA, 1] : [NA, NA];
  return { row: [head[0], head[1], xy[0], xy[1]], gapSwitch, latSwitch };
}

// loadPos(text[, seriesName]) -> Frame.
// The R function returns an unnamed 2-col matrix; its caller (load_undated)
// then sets colnames c(col1, series). We surface that here: column 0 is the
// 1..n increment index, column 1 the reversed ring widths named `seriesName`.
function loadPos(text, seriesName = 'series', col1Name = 'ring') {
  if (typeof text !== 'string') {
    throw new Error('Error in loadPos(): text not of class character');
  }

  // read.table drops blank lines; split on CR/LF and discard empty lines.
  const allLines = text.split(/\r\n|\r|\n/).filter(l => l.length > 0);

  const POSdata = [];        // rows of [A,B,C,D]
  const ringWidths = [];
  let gapCount = 0;
  let lastGap = false;
  let distGap;               // NOTE: intentionally undefined at start, as in R.

  // R: for (i in 2:dim(POStest)[1]) -> skip header line (index 0 here).
  for (let i = 1; i < allLines.length; i++) {
    const { row, gapSwitch, latSwitch } = parseLine(allLines[i]);
    POSdata.push(row);

    // k = i-1 in R (1-based POSdata row of the current line). Here `cur` is the
    // 0-based index of the just-pushed row; `cur-1`,`cur-3` mirror k-1,k-3.
    const cur = POSdata.length - 1;

    // R measures only once >= 2 data rows exist (R: if (i>=3)).
    if (POSdata.length < 2) continue;

    // default typical coords: main point (C,D) of current and previous rows.
    let x1 = POSdata[cur][2];
    let y1 = POSdata[cur][3];
    let x2 = POSdata[cur - 1][2];
    let y2 = POSdata[cur - 1][3];

    if (lastGap === true) {
      // ---- far side of a gap ----
      if (latSwitch === true) {
        x1 = POSdata[cur][0];      // lateral: first coord (A,B)
        y1 = POSdata[cur][1];
        x2 = POSdata[cur - 3][2];  // anchor = point 3 rows back (before the 2 D's)
        y2 = POSdata[cur - 3][3];
      } else {
        x2 = POSdata[cur - 3][2];
        y2 = POSdata[cur - 3][3];
      }
      let dist1 = dist(x1, y1, x2, y2);
      // BUG (faithful to R): `distGap` was only ever assigned in the gapCount==2
      // branch below. In a valid 2-marker gap that branch ran first, so distGap
      // is defined here. A CORRECTED load_pos would initialise distGap <- 0 at
      // the top (matching gapCount) so a stray lastGap can't reference an
      // undefined value; we do NOT do that, to stay bit-identical to R.
      dist1 = dist1 - distGap;
      distGap = 0;
      ringWidths.push(dist1);
      lastGap = false;
    } else if (latSwitch === true) {
      // ---- lateral jump ----
      x1 = POSdata[cur][0];        // measure to first coord (A,B)
      y1 = POSdata[cur][1];        // (x2,y2 stay = previous main point)
      ringWidths.push(dist(x1, y1, x2, y2));
    } else if (gapSwitch === true) {
      // ---- a gap marker point ----
      gapCount = gapCount + 1;
      if (gapCount === 2) {
        lastGap = true;
        gapCount = 0;
        distGap = dist(x1, y1, x2, y2); // gap length = dist between the 2 markers
      }
      // gapCount === 1: do nothing (no width emitted).
    } else {
      // ---- normal successive point ----
      ringWidths.push(dist(x1, y1, x2, y2));
    }
  }

  // R: cbind(1:length(ringWidths), rev(ringWidths)).
  const n = ringWidths.length;
  const increment = Array.from({ length: n }, (_, i) => i + 1);
  const widths = ringWidths.slice().reverse();
  return { names: [col1Name, seriesName], cols: [increment, widths] };
}

module.exports = { loadPos };
