# Ground truth generator for ringdater::load_pos (Image-Pro .pos parser).
# Sources the ACTUAL load_pos_function.R + library(dplR). No real .pos fixtures
# exist, so we SYNTHESIZE syntactically valid .pos files that exercise the
# format's features (straight run, gap 'D' markers, lateral '  ' jumps, and the
# combined lastGap+lateral branch), run the real load_pos, and emit JSON with a
# hand-rolled serializer (digits=17). The raw .pos text is embedded so the JS
# side parses byte-identical input.

suppressMessages(library(dplR))

RPKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(RPKG, "load_pos_function.R"))

outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/pos_gt.json"
tmpdir  <- tempdir()

# ---- minimal JSON helpers ---------------------------------------------------
jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) {
    if (is.null(v) || is.na(v)) "null"
    else format(v, digits = 17, scientific = FALSE, trim = TRUE)
  }, character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
# JSON-escape a string (only need backslash, quote, newline for our .pos text)
jstr <- function(s) {
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub("\"", "\\\\\"", s)
  s <- gsub("\n", "\\\\n", s)
  paste0("\"", s, "\"")
}

# ---- synthesized .pos fixtures ----------------------------------------------
# Each is a vector of raw lines. Line 1 is a header (load_pos skips row 1).
# Coordinate points are "x,y". A leading 'D' marks a gap point. A double-space
# "  " separates the two coordinates of a lateral jump line: "xa,ya  xb,yb".

fixtures <- list(
  # 1: simple straight run, no gaps/laterals. widths measured between successive
  #    normal points; result is REVERSED.
  straight = c(
    "SCALE 1.0 HEADER LINE",
    "0,0",
    "10,0",
    "25,0",
    "45,0"
  ),
  # 2: run containing a gap (two consecutive 'D' points). The far side of the gap
  #    triggers the lastGap branch: dist(current, point 3 rows back) - distGap.
  gap = c(
    "SCALE 1.0 HEADER LINE",
    "0,0",
    "10,0",
    "D20,0",
    "D30,0",
    "50,0",
    "65,0"
  ),
  # 3: a lateral jump. width measured from previous point to the FIRST coord of
  #    the lateral line; the SECOND coord becomes the anchor for the next width.
  lateral = c(
    "SCALE 1.0 HEADER LINE",
    "0,0",
    "10,0",
    "12,5  20,5",
    "40,5"
  ),
  # 4: gap immediately followed by a lateral line -> exercises the unique
  #    lastGap==TRUE & latSwitch==TRUE branch, then continues with normals.
  gap_then_lateral = c(
    "SCALE 1.0 HEADER LINE",
    "0,0",
    "10,0",
    "D20,0",
    "D30,0",
    "50,0  60,0",
    "90,0"
  ),
  # 5: richer mixed walk with non-axis-aligned (diagonal) coordinates, a lateral,
  #    a gap, and enough normals to make the reversal visibly asymmetric.
  mixed = c(
    "SCALE 1.0 HEADER LINE",
    "0,0",
    "3,4",
    "6,8",
    "10,11  12,13",
    "20,20",
    "D25,25",
    "D30,30",
    "44,44",
    "50,50"
  )
)

run_case <- function(nm, lines) {
  f <- file.path(tmpdir, paste0(nm, ".pos"))
  writeLines(lines, f)
  rw <- load_pos(file_path = f)          # 2-col matrix: [1:n, rev(ringWidths)]
  col1 <- as.numeric(rw[, 1])
  widths <- as.numeric(rw[, 2])
  raw <- paste(lines, collapse = "\n")
  paste0("{\"name\":", jstr(nm),
         ",\"pos\":", jstr(raw),
         ",\"n\":", length(widths),
         ",\"col1\":", jarr(col1),
         ",\"widths\":", jarr(widths), "}")
}

objs <- mapply(run_case, names(fixtures), fixtures, USE.NAMES = FALSE)
writeLines(paste0("{\"cases\":[", paste(objs, collapse = ","), "]}"), outfile)
cat("wrote", outfile, "with", length(objs), "cases\n")
