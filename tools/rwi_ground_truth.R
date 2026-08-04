# Ground truth generator for rwi.stats.running (Rbar/EPS) parity tests.
# Mirrors ringdater's R_bar_EPS call:
#   rwi.stats.running(rwl, method="pearson", running.window=TRUE,
#                     window.length=window, window.overlap=floor(window/2),
#                     first.start=NULL, round.decimals=3, zero.is.missing=TRUE)
# Emits mid.year, n.trees, n, rbar.tot, eps per segment as JSON with a
# hand-rolled serializer (no extra R packages). Numbers use digits=17.

suppressMessages(library(dplR))
data(ca533)

outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/rwi_gt.json"

# ---- minimal JSON helpers ---------------------------------------------------
jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) {
    if (is.na(v)) "null" else format(v, digits = 17, scientific = FALSE, trim = TRUE)
  }, character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")

# Run one case and return a JSON object string.
run_case <- function(name, rwl, window) {
  test <- rwi.stats.running(rwl, method = "pearson", running.window = TRUE,
                            window.length = window,
                            window.overlap = floor(window / 2),
                            first.start = NULL, round.decimals = 3,
                            zero.is.missing = TRUE)
  fields <- c(
    paste0("\"name\":", jstr(name)),
    paste0("\"window\":", window),
    paste0("\"nseries\":", ncol(rwl)),
    paste0("\"start_year\":", jarr(test$start.year)),
    paste0("\"mid_year\":", jarr(test$mid.year)),
    paste0("\"end_year\":", jarr(test$end.year)),
    paste0("\"n_trees\":", jarr(test$n.trees)),
    paste0("\"n\":", jarr(test$n)),
    paste0("\"rbar_tot\":", jarr(test$rbar.tot)),
    paste0("\"eps\":", jarr(test$eps))
  )
  paste0("{", paste(fields, collapse = ","), "}")
}

# Series matrix for one case, written so the JS side reads identical inputs.
dump_input <- function(rwl) {
  years <- as.numeric(rownames(rwl))
  cols <- lapply(seq_len(ncol(rwl)), function(j) jarr(rwl[, j]))
  paste0("{\"years\":", jarr(years),
         ",\"ids\":[", paste(vapply(colnames(rwl), jstr, character(1)), collapse = ","), "]",
         ",\"series\":[", paste(unlist(cols), collapse = ","), "]}")
}

sub <- ca533[, 1:15]
det <- detrend(sub, method = "Spline", nyrs = 21, verbose = FALSE)

cases <- list(
  list(name = "ca533_1_15_w25", rwl = sub, window = 25),
  list(name = "ca533_1_15_w50", rwl = sub, window = 50),
  list(name = "ca533_detrend_w50", rwl = det, window = 50),
  list(name = "ca533_detrend_w30", rwl = det, window = 30)
)

objs <- vapply(cases, function(cs) {
  paste0("{\"expected\":", run_case(cs$name, cs$rwl, cs$window),
         ",\"input\":", dump_input(cs$rwl), "}")
}, character(1))

writeLines(paste0("[", paste(objs, collapse = ","), "]"), outfile)
cat("wrote", outfile, "with", length(objs), "cases\n")
