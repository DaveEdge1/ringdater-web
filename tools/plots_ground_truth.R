#!/usr/bin/env Rscript
# Ground truth for the six RingdateR plot builders (Phase 4 viz). ggplot objects
# cannot be serialized, so for each plot we capture the underlying DATA that R
# would plot, sourcing the ACTUAL ringdater functions wherever they return data
# (dated_line_plot, normalise, detcurves, auto_correl, running_lead_lag,
# lead_lag_analysis) and transcribing the few trivial ggplot-prep lines
# (line_plot, plot_all_series, lead_lag_bar) verbatim from their source bodies.
#
# Numbers via format(digits = 17); NA -> null; hand-written serializer.

suppressMessages(library(dplR))
suppressMessages(library(zoo))

pkg  <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out  <- file.path(here, "test", "plots_gt.json")

source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "whiten_function.R"))
source(file.path(pkg, "normalise_function.R"))
source(file.path(pkg, "detcurves_function.R"))
source(file.path(pkg, "auto_correl_function.R"))
source(file.path(pkg, "rollcor_function.R"))
source(file.path(pkg, "running_lead_lag_function.R"))
source(file.path(pkg, "dated_line_plot_function.R"))
source(file.path(pkg, "lead_lag_analysis_function.R"))

# ---- JSON helpers -----------------------------------------------------------
num <- function(x) {
  if (length(x) == 0 || is.na(x)) return("null")
  trimws(format(x, digits = 17, scientific = FALSE))
}
jstr  <- function(s) paste0('"', gsub('"', '\\\\"', s), '"')
jcell <- function(x, is_char) {
  if (length(x) == 0 || is.na(x)) return("null")
  if (is_char) jstr(as.character(x)) else num(as.numeric(x))
}
jarr <- function(x, is_char = FALSE)
  paste0("[", paste(vapply(seq_along(x), function(i) jcell(x[i], is_char), ""), collapse = ","), "]")
df_to_json <- function(df) {
  if (is.null(df) || nrow(df) == 0) return("null")
  nm <- colnames(df); nc <- ncol(df)
  colparts <- vapply(seq_len(nc), function(j) jarr(df[[j]], is.character(df[[j]])), "")
  paste0('{"names":[', paste(vapply(nm, jstr, ""), collapse = ","),
         '],"cols":[', paste(colparts, collapse = ","), "]}")
}
xy <- function(x, y) paste0('{"x":', jarr(x), ',"y":', jarr(y), "}")

# ---- synthetic standardized (z-scored) multi-series frame -------------------
set.seed(11)
N   <- 140
sig <- as.numeric(rnorm(N))
zscore <- function(v) (v - mean(v)) / sd(v)
mk <- function(a, b, row0, sd) {
  n <- b - a + 1; val <- sig[a:b] + rnorm(n, sd = sd)
  col <- rep(NA_real_, N); col[row0:(row0 + n - 1)] <- zscore(val); col
}
years <- as.numeric(1:N)
A <- mk(1, 90, 1, 0.30); B <- mk(15, 110, 15, 0.30)
Cc <- mk(30, 120, 35, 0.25); D <- mk(45, 135, 45, 0.20)
std <- data.frame(year = years, A = A, B = B, C = Cc, D = D, stringsAsFactors = FALSE)

# ===== line_plot (lines 45-51) ===============================================
line_case <- function(the_data, s1, s2, lag) {
  series_1 <- data.frame(the_data[, 1], the_data[[s1]])
  series_2 <- data.frame(the_data[, 1], the_data[[s2]])
  series_1 <- subset(series_1, complete.cases(series_1))
  series_2 <- subset(series_2, complete.cases(series_2))
  series_2[, 1] <- series_2[, 1] + lag
  paste0('{"input":', df_to_json(the_data), ',"s1":', jstr(s1), ',"s2":', jstr(s2),
         ',"lag":', lag, ',"series_1":', xy(series_1[, 1], series_1[, 2]),
         ',"series_2":', xy(series_2[, 1], series_2[, 2]), "}")
}
line_json <- line_case(std, "A", "B", -7)

# ===== dated_line_plot (real function returns res) ===========================
# staggered coverage frame
dat <- data.frame(Year = years,
                  S1 = mk(1, 60, 1, 0.3), S2 = mk(40, 130, 40, 0.3),
                  S3 = mk(20, 100, 25, 0.3), S4 = mk(70, 140, 70, 0.3),
                  stringsAsFactors = FALSE)
res <- dated_line_plot(dat)
dated_json <- paste0('{"input":', df_to_json(dat), ',"res":', df_to_json(res), "}")

