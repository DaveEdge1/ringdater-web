# Ground truth for ringdater::rollcor — running Pearson correlation over an
# odd-width sliding window. Sources the ACTUAL ringdater function and runs it on
# random paired vectors (fixed seed). Emits inputs + per-width outputs as JSON.

pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "rollcor_function.R"))
outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/rollcor_gt.json"

jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) if (is.na(v)) "null" else format(v, digits = 17, scientific = FALSE, trim = TRUE),
         character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")

set.seed(42)
cases <- list()
mk <- function(name, n, width, related) {
  x <- rnorm(n)
  y <- if (related) 0.6 * x + rnorm(n, 0, 0.8) else rnorm(n)
  cc <- rollcor(x, y, width, show = FALSE)
  paste0("{", paste(c(
    paste0("\"name\":", jstr(name)),
    paste0("\"width\":", width),
    paste0("\"x\":", jarr(x)),
    paste0("\"y\":", jarr(y)),
    paste0("\"cc\":", jarr(unname(cc)))
  ), collapse = ","), "}")
}

cases[[1]] <- mk("n60_w7_related", 60, 7, TRUE)
cases[[2]] <- mk("n60_w15_related", 60, 15, TRUE)
cases[[3]] <- mk("n100_w21_indep", 100, 21, FALSE)
cases[[4]] <- mk("n40_w5_related", 40, 5, TRUE)
cases[[5]] <- mk("n80_w31_indep", 80, 31, FALSE)

writeLines(paste0("[", paste(unlist(cases), collapse = ","), "]"), outfile)
cat("wrote", outfile, "\n")
