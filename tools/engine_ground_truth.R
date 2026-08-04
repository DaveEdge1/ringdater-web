#!/usr/bin/env Rscript
# ============================================================================
# Ground truth for the RingdateR orchestration engine (src/engine/*).
# Sources the ACTUAL ringdater R functions + dplR and runs BOTH end-to-end
# pipelines on the bundled example data, exactly as the roxygen @examples and
# the package vignettes do:
#
#   pairwise (mode 1):   load_undated -> normalise -> lead_lag_analysis(mode=1)
#                        -> filter_crossdates -> align_series
#                        -> prob_check + R_bar_EPS
#   chronology (mode 2): + load_chron -> normalise -> mean chronology
#                        -> comb.NA -> lead_lag_analysis(mode=2)
#                        -> filter_crossdates -> align_series -> align_to_chron
#                        -> prob_check + R_bar_EPS
#
# Emits every artifact as JSON (format(digits = 17); NA -> null) for
# test/engine_test.js to diff against pairwiseWorkflow / chronologyWorkflow.
# ============================================================================

suppressMessages({
  library(dplR); library(readxl); library(stringr)
})

RPKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
EXT  <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata"
HERE <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
OUT  <- file.path(HERE, "test", "engine_gt.json")

for (f in c(
  "comb_NA_function.R", "whiten_function.R", "name_check_function.R",
  "align_undaed_load_function.R",
  "load_pos_function.R", "load_lps_function.R", "readRWL_functions.R",
  "load_ring_measurer_fun.R", "combine_RM_files_function.R",
  "load_undated_function.R", "load_chron_function.R",
  "normalise_function.R", "lead_lag_analysis_function.R",
  "filter_crossdates_function.R", "align_series_function.R",
  "align_to_chron_function.R", "prob_check_function.R",
  "R_bar_EPS_function.R"
)) source(file.path(RPKG, f))

# ------------------------------------------------------------------------------
# Shared analysis options (match test/engine_test.js exactly)
# ------------------------------------------------------------------------------
DET_SEL <- 3        # Spline detrend (no nls path-diffs)
SPLINE  <- 21

# ==============================================================================
# PAIRWISE workflow (mode 1)
# ==============================================================================
undated_data <- load_undated(file.path(EXT, "undated_example.csv"))
pw_detrended <- normalise(the.data = undated_data, detrending_select = DET_SEL, splinewindow = SPLINE)

pw_ll   <- lead_lag_analysis(the_data = pw_detrended, mode = 1,
                             neg_lag = -20, pos_lag = 20, complete = TRUE)
pw_cross <- as.data.frame(pw_ll[1])

pw_target <- "sample_a"
pw_filtered <- filter_crossdates(the_data = pw_cross, r_val = 0.5, p_val = 0.05,
                                 overlap = 30, target = pw_target)
pw_aligned  <- align_series(the_data = pw_detrended, cross_dates = pw_filtered,
                            sel_target = pw_target)
pw_prob <- prob_check(pw_aligned, wind = 30)
pw_rbar <- R_bar_EPS(pw_aligned, window = 30)

# ==============================================================================
# CHRONOLOGY workflow (mode 2)
# ==============================================================================
ch_undated_det <- normalise(the.data = undated_data, detrending_select = DET_SEL, splinewindow = SPLINE)

chron_data     <- load_chron(file.path(EXT, "dated_example_excel.xlsx"))
ch_chron_det   <- normalise(the.data = chron_data, detrending_select = DET_SEL, splinewindow = SPLINE)

ch_mean  <- data.frame(ch_chron_det[, 1], rowMeans(ch_chron_det[, -1], na.rm = TRUE))
colnames(ch_mean) <- c("year", "mean_chronology")

ch_nseries <- comb.NA(ch_mean, ch_undated_det[, -1], fill = NA)
colnames(ch_nseries) <- c("year", "mean_chronology", colnames(ch_undated_det)[-1])

ch_ll    <- lead_lag_analysis(the_data = ch_nseries, mode = 2,
                              neg_lag = -20, pos_lag = 20, complete = FALSE)
ch_cross <- as.data.frame(ch_ll[1])

