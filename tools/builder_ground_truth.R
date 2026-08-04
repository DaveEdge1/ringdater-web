#!/usr/bin/env Rscript
# Ground truth for the interactive chronology builder (src/engine/builder.js).
# Sources the ACTUAL ringdater primitives the builder reuses (comb.NA,
# lead_lag_analysis, filter_crossdates, align_series) and constructs a
# controlled shared-signal scenario in which the correct crossdate lag K is
# KNOWN by construction, so the builder's recovered lag / placement can be
# checked against both K and against ringdater's own output.
#
# Scenario (all series already effectively detrended -> builder runs with
# detrending_select = 1 (raw) so JS and R operate on IDENTICAL numbers):
#   * 5 chronology members, zscored shared signal over absolute years 1501..1620
#   * 1 "undated" candidate = a zscored window of the SAME signal (signal rows
#     31..90) carried on its own increment axis 1..60.
# The candidate therefore crossdates to the mean chronology at lag K = 30, i.e.
# its true absolute years are 1531..1590.
#
# Emits: the raw scenario frames (so JS rebuilds identical inputs), the
# cross_dat_res from lead_lag_analysis on the same comb.NA frame, and the
# align_series placement for lag 30. Numbers via format(digits = 17); NA -> null.

suppressMessages(library(dplR))

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "lead_lag_analysis_function.R"))
source(file.path(pkg, "filter_crossdates_function.R"))
source(file.path(pkg, "align_series_function.R"))

out <- "/home/dave/ringdater/test/builder_gt.json"

# ------------------------------------------------------------------------------
# scenario construction
# ------------------------------------------------------------------------------
set.seed(101)
zscore <- function(v) (v - mean(v)) / sd(v)

Ns  <- 130
sig <- as.numeric(rnorm(Ns))          # shared underlying signal

start_year <- 1501
chron_len  <- 120                     # members span signal rows 1..120
K          <- 30                      # candidate offset (known crossdate lag)
cand_len   <- 60                      # candidate spans signal rows 31..90

# 5 chronology members: shared signal + small independent noise, zscored.
member <- function(seed_add, noise_sd) {
  set.seed(1000 + seed_add)
  zscore(sig[1:chron_len] + rnorm(chron_len, sd = noise_sd))
}
chron_df <- data.frame(
  year = as.numeric(start_year:(start_year + chron_len - 1)),
  M1 = member(1, 0.20), M2 = member(2, 0.22), M3 = member(3, 0.18),
  M4 = member(4, 0.24), M5 = member(5, 0.21),
  stringsAsFactors = FALSE
)

set.seed(2001)
cand_vals <- zscore(sig[(K + 1):(K + cand_len)] + rnorm(cand_len, sd = 0.20))
undated_df <- data.frame(increment = as.numeric(1:cand_len),
                         cand = cand_vals, stringsAsFactors = FALSE)

# ------------------------------------------------------------------------------
# mean chronology + comb.NA frame, exactly as the builder assembles it
# ------------------------------------------------------------------------------
chrono <- data.frame(chron_df[, 1], rowMeans(chron_df[, -1], na.rm = TRUE))
colnames(chrono) <- c("year", "mean_chronology")

cn <- comb.NA(chrono, undated_df[, -1, drop = FALSE], fill = NA)
colnames(cn) <- c("year", "mean_chronology", "cand")

ll <- lead_lag_analysis(the_data = cn, mode = 2,
                        neg_lag = -20, pos_lag = 20, complete = TRUE)
cross_dat_res <- ll[[1]]

# synthesise the filtered row at the known best lag K and align.
filt <- data.frame(Series_1 = "mean_chronology", Series_2 = "cand",
                   First_ring = NA, Last_ring = NA, col = NA,
                   First_lag = K, First_R = NA, First_P = NA, First_Overlap = NA,
                   Sec_lag = NA, Sec_R = NA, Sec_P = NA, Sec_Overlap = NA,
                   Third_lag = NA, Third_R = NA, Third_P = NA, Third_Overlap = NA,
                   stringsAsFactors = FALSE)
aligned <- align_series(the_data = cn, cross_dates = filt, sel_target = "mean_chronology")

# ------------------------------------------------------------------------------
# JSON helpers (column-major df -> {"names":[...],"cols":[[...],...]})
# ------------------------------------------------------------------------------
num <- function(x) { if (is.na(x)) return("null"); trimws(format(x, digits = 17, scientific = FALSE)) }
jstr  <- function(s) paste0('"', gsub('"', '\\\\"', s), '"')
jcell <- function(x, is_char) {
  if (length(x) == 0 || is.na(x)) return("null")
  if (is_char) jstr(as.character(x)) else num(as.numeric(x))
}
df_to_json <- function(df) {
  nm <- colnames(df); nc <- ncol(df); cp <- character(nc)
  for (j in seq_len(nc)) {
    column <- df[[j]]; is_char <- is.character(column)
    cells <- vapply(seq_along(column), function(i) jcell(column[i], is_char), "")
    cp[j] <- paste0("[", paste(cells, collapse = ","), "]")
  }
  paste0('{"names":[', paste(vapply(nm, jstr, ""), collapse = ","),
         '],"cols":[', paste(cp, collapse = ","), "]}")
}

json <- paste0("{\n",
  '"K":', K, ',\n',
  '"chron":', df_to_json(chron_df), ',\n',
  '"undated":', df_to_json(undated_df), ',\n',
  '"cross_dat_res":', df_to_json(cross_dat_res), ',\n',
  '"aligned":', df_to_json(aligned), "\n}\n")

writeLines(json, out)
cat("wrote", out, "K =", K, "\n")
