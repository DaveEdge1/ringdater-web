# Ground truth generator for ringdater::R_bar_EPS parity tests.
# Sources the ACTUAL ringdater function + dplR and runs on aligned chronologies
# built from detrended ca533 subsets. Emits the returned table columns
# (mid.year, n.trees, n, rbar.tot, eps) — ROUNDED to 3 decimals as R produces
# them (round.decimals=3) — plus the raw input series matrix.

suppressMessages(library(dplR))
data(ca533)
source("/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R/R_bar_EPS_function.R")

outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/rbareps_gt.json"

jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) {
    if (is.na(v)) "null" else format(v, digits = 17, scientific = FALSE, trim = TRUE)
  }, character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")
jstrvec <- function(x) paste0("[", paste(vapply(x, jstr, character(1)), collapse = ","), "]")

make_data <- function(rwl) data.frame(years = as.numeric(rownames(rwl)), rwl, check.names = FALSE)

dump_input <- function(dat) {
  years <- dat[, 1]
  ser <- dat[, -1, drop = FALSE]
  cols <- lapply(seq_len(ncol(ser)), function(j) jarr(ser[, j]))
  paste0("{\"years\":", jarr(years),
         ",\"ids\":", jstrvec(colnames(ser)),
         ",\"series\":[", paste(unlist(cols), collapse = ","), "]}")
}

run_case <- function(name, dat, window) {
  r <- R_bar_EPS(dat, window = window)
  fields <- c(
    paste0("\"name\":", jstr(name)),
    paste0("\"window\":", window),
    paste0("\"mid_year\":", jarr(r[[1]])),
    paste0("\"n_trees\":", jarr(r[[2]])),
    paste0("\"n\":", jarr(r[[3]])),
    paste0("\"rbar_tot\":", jarr(r[[4]])),
    paste0("\"eps\":", jarr(r[[5]]))
  )
  paste0("{", paste(fields, collapse = ","), "}")
}

cases <- list(
  list(name = "ca533_1_15_w25", rwl = detrend(ca533[, 1:15], method = "Spline", nyrs = 21, verbose = FALSE), window = 25),
  list(name = "ca533_1_20_w50", rwl = detrend(ca533[, 1:20], method = "Spline", nyrs = 21, verbose = FALSE), window = 50),
  list(name = "ca533_1_10_w30", rwl = detrend(ca533[, 1:10], method = "Spline", nyrs = 21, verbose = FALSE), window = 30),
  list(name = "ca533_raw_1_15_w25", rwl = ca533[, 1:15], window = 25)
)

objs <- vapply(cases, function(cs) {
  dat <- make_data(cs$rwl)
  paste0("{\"expected\":", run_case(cs$name, dat, cs$window),
         ",\"input\":", dump_input(dat), "}")
}, character(1))

writeLines(paste0("[", paste(objs, collapse = ","), "]"), outfile)
cat("wrote", outfile, "with", length(objs), "cases\n")
