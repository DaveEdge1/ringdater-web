#!/usr/bin/env Rscript
# Ground truth for the alignment JS port (T1.8a/b/c).
# Sources the ACTUAL ringdater implementations (align_series, align_to_chron,
# onto_align_dated) plus their dependencies (comb.NA, lead_lag_analysis,
# filter_crossdates) and dplR. Builds a realistic scenario:
#   - a set of individual DATED chronology members (chrono_det),
#   - their arithmetic mean chronology (mean_chronology),
#   - several UNDATED series that are windows of the shared signal placed at
#     row 1 (i.e. mis-dated) so best lags are non-trivial,
#   - chron_n_series = comb.NA(chrono, undated[,-1]),
# runs lead_lag_analysis(mode = 2) to crossdate the undated series to the mean
# chronology, filters to the target, then aligns.
# Emits JSON with a hand-rolled serializer: format(x, digits = 17), NA -> null.

suppressMessages(library(dplR))

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "lead_lag_analysis_function.R"))
source(file.path(pkg, "filter_crossdates_function.R"))
source(file.path(pkg, "align_series_function.R"))
source(file.path(pkg, "align_to_chron_function.R"))
source(file.path(pkg, "onto_align_dated_function.R"))

here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out  <- file.path(here, "test", "align_gt.json")

# ------------------------------------------------------------------------------
# Build synthetic data
# ------------------------------------------------------------------------------
set.seed(7)
N   <- 160
sig <- as.numeric(rnorm(N))
zscore <- function(v) (v - mean(v)) / sd(v)

# individual dated chronology members: windows of the signal on the TRUE axis
mk_dated <- function(sig_from, sig_to, noise_sd) {
  n <- sig_to - sig_from + 1
  col <- rep(NA_real_, N)
  col[sig_from:sig_to] <- zscore(sig[sig_from:sig_to] + rnorm(n, sd = noise_sd))
  col
}
d1 <- mk_dated(  1, 130, 0.10)
d2 <- mk_dated( 15, 160, 0.12)
d3 <- mk_dated(  1, 110, 0.08)

chrono_det <- data.frame(year = as.numeric(1:N), d1 = d1, d2 = d2, d3 = d3,
                         stringsAsFactors = FALSE)

mean_chronology <- rowMeans(chrono_det[, -1], na.rm = TRUE)
chrono <- data.frame(year = as.numeric(1:N), mean_chronology = mean_chronology,
                     stringsAsFactors = FALSE)

# undated series: windows of the shared signal, placed starting at row 1 so the
# best lag against the mean chronology is non-zero. z-scored, small noise.
mk_undated <- function(sig_from, sig_to, noise_sd) {
  n <- sig_to - sig_from + 1
  zscore(sig[sig_from:sig_to] + rnorm(n, sd = noise_sd))
}
u1 <- mk_undated( 30, 120, 0.10)   # true lag +29
u2 <- mk_undated( 50, 140, 0.12)   # true lag +49
u3 <- mk_undated( 10, 100, 0.09)   # true lag +9
maxlen <- max(length(u1), length(u2), length(u3))
padv <- function(v) c(v, rep(NA_real_, maxlen - length(v)))
undated <- data.frame(inc = as.numeric(1:maxlen),
                      u1 = padv(u1), u2 = padv(u2), u3 = padv(u3),
                      stringsAsFactors = FALSE)

# chron_n_series: mean chronology + undated series (undated year col dropped).
chron_n_series <- comb.NA(chrono, undated[, -1], fill = NA)
colnames(chron_n_series) <- c("year", "mean_chronology", "u1", "u2", "u3")

# ------------------------------------------------------------------------------
# Crossdate + filter + align
# ------------------------------------------------------------------------------
ll <- lead_lag_analysis(the_data = chron_n_series, mode = 2,
                        neg_lag = -60, pos_lag = 60, complete = FALSE)
cross_dat_res <- ll[[1]]

filtered <- filter_crossdates(the_data = cross_dat_res,
                              r_val = 0.4, p_val = 0.05, overlap = 30,
                              target = "mean_chronology")

aligned  <- align_series(the_data = chron_n_series,
                         cross_dates = filtered,
                         sel_target = "mean_chronology")

to_chron <- align_to_chron(the.data = aligned, chrono = chrono_det)

onto     <- onto_align_dated(to_chron)

