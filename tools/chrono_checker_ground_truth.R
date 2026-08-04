#!/usr/bin/env Rscript
# ============================================================================
# Ground truth for the Quick Chronology Checker workflow (src/engine/chronoChecker.js).
# Replicates the EXACT computation of the server logic in R/chrono_checker_app.R
# (observeEvent(input$analyze)) using the real ringdater functions + dplR::chron,
# on a CSV chronology, for a chosen sample + a couple of lags, and emits the
# plotted DATA (detrended sample, chronology mean, combined, master lead-lag,
# heatmap year/lag/R, line-plot series, lead-lag bar T-values) as JSON
# (format(digits = 17); NA -> null) for test/chrono_checker_test.js to diff.
# ============================================================================

suppressMessages({ library(dplR); library(zoo) })

RPKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
EXT  <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata"
HERE <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
OUT  <- file.path(HERE, "test", "chrono_checker_gt.json")

for (f in c("comb_NA_function.R", "normalise_function.R", "rollcor_function.R",
            "lead_lag_analysis_function.R", "running_lead_lag_function.R")) {
  source(file.path(RPKG, f))
}

CSV      <- file.path(EXT, "undated_example.csv")
SELECTED <- "Sample_C"
SPLINE   <- 21
LAGS     <- c(0L, 4L, -6L)

df <- read.csv(CSV, header = TRUE)

# ---- exact port of the server observeEvent(input$analyze) computation --------
run_case <- function(df, selected_column_name, lag, spline_length) {
  selected_column_index <- which(colnames(df) == selected_column_name)

  sel_sample <- df[, c(1, selected_column_index)]
  sel_sample[, 1] <- sel_sample[, 1] + lag
  sel_sample <- normalise(sel_sample, detrending_select = 3, splinewindow = as.numeric(spline_length))

  raw_chron_data <- df[, -selected_column_index]
  det_chron_data <- normalise(raw_chron_data, detrending_select = 3, splinewindow = as.numeric(spline_length))
  row.names(det_chron_data) <- df[, 1]

  chrono <- chron(det_chron_data[, -1])
  chrono_std   <- chrono[, 1]
  chrono_depth <- chrono[, "samp.depth"]
  chrono <- data.frame(years = as.numeric(row.names(chrono)), sgi = chrono[, 1])

  combined <- cbind(chrono, sel_sample[, 2])
  colnames(combined) <- c("year", "mean_chronology", selected_column_name)

  # lead-lag analysis (mode 1, complete = TRUE) -> master (element 2)
  cor_res <- lead_lag_analysis(the_data = combined, mode = 1,
                               neg_lag = (-20 + lag), pos_lag = (20 + lag), complete = TRUE)
  master <- as.data.frame(cor_res[2])

  # running lead-lag data behind the heatmap (heatmap_analysis' plot.data)
  heat <- running_lead_lag(the_data = combined, s1 = "mean_chronology", s2 = selected_column_name,
                           neg_lag = (-10 + lag), pos_lag = (10 + lag), win = 21, complete = FALSE)

  # line_plot internal data: complete-cases series, series_2 shifted by lag
  s1 <- data.frame(x = combined[, 1], y = combined[["mean_chronology"]])
  s2 <- data.frame(x = combined[, 1], y = combined[[selected_column_name]])
  s1 <- subset(s1, complete.cases(s1))
  s2 <- subset(s2, complete.cases(s2)); s2$x <- s2$x + lag
  line <- list(s1_x = s1$x, s1_y = s1$y, s2_x = s2$x, s2_y = s2$y)

  # lead_lag_bar internal data (subset R_Val>0, order by P_Val, best/2nd/3rd)
  pre <- paste0("ser_1_mean_chronology_ser_2_", selected_column_name, "_")
  bl <- data.frame(lag = master[[paste0(pre, "lag")]], R_Val = master[[paste0(pre, "R_Val")]],
                   P_Val = master[[paste0(pre, "P_Val")]], T_val = master[[paste0(pre, "T_val")]])
  bl <- subset(bl, R_Val > 0)
  ordered <- bl[order(bl$P_Val), ]
  bar <- list(lag = bl$lag, T_val = bl$T_val,
              best_lag = ordered$lag[1], second_lag = ordered$lag[2], third_lag = ordered$lag[3])

  list(lag = lag, detrended_sample = sel_sample[, 2], chrono_depth = chrono_depth,
       combined = combined, master = master, heat = heat, line = line, bar = bar)
}