# ===== plot_all_series (lines 27, 35-52) =====================================
allseries_case <- function(aligned) {
  new_chron_mean <- rowMeans(aligned[, -1], na.rm = TRUE)
  chron_dat <- data.frame(aligned[, 1], new_chron_mean)
  chron_dat <- subset(chron_dat, complete.cases(chron_dat))  # geom_line na.rm
  sers <- list()
  for (b in 2:ncol(aligned)) {
    tmp <- data.frame(aligned[, 1], aligned[, b])
    tmp <- subset(tmp, !is.na(tmp[, 1]) & !is.na(tmp[, 2]))
    sers[[length(sers) + 1]] <- xy(tmp[, 1], tmp[, 2])
  }
  paste0('{"input":', df_to_json(aligned), ',"mean":', xy(chron_dat[, 1], chron_dat[, 2]),
         ',"series":[', paste(unlist(sers), collapse = ","), "]}")
}
allseries_json <- allseries_case(std)

# ===== running_lead_lag (plot.data for the heatmap) ==========================
heat_case <- function(the_data, s1, s2, neg, pos, win, complete) {
  pd <- running_lead_lag(the_data = the_data, s1 = s1, s2 = s2,
                         neg_lag = neg, pos_lag = pos, win = win, complete = complete)
  paste0('{"input":', df_to_json(the_data), ',"s1":', jstr(s1), ',"s2":', jstr(s2),
         ',"neg":', neg, ',"pos":', pos, ',"win":', win,
         ',"complete":', tolower(as.character(complete)),
         ',"plotdata":', df_to_json(pd), "}")
}
heat_json <- heat_case(std, "A", "B", -20, 20, 21, FALSE)

# ===== detrending.plot.fun (real normalise/detcurves/auto_correl) ============
data(ca533)
cyears <- as.numeric(rownames(ca533))
raw <- data.frame(year = cyears, CAM011 = ca533[["CAM011"]], stringsAsFactors = FALSE)
detrend_case <- function(undet_raw, series, method, sw) {
  un.det.years <- undet_raw[, 1]
  ud <- undet_raw[[series]]
  ud <- comb.NA(un.det.years, ud, fill = NA)
  ud <- subset(ud, complete.cases(ud))
  det_nd <- normalise(ud, detrending_select = method, splinewindow = sw)
  curve  <- detcurves(series_data = ud, detrending_select = method, splinewindow = sw)
  raw_auto <- auto_correl(ud)
  det_aut  <- auto_correl(det_nd)
  paste0('{"input":', df_to_json(undet_raw), ',"series":', jstr(series),
         ',"method":', method, ',"sw":', sw,
         ',"curve":', df_to_json(curve), ',"detrended":', df_to_json(det_nd),
         ',"rawAuto":', df_to_json(raw_auto), ',"detAuto":', df_to_json(det_aut), "}")
}
detrend_parts <- c(detrend_case(raw, "CAM011", 3, 21),
                   detrend_case(raw, "CAM011", 5, 21))
detrend_json <- paste0("[", paste(detrend_parts, collapse = ","), "]")

# ===== lead_lag_bar (real lead_lag_analysis for master; lines 65-81) =========
# genuine master_lead_lag from a chronology-mode analysis on the std frame
ll <- lead_lag_analysis(the_data = std, mode = 2, complete = FALSE)
master <- ll[[2]]
s1 <- "A"; s2 <- "C"
mn <- paste0("ser_1_", s1, "_ser_2_", s2, "_",
             c("lag", "R_Val", "P_Val", "T_val", "Overlap", "First_ring", "Last_ring"))
lag <- master[[mn[1]]]; R_Val <- master[[mn[2]]]; P_Val <- master[[mn[3]]]
T_val <- master[[mn[4]]]; Overlap <- master[[mn[5]]]
First_ring <- master[[mn[6]]]; Last_ring <- master[[mn[7]]]
selected <- data.frame(lag, R_Val, P_Val, T_val, Overlap, First_ring, Last_ring)
selected <- subset(selected, (selected[, 2] > 0))
ordered  <- selected[order(selected[, 3]), ]
best <- ordered[1, ]; second <- ordered[2, ]; third <- ordered[3, ]
bar_json <- paste0('{"master":', df_to_json(master), ',"s1":', jstr(s1), ',"s2":', jstr(s2),
                   ',"lag":', jarr(selected[, 1]), ',"T_val":', jarr(selected[, 4]),
                   ',"best_lag":', num(best[1, 1]), ',"second_lag":', num(second[1, 1]),
                   ',"third_lag":', num(third[1, 1]), "}")

json <- paste0("{\n",
  '"line":',    line_json,      ",\n",
  '"dated":',   dated_json,     ",\n",
  '"allseries":', allseries_json, ",\n",
  '"heat":',    heat_json,      ",\n",
  '"detrend":', detrend_json,   ",\n",
  '"bar":',     bar_json,       "\n}\n")
writeLines(json, out)
cat("wrote", out, "\n")
