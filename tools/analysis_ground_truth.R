#!/usr/bin/env Rscript
# Ground truth for the small analysis-layer JS ports:
#   filter_crossdates, correl_replace, remove_series, RingdateR_error_message
# Sources the ACTUAL ringdater functions and emits test/analysis_gt.json with a
# hand-rolled serializer (numbers via format(x, digits=17), NA/NaN -> null).

suppressMessages(library(dplR))

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "lead_lag_analysis_function.R"))
source(file.path(pkg, "filter_crossdates_function.R"))
source(file.path(pkg, "correl_replace_function.R"))
source(file.path(pkg, "remove_series_function.R"))
# RingdateR_error_message uses ggplot only on the plot.err=TRUE branch; we only
# exercise plot.err=FALSE (returns a string) so define a ggplot stub to source.
ggplot <- function(...) NULL; geom_text <- function(...) NULL; theme <- function(...) NULL
aes <- function(...) NULL; element_blank <- function(...) NULL
`+.NULL` <- function(e1, e2) NULL
source(file.path(pkg, "RingdateR_error_message_function.R"))

here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out  <- file.path(here, "test", "analysis_gt.json")

# ---------- JSON helpers ----------
num <- function(x) {
  if (length(x) != 1) stop("num scalar")
  if (is.na(x)) return("null")
  trimws(format(x, digits = 17, scientific = FALSE))
}
jstr  <- function(s) paste0('"', gsub('"', '\\\\"', gsub('\\\\', '\\\\\\\\', s)), '"')
jnums <- function(v) paste0("[", paste(vapply(v, num, ""), collapse = ","), "]")
jstrs <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")
# a data.frame column -> JSON array, character cols quoted, numeric via num()
jcol <- function(col) {
  if (is.character(col)) return(jstrs(col))
  jnums(as.numeric(col))
}
# whole data.frame -> object { name: [values] } preserving column order
jframe <- function(df) {
  parts <- vapply(seq_len(ncol(df)), function(j)
    paste0(jstr(colnames(df)[j]), ":", jcol(df[[j]])), "")
  paste0("{", paste(parts, collapse = ","), "}")
}
jnamevec <- function(df) jstrs(colnames(df))

# =====================================================================
# 1. filter_crossdates
# =====================================================================
set.seed(42)
yr    <- 1:50
base  <- sin(yr / 3) + cos(yr / 7)
chrono <- base + rnorm(50, 0, 0.2)
s1 <- base + rnorm(50, 0, 0.3)                     # crossdates at lag 0
s2 <- c(base[3:50], NA, NA) + rnorm(50, 0, 0.3)     # shifted
s3 <- rnorm(50, 0, 1)                              # noise, poor crossdate
ll_in <- data.frame(year = yr, chrono = chrono, s1 = s1, s2 = s2, s3 = s3)

ll <- lead_lag_analysis(the_data = ll_in, mode = 2, neg_lag = -10, pos_lag = 10,
                        complete = FALSE)
cross_dat_res <- ll[[1]]

fc_params <- list(r_val = 0.3, p_val = 0.5, overlap = 10, target = "chrono")
filtered <- filter_crossdates(the_data = cross_dat_res,
                              r_val = fc_params$r_val, p_val = fc_params$p_val,
                              overlap = fc_params$overlap, target = fc_params$target)

fc_json <- paste0("{",
  '"names":', jnamevec(cross_dat_res), ',',
  '"input":', jframe(cross_dat_res), ',',
  '"params":{"r_val":', num(fc_params$r_val), ',"p_val":', num(fc_params$p_val),
      ',"overlap":', num(fc_params$overlap), ',"target":', jstr(fc_params$target), '},',
  '"filtered":', jframe(filtered),
  "}")

# =====================================================================
# 2. correl_replace
# =====================================================================
set.seed(7)
yr2 <- 1:40
b2  <- sin(yr2 / 4) + cos(yr2 / 9)
cr_in <- data.frame(
  year = yr2,
  a = b2 + rnorm(40, 0, 0.2),
  b = b2 + rnorm(40, 0, 0.25),
  c = b2 + rnorm(40, 0, 0.3),
  d = rnorm(40, 0, 1)
)
# introduce some NA gaps
cr_in$a[1:3]   <- NA
cr_in$b[38:40] <- NA
cr_in$c[20]    <- NA
cr_res <- correl_replace(cr_in)

cr_json <- paste0("{",
  '"input":', jframe(cr_in), ',',
  '"names":', jnamevec(cr_res), ',',
  '"result":', jframe(cr_res),
  "}")

# =====================================================================
# 3. remove_series
# =====================================================================
rs_in <- data.frame(year = 1:6, aa = 1:6, bb = 7:12, cc = 13:18, dd = 19:24)
rs_ids <- c("bb", "dd", "zz")   # zz absent -> skipped
rs_res <- remove_series(rs_in, rs_ids)

rs_json <- paste0("{",
  '"input":', jframe(rs_in), ',',
  '"ids":', jstrs(rs_ids), ',',
  '"result_names":', jnamevec(rs_res), ',',
  '"result":', jframe(rs_res),
  "}")

# =====================================================================
# 4. RingdateR_error_message  (plot.err = FALSE -> returns string)
# =====================================================================
em_msgs <- c("Can't display plot", "There has been an error",
             "No data loaded", "Please select 2 series")
em_default <- RingdateR_error_message()               # plot.err TRUE default -> NULL stub
em_default_txt <- RingdateR_error_message(plot.err = FALSE)  # default message string
em_out <- vapply(em_msgs, function(m)
  RingdateR_error_message(message = m, plot.err = FALSE), "")

em_json <- paste0("{",
  '"default":', jstr(em_default_txt), ',',
  '"messages":', jstrs(em_msgs), ',',
  '"returned":', jstrs(unname(em_out)),
  "}")

# =====================================================================
json <- paste0("{\n",
  '"filter_crossdates":', fc_json, ',\n',
  '"correl_replace":', cr_json, ',\n',
  '"remove_series":', rs_json, ',\n',
  '"error_message":', em_json, "\n}\n")

writeLines(json, out)
cat("wrote", out, "\n")
cat("filter_crossdates: input rows", nrow(cross_dat_res), "filtered rows", nrow(filtered), "\n")
cat("correl_replace: rows", nrow(cr_res), "\n")
cat("remove_series: cols", ncol(rs_res), "->", paste(colnames(rs_res), collapse=","), "\n")
