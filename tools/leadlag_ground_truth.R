#!/usr/bin/env Rscript
# Ground truth for lead_lag_analysis JS port (T1.5).
# Sources the ACTUAL ringdater R implementation (lead_lag_analysis_function.R and
# comb_NA_function.R) plus dplR, constructs a DETRENDED multi-series input frame
# directly (decoupled from normalise), runs lead_lag_analysis for all 4 param
# combos (mode 1/2 x complete T/F), and emits JSON with a hand-rolled serializer.
# Numbers via format(x, digits=17); NA -> null.

suppressMessages(library(dplR))

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "lead_lag_analysis_function.R"))

here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out  <- file.path(here, "test", "leadlag_gt.json")

# ------------------------------------------------------------------------------
# Build a synthetic DETRENDED (z-scored) multi-series frame with a common signal,
# staggered spans and a deliberate mis-dating offset so best lags are non-trivial.
# ------------------------------------------------------------------------------
set.seed(42)
N   <- 200
sig <- as.numeric(rnorm(N))               # common underlying signal (in "signal space")

zscore <- function(v) (v - mean(v)) / sd(v)

# each series: window of sig in signal-space, placed at rows [row0 .. row0+len-1],
# with small independent noise, then z-scored over its measured span.
mk <- function(sig_from, sig_to, row0, noise_sd) {
  n   <- sig_to - sig_from + 1
  val <- sig[sig_from:sig_to] + rnorm(n, sd = noise_sd)
  col <- rep(NA_real_, N)
  idx <- row0:(row0 + n - 1)
  col[idx] <- zscore(val)
  col
}

A <- mk(  1,  80,   1, 0.30)   # rows 1..80    offset 0
B <- mk( 20, 110,  20, 0.30)   # rows 20..110  offset 0  (overlaps A on 20..80)
C <- mk( 40, 130,  45, 0.25)   # rows 45..135  offset +5 (mis-dated vs signal by 5)
D <- mk(  1, 100,   1, 0.35)   # rows 1..100   offset 0
E <- mk( 60, 150,  60, 0.20)   # rows 60..150  offset 0

years <- 1:N
the_data <- data.frame(year = as.numeric(years),
                       A = A, B = B, C = C, D = D, E = E,
                       stringsAsFactors = FALSE)

# ------------------------------------------------------------------------------
# minimal JSON helpers
# ------------------------------------------------------------------------------
num <- function(x) {
  if (is.na(x)) return("null")
  trimws(format(x, digits = 17, scientific = FALSE))
}
jstr  <- function(s) paste0('"', gsub('"', '\\\\"', s), '"')
jcell <- function(x, is_char) {
  if (length(x) == 0 || is.na(x)) return("null")
  if (is_char) jstr(as.character(x)) else num(as.numeric(x))
}
# data.frame -> {"names":[...],"cols":[[...],...]}   (cols emitted column-major)
df_to_json <- function(df) {
  nm <- colnames(df)
  ncol <- ncol(df)
  colparts <- character(ncol)
  for (j in seq_len(ncol)) {
    column  <- df[[j]]
    is_char <- is.character(column)
    cells   <- vapply(seq_along(column), function(i) jcell(column[i], is_char), "")
    colparts[j] <- paste0("[", paste(cells, collapse = ","), "]")
  }
  names_json <- paste0("[", paste(vapply(nm, jstr, ""), collapse = ","), "]")
  cols_json  <- paste0("[", paste(colparts, collapse = ","), "]")
  paste0('{"names":', names_json, ',"cols":', cols_json, '}')
}

# ------------------------------------------------------------------------------
# run all 4 combos
# ------------------------------------------------------------------------------
run_case <- function(mode, complete) {
  r <- lead_lag_analysis(the_data = the_data, mode = mode,
                         neg_lag = -20, pos_lag = 20, complete = complete)
  cross_dat_res  <- r[[1]]
  master_lead_lag <- r[[2]]
  paste0('{"cross_dat_res":', df_to_json(cross_dat_res),
         ',"master_lead_lag":', df_to_json(master_lead_lag), '}')
}

cases <- list(
  list(key = "m1_cT", mode = 1, complete = TRUE),
  list(key = "m1_cF", mode = 1, complete = FALSE),
  list(key = "m2_cT", mode = 2, complete = TRUE),
  list(key = "m2_cF", mode = 2, complete = FALSE)
)
case_parts <- vapply(cases, function(cs)
  paste0(jstr(cs$key), ":", run_case(cs$mode, cs$complete)), "")

json <- paste0("{\n",
  '"input":', df_to_json(the_data), ',\n',
  '"cases":{', paste(case_parts, collapse = ","), "}\n}\n")

writeLines(json, out)
cat("wrote", out, "\n")
