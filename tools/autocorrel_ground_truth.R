# Ground truth for ringdater::auto_correl — lag 0..10 autocorrelation per series.
# Sources the ACTUAL ringdater function (+ comb.NA/vertLen) and runs it on a
# data.frame built from ca533 (year column + several series with real NA gaps).

suppressMessages(library(dplR))
pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "auto_correl_function.R"))
outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/autocorrel_gt.json"

jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) if (is.na(v)) "null" else format(v, digits = 17, scientific = FALSE, trim = TRUE),
         character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")

data(ca533)
sel <- ca533[, 1:6]
years <- as.numeric(rownames(sel))
the_data <- data.frame(year = years, sel, check.names = FALSE)

res <- auto_correl(the_data)   # data.frame: lag, then one col per series

# input dump (year col + series), for the JS side to rebuild the identical Frame
in_cols <- lapply(seq_len(ncol(the_data)), function(j) jarr(the_data[, j]))
input <- paste0("{",
  "\"names\":[", paste(vapply(colnames(the_data), jstr, character(1)), collapse = ","), "],",
  "\"cols\":[", paste(unlist(in_cols), collapse = ","), "]}")

out_cols <- lapply(seq_len(ncol(res)), function(j) jarr(res[, j]))
expected <- paste0("{",
  "\"names\":[", paste(vapply(colnames(res), jstr, character(1)), collapse = ","), "],",
  "\"cols\":[", paste(unlist(out_cols), collapse = ","), "]}")

writeLines(paste0("{\"input\":", input, ",\"expected\":", expected, "}"), outfile)
cat("wrote", outfile, "\n")
