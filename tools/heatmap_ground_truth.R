#!/usr/bin/env Rscript
# Ground truth for the running-correlation heatmap data generators (T1.6):
#   running_lead_lag  (R/running_lead_lag_function.R)
#   heatmap_analysis  (data step of R/heatmap_analysis_function.R)
#
# Sources the ACTUAL ringdater functions (running_lead_lag, rollcor, comb.NA)
# plus zoo::rollmean and library(dplR). Builds a DETRENDED (z-scored) multi-series
# input frame directly in R and embeds it in the JSON so JS runs identical input.
# heatmap_analysis returns a ggplot; its DATA output is plot.data, which equals
#   running_lead_lag(the_data, s1, s2, neg_lag+center, pos_lag+center, win, complete)
# so the "heat" cases replay that exact call (we cannot serialize a ggplot).
#
# Numbers via format(x, digits = 17); NA -> null; hand-written serializer.

suppressMessages(library(dplR))
suppressMessages(library(zoo))     # provides rollmean (centered, length n-win+1)

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "rollcor_function.R"))
source(file.path(pkg, "running_lead_lag_function.R"))

here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out  <- file.path(here, "test", "heatmap_gt.json")

# ------------------------------------------------------------------------------
# Build a synthetic DETRENDED (z-scored) multi-series frame: windows of a common
# signal placed at staggered rows with small noise, each z-scored over its span.
# A far-offset series (F) gives a no-overlap pair to exercise the nrow<15 -> NULL
# guard.
# ------------------------------------------------------------------------------
set.seed(7)
N   <- 160
sig <- as.numeric(rnorm(N))
zscore <- function(v) (v - mean(v)) / sd(v)
mk <- function(sig_from, sig_to, row0, noise_sd) {
  n   <- sig_to - sig_from + 1
  val <- sig[sig_from:sig_to] + rnorm(n, sd = noise_sd)
  col <- rep(NA_real_, N)
  idx <- row0:(row0 + n - 1)
  col[idx] <- zscore(val)
  col
}
A <- mk(  1,  90,   1, 0.30)   # rows 1..90
B <- mk( 20, 120,  20, 0.30)   # rows 20..120
C <- mk( 40, 130,  45, 0.25)   # rows 45..135  (offset +5)
D <- mk( 55, 150,  55, 0.20)   # rows 55..150
G <- mk(  1,  12, 145, 0.20)   # rows 145..156 (tiny; no overlap with A -> NULL)

years <- as.numeric(1:N)
the_data <- data.frame(year = years, A = A, B = B, C = C, D = D, G = G,
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
df_to_json <- function(df) {
  if (is.null(df) || nrow(df) == 0) return("null")
  nm <- colnames(df); nc <- ncol(df)
  colparts <- character(nc)
  for (j in seq_len(nc)) {
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
# running_lead_lag cases
# ------------------------------------------------------------------------------
rll_cases <- list(
  list(key = "AB_cF",       s1 = "A", s2 = "B", neg = -20, pos = 20, win = 21, complete = FALSE),
  list(key = "AB_cT",       s1 = "A", s2 = "B", neg = -20, pos = 20, win = 21, complete = TRUE),
  list(key = "AC_cF_even",  s1 = "A", s2 = "C", neg = -15, pos = 15, win = 20, complete = FALSE),
  list(key = "BD_cT",       s1 = "B", s2 = "D", neg = -30, pos = 30, win = 31, complete = TRUE),
  list(key = "AD_cF_asym",  s1 = "A", s2 = "D", neg = -10, pos = 40, win = 15, complete = FALSE),
  list(key = "AG_null",     s1 = "A", s2 = "G", neg = -5,  pos =  5, win = 21, complete = FALSE)
)
run_rll <- function(cs) {
  r <- running_lead_lag(the_data = the_data, s1 = cs$s1, s2 = cs$s2,
                        neg_lag = cs$neg, pos_lag = cs$pos, win = cs$win, complete = cs$complete)
  df_to_json(r)
}
rll_parts <- vapply(rll_cases, function(cs) paste0(jstr(cs$key), ":", run_rll(cs)), "")

# ------------------------------------------------------------------------------
# heatmap_analysis DATA cases (= running_lead_lag with neg_lag+center, pos_lag+center)
# ------------------------------------------------------------------------------
heat_cases <- list(
  list(key = "AB_c0",   s1 = "A", s2 = "B", neg = -20, pos = 20, win = 21, center =  0, complete = FALSE),
  list(key = "AB_c5",   s1 = "A", s2 = "B", neg = -20, pos = 20, win = 21, center =  5, complete = FALSE),
  list(key = "AC_cm10", s1 = "A", s2 = "C", neg = -15, pos = 15, win = 21, center = -10, complete = FALSE),
  list(key = "BD_c0T",  s1 = "B", s2 = "D", neg = -20, pos = 20, win = 21, center =  0, complete = TRUE)
)
run_heat <- function(cs) {
  r <- running_lead_lag(the_data = the_data, s1 = cs$s1, s2 = cs$s2,
                        neg_lag = cs$neg + cs$center, pos_lag = cs$pos + cs$center,
                        win = cs$win, complete = cs$complete)
  df_to_json(r)
}
heat_parts <- vapply(heat_cases, function(cs) paste0(jstr(cs$key), ":", run_heat(cs)), "")

json <- paste0("{\n",
  '"input":', df_to_json(the_data), ',\n',
  '"rll":{',  paste(rll_parts,  collapse = ","), "},\n",
  '"heat":{', paste(heat_parts, collapse = ","), "}\n}\n")

writeLines(json, out)
cat("wrote", out, "\n")
