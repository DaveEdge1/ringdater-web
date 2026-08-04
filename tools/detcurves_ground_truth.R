# Ground truth for ringdater::detcurves — fitted detrending curves as a Frame.
# Sources the ACTUAL ringdater function (uses dplR::detrend.series) and runs it
# on a data.frame of year + ca533 series for methods 3,4,5,6 (spline/negexp/
# friedman/hugershoff). Methods 1,2,7 are identity and covered trivially.

suppressMessages(library(dplR))
pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "detcurves_function.R"))
outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/detcurves_gt.json"

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

frameJSON <- function(df) {
  cols <- lapply(seq_len(ncol(df)), function(j) jarr(df[, j]))
  paste0("{\"names\":[", paste(vapply(colnames(df), jstr, character(1)), collapse = ","), "],",
         "\"cols\":[", paste(unlist(cols), collapse = ","), "]}")
}

input <- frameJSON(the_data)

methods <- c(3, 4, 5, 6)
sw <- 21
cases <- lapply(methods, function(m) {
  res <- detcurves(series_data = the_data, detrending_select = m, splinewindow = sw)
  paste0("{\"method\":", m, ",\"splinewindow\":", sw, ",\"expected\":", frameJSON(res), "}")
})

writeLines(paste0("{\"input\":", input, ",\"cases\":[",
                  paste(unlist(cases), collapse = ","), "]}"), outfile)
cat("wrote", outfile, "\n")
