# Ground truth generator for ringdater::prob_check parity tests.
# Sources the ACTUAL ringdater function + dplR, runs on aligned chronologies
# built from detrended ca533 subsets, and emits the reshaped data.frame
# (flagged samples + " to " interval strings) plus the special-case messages.

suppressMessages(library(dplR))
data(ca533)
source("/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R/prob_check_function.R")

outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/probcheck_gt.json"

jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) {
    if (is.na(v)) "null" else format(v, digits = 17, scientific = FALSE, trim = TRUE)
  }, character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstrvec <- function(x) paste0("[", paste(vapply(x, function(s)
  paste0("\"", gsub("\"", "\\\\\"", s), "\""), character(1)), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")

# new.chrono = data.frame(years, series...)  (first col = years)
make_chrono <- function(rwl) {
  data.frame(years = as.numeric(rownames(rwl)), rwl, check.names = FALSE)
}

dump_input <- function(nc) {
  # nc[,1] years, nc[,-1] series
  years <- nc[, 1]
  ser <- nc[, -1, drop = FALSE]
  cols <- lapply(seq_len(ncol(ser)), function(j) jarr(ser[, j]))
  paste0("{\"years\":", jarr(years),
         ",\"ids\":", jstrvec(colnames(ser)),
         ",\"series\":[", paste(unlist(cols), collapse = ","), "]}")
}

# classify the returned data.frame into a normalized structure
run_case <- function(name, nc, wind) {
  r <- prob_check(nc, wind = wind)
  cn <- colnames(r)
  if (identical(cn, "len")) {
    body <- paste0("\"message\":", jstr(as.character(r[1, 1])),
                   ",\"samples\":[],\"intervals\":[]")
  } else if (identical(cn, "Flagged_samples")) {
    body <- paste0("\"message\":", jstr(as.character(r[1, 1])),
                   ",\"samples\":[],\"intervals\":[]")
  } else {
    body <- paste0("\"message\":null",
                   ",\"samples\":", jstrvec(rownames(r)),
                   ",\"intervals\":", jstrvec(r[, 2]))
  }
  paste0("{\"name\":", jstr(name), ",\"wind\":", wind, ",", body, "}")
}

# "No problems detected": near-identical real-derived series (base + tiny noise).
det3 <- detrend(ca533[, 1:3], method = "Spline", nyrs = 21, verbose = FALSE)
base <- det3[, 1]
set.seed(1)
np <- data.frame(a = base,
                 b = base + rnorm(length(base), 0, 1e-6),
                 c = base + rnorm(length(base), 0, 1e-6),
                 d = base + rnorm(length(base), 0, 1e-6))
rownames(np) <- rownames(det3)
np <- np[!is.na(base), , drop = FALSE]

cases <- list(
  list(name = "ca533_1_20_w20", rwl = detrend(ca533[, 1:20], method = "Spline", nyrs = 21, verbose = FALSE), wind = 20),
  list(name = "ca533_1_20_w21_odd", rwl = detrend(ca533[, 1:20], method = "Spline", nyrs = 21, verbose = FALSE), wind = 21),
  list(name = "ca533_1_10_w30", rwl = detrend(ca533[, 1:10], method = "Spline", nyrs = 21, verbose = FALSE), wind = 30),
  list(name = "ca533_1_5_w50", rwl = detrend(ca533[, 1:5], method = "Spline", nyrs = 21, verbose = FALSE), wind = 50),
  # segment too long: tiny nrow (bin=20 > 0.5*30). Detrend full, then take 30
  # contiguous rows that have data.
  list(name = "seg_too_long",
       rwl = tail(detrend(ca533[, 1:5], method = "Spline", nyrs = 21, verbose = FALSE), 30),
       wind = 20),
  list(name = "no_problems", rwl = np, wind = 30)
)

objs <- vapply(cases, function(cs) {
  nc <- make_chrono(cs$rwl)
  paste0("{\"expected\":", run_case(cs$name, nc, cs$wind),
         ",\"input\":", dump_input(nc), "}")
}, character(1))

writeLines(paste0("[", paste(objs, collapse = ","), "]"), outfile)
cat("wrote", outfile, "with", length(objs), "cases\n")