ch_target   <- "mean_chronology"
ch_filtered <- filter_crossdates(the_data = ch_cross, r_val = 0.5, p_val = 0.05,
                                 overlap = 40, target = ch_target)
ch_aligned_series <- align_series(the_data = ch_nseries, cross_dates = ch_filtered,
                                  sel_target = ch_target)
ch_aligned <- align_to_chron(the.data = ch_aligned_series, chrono = ch_chron_det)
ch_prob <- prob_check(ch_aligned, wind = 40)
ch_rbar <- R_bar_EPS(ch_aligned, window = 40)

# ------------------------------------------------------------------------------
# JSON helpers (hand-rolled, format(digits = 17), NA -> null)
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
  df <- as.data.frame(df)
  nm <- colnames(df); nc <- ncol(df)
  colparts <- character(nc)
  for (j in seq_len(nc)) {
    column <- df[[j]]
    is_char <- is.character(column) || is.factor(column)
    if (is.factor(column)) column <- as.character(column)
    cells <- vapply(seq_along(column), function(i) jcell(column[i], is_char), "")
    colparts[j] <- paste0("[", paste(cells, collapse = ","), "]")
  }
  names_json <- paste0("[", paste(vapply(nm, jstr, ""), collapse = ","), "]")
  cols_json  <- paste0("[", paste(colparts, collapse = ","), "]")
  paste0('{"names":', names_json, ',"cols":', cols_json, '}')
}
jarr_str <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")

# prob_check() returns one of three data.frame shapes; normalise to the JS
# probCheck() contract { message, samples[], intervals[] }.
prob_to_json <- function(res) {
  cn <- colnames(res)
  if (identical(cn, c("Flagged sample", "Flagged interval"))) {
    samples   <- as.character(res[, 1]); intervals <- as.character(res[, 2])
    message   <- "null"
  } else if ("Flagged_samples" %in% cn) {
    samples <- character(0); intervals <- character(0); message <- jstr("No problems detected")
  } else {                                    # "Segment length too long"
    samples <- character(0); intervals <- character(0); message <- jstr(as.character(res[1, 1]))
  }
  paste0('{"message":', message,
         ',"samples":',   jarr_str(samples),
         ',"intervals":', jarr_str(intervals), '}')
}

json <- paste0("{\n",
  '"pairwise":{\n',
    '"detrended":',   df_to_json(pw_detrended), ',\n',
    '"crossDatRes":', df_to_json(pw_cross),     ',\n',
    '"filtered":',    df_to_json(pw_filtered),  ',\n',
    '"aligned":',     df_to_json(pw_aligned),   ',\n',
    '"probCheck":',   prob_to_json(pw_prob),    ',\n',
    '"rBarEps":',     df_to_json(pw_rbar),      '\n',
  '},\n',
  '"chronology":{\n',
    '"detrended":',      df_to_json(ch_undated_det),   ',\n',
    '"chronDetrended":', df_to_json(ch_chron_det),     ',\n',
    '"chronNSeries":',   df_to_json(ch_nseries),       ',\n',
    '"crossDatRes":',    df_to_json(ch_cross),         ',\n',
    '"filtered":',       df_to_json(ch_filtered),      ',\n',
    '"alignedSeries":',  df_to_json(ch_aligned_series),',\n',
    '"aligned":',        df_to_json(ch_aligned),       ',\n',
    '"probCheck":',      prob_to_json(ch_prob),        ',\n',
    '"rBarEps":',        df_to_json(ch_rbar),          '\n',
  '}\n}\n')

writeLines(json, OUT)
cat("wrote", OUT, "\n")
cat("PW  detrended", nrow(pw_detrended), "x", ncol(pw_detrended),
    " cross", nrow(pw_cross), " filtered", nrow(pw_filtered),
    " aligned", nrow(pw_aligned), "x", ncol(pw_aligned),
    " rbar", nrow(pw_rbar), "\n")
cat("CH  nseries", nrow(ch_nseries), "x", ncol(ch_nseries),
    " cross", nrow(ch_cross), " filtered", nrow(ch_filtered),
    " aligned", nrow(ch_aligned), "x", ncol(ch_aligned),
    " rbar", nrow(ch_rbar), "\n")