# ------------------------------------------------------------------------------
# Scenario 2: mode-1 (pairwise) so the target appears as BOTH Series_1 and
# Series_2 -> exercises align_series' else branch (new_sample = Series_1,
# lag = -First_lag) AND target front-padding (dif >= 1 for the target row).
# ------------------------------------------------------------------------------
set.seed(11)
M <- 150
sig2 <- as.numeric(rnorm(M))
mk2 <- function(sig_from, sig_to, row0, noise_sd) {
  n <- sig_to - sig_from + 1
  col <- rep(NA_real_, M)
  col[row0:(row0 + n - 1)] <- zscore(sig2[sig_from:sig_to] + rnorm(n, sd = noise_sd))
  col
}
# staggered windows with deliberate mis-dating so best lags are non-zero
S1 <- mk2( 40, 130,   1, 0.10)  # early rows, later signal
S2 <- mk2( 10, 120,  10, 0.10)  # the target
S3 <- mk2(  1,  90,  30, 0.09)
S4 <- mk2( 20, 140,   1, 0.11)
data2 <- data.frame(year = as.numeric(1:M), S1 = S1, S2 = S2, S3 = S3, S4 = S4,
                    stringsAsFactors = FALSE)
ll2 <- lead_lag_analysis(the_data = data2, mode = 1,
                         neg_lag = -80, pos_lag = 80, complete = FALSE)
filtered2 <- filter_crossdates(the_data = ll2[[1]],
                               r_val = 0.4, p_val = 0.05, overlap = 30,
                               target = "S2")
aligned2 <- align_series(the_data = data2, cross_dates = filtered2, sel_target = "S2")
onto2 <- onto_align_dated(aligned2)

# ------------------------------------------------------------------------------
# align_to_chron branch coverage with small hand-built frames.
#  caseA: chron.min > min.the.data  (chronology starts LATER -> chrono top-padded)
#  caseB: chron.min < min.the.data  (chronology starts EARLIER -> series top-padded)
# the.data must have the mean chronology in col 2 (it is stripped by the fn).
# ------------------------------------------------------------------------------
set.seed(23)
mkcol <- function(n) as.numeric(round(rnorm(n), 6))
# caseA
tdA <- data.frame(Year = as.numeric(1:10), meanchron = mkcol(10),
                  sA = mkcol(10), sB = mkcol(10), stringsAsFactors = FALSE)
chA <- data.frame(year = as.numeric(4:12), c1 = mkcol(9), c2 = mkcol(9),
                  stringsAsFactors = FALSE)
toChronA <- align_to_chron(the.data = tdA, chrono = chA)
# caseB
tdB <- data.frame(Year = as.numeric(4:15), meanchron = mkcol(12),
                  sA = mkcol(12), sB = mkcol(12), stringsAsFactors = FALSE)
chB <- data.frame(year = as.numeric(1:10), c1 = mkcol(10), c2 = mkcol(10),
                  stringsAsFactors = FALSE)
toChronB <- align_to_chron(the.data = tdB, chrono = chB)

# ------------------------------------------------------------------------------
# JSON helpers (hand-rolled)
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
  nm <- colnames(df); nc <- ncol(df)
  colparts <- character(nc)
  for (j in seq_len(nc)) {
    column <- df[[j]]
    is_char <- is.character(column)
    cells <- vapply(seq_along(column), function(i) jcell(column[i], is_char), "")
    colparts[j] <- paste0("[", paste(cells, collapse = ","), "]")
  }
  names_json <- paste0("[", paste(vapply(nm, jstr, ""), collapse = ","), "]")
  cols_json  <- paste0("[", paste(colparts, collapse = ","), "]")
  paste0('{"names":', names_json, ',"cols":', cols_json, '}')
}

json <- paste0("{\n",
  '"sel_target":', jstr("mean_chronology"), ',\n',
  '"chron_n_series":', df_to_json(chron_n_series), ',\n',
  '"chrono_det":',     df_to_json(chrono_det),     ',\n',
  '"filtered":',       df_to_json(filtered),       ',\n',
  '"aligned":',        df_to_json(aligned),        ',\n',
  '"to_chron":',       df_to_json(to_chron),       ',\n',
  '"onto":',           df_to_json(onto),           ',\n',
  '"data2":',          df_to_json(data2),          ',\n',
  '"filtered2":',      df_to_json(filtered2),      ',\n',
  '"aligned2":',       df_to_json(aligned2),       ',\n',
  '"onto2":',          df_to_json(onto2),          ',\n',
  '"tdA":',            df_to_json(tdA),            ',\n',
  '"chA":',            df_to_json(chA),            ',\n',
  '"toChronA":',       df_to_json(toChronA),       ',\n',
  '"tdB":',            df_to_json(tdB),            ',\n',
  '"chB":',            df_to_json(chB),            ',\n',
  '"toChronB":',       df_to_json(toChronB),       "\n}\n")

writeLines(json, out)
cat("wrote", out, "\n")
cat("filtered rows:", nrow(filtered), " aligned dim:", nrow(aligned), "x", ncol(aligned),
    " to_chron:", nrow(to_chron), "x", ncol(to_chron),
    " onto:", nrow(onto), "x", ncol(onto), "\n")