# summary table (server: summary_df Start_Year / End_Year per sample)
summary_tab <- data.frame(
  Column_Name = colnames(df)[-1],
  Start_Year  = sapply(df[-1], function(x) min(df[[1]][!is.na(x)], na.rm = TRUE)),
  End_Year    = sapply(df[-1], function(x) max(df[[1]][!is.na(x)], na.rm = TRUE))
)

cases <- lapply(LAGS, function(L) run_case(df, SELECTED, L, SPLINE))

# ---- JSON helpers (format(digits = 17), NA -> null) --------------------------
num <- function(x) { if (is.na(x)) return("null"); trimws(format(x, digits = 17, scientific = FALSE)) }
jstr <- function(s) paste0('"', gsub('"', '\\\\"', s), '"')
jvec_num <- function(v) paste0("[", paste(vapply(v, function(x) num(as.numeric(x)), ""), collapse = ","), "]")
jvec_str <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")
jcell <- function(x, is_char) { if (length(x) == 0 || is.na(x)) return("null"); if (is_char) jstr(as.character(x)) else num(as.numeric(x)) }
df_to_json <- function(df) {
  df <- as.data.frame(df); nm <- colnames(df); nc <- ncol(df)
  colparts <- character(nc)
  for (j in seq_len(nc)) {
    column <- df[[j]]; is_char <- is.character(column) || is.factor(column)
    if (is.factor(column)) column <- as.character(column)
    cells <- vapply(seq_along(column), function(i) jcell(column[i], is_char), "")
    colparts[j] <- paste0("[", paste(cells, collapse = ","), "]")
  }
  paste0('{"names":[', paste(vapply(nm, jstr, ""), collapse = ","),
         '],"cols":[', paste(colparts, collapse = ","), "]}")
}
heat_to_json <- function(h) { if (is.null(h)) return("null"); df_to_json(h) }
bar_to_json <- function(b) paste0(
  '{"lag":', jvec_num(b$lag), ',"T_val":', jvec_num(b$T_val),
  ',"best_lag":', num(as.numeric(b$best_lag)),
  ',"second_lag":', num(as.numeric(b$second_lag)),
  ',"third_lag":', num(as.numeric(b$third_lag)), '}')
line_to_json <- function(l) paste0(
  '{"s1_x":', jvec_num(l$s1_x), ',"s1_y":', jvec_num(l$s1_y),
  ',"s2_x":', jvec_num(l$s2_x), ',"s2_y":', jvec_num(l$s2_y), '}')
case_to_json <- function(c) paste0(
  '{"lag":', c$lag,
  ',"detrended_sample":', jvec_num(c$detrended_sample),
  ',"chrono_depth":', jvec_num(c$chrono_depth),
  ',"combined":', df_to_json(c$combined),
  ',"master":', df_to_json(c$master),
  ',"heat":', heat_to_json(c$heat),
  ',"line":', line_to_json(c$line),
  ',"bar":', bar_to_json(c$bar), '}')

json <- paste0('{\n"selected":', jstr(SELECTED),
               ',\n"summary":', df_to_json(summary_tab),
               ',\n"cases":[', paste(vapply(cases, case_to_json, ""), collapse = ","), ']\n}\n')

writeLines(json, OUT)
cat("wrote", OUT, "\n")
for (c in cases) cat(" lag", c$lag, " combined", nrow(c$combined), "x", ncol(c$combined),
                     " master", nrow(c$master), "x", ncol(c$master),
                     " heat", if (is.null(c$heat)) "NULL" else nrow(c$heat),
                     " bar", length(c$bar$lag), "\n")
