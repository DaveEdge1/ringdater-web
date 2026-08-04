suppressMessages(library(xml2)); suppressMessages(library(dplR))
src <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(src,"comb_NA_function.R")); source(file.path(src,"load_lps_function.R"))
base <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
fxdir <- file.path(base,"tools","lps_fixtures"); dir.create(fxdir, showWarnings=FALSE)

# --- serializers ---
num <- function(v) paste0("[", paste(sapply(v, function(z) if(is.na(z)) "null" else format(z,digits=17)), collapse=","), "]")
strs <- function(v) paste0("[", paste(sprintf('"%s"', v), collapse=","), "]")
jstr <- function(s){ # JSON-escape a raw text blob
  s <- gsub("\\\\","\\\\\\\\", s)
  s <- gsub('"','\\\\"', s)
  s <- gsub("\r","\\\\r", s)
  s <- gsub("\n","\\\\n", s)
  s <- gsub("\t","\\\\t", s)
  paste0('"', s, '"')
}
# build one <profile> block from a numeric vector of edge positions
profBlock <- function(vals){
  ds <- paste(sprintf('        <distance value="%s"/>', vals), collapse="\n")
  paste0(
"    <profile>\n",
"      <edges><edge><distances><channel>\n",
sprintf('        <manual count="%d">\n', length(vals)),
ds, "\n",
"        </manual>\n",
"      </edges></edge></distances></channel>\n",   # order irrelevant to R (navigates by tag)
"    </profile>")
}
# actually keep tag nesting correct:
profBlock <- function(vals){
  ds <- paste(sprintf('          <distance value="%s"/>', vals), collapse="\n")
  paste0(
"    <profile>\n",
"      <edges>\n        <edge>\n          <distances>\n            <channel>\n",
sprintf('              <manual count="%d">\n', length(vals)),
ds, "\n",
"              </manual>\n",
"            </channel>\n          </distances>\n        </edge>\n      </edges>\n",
"    </profile>")
}
makeLps <- function(lines){ # lines = list of numeric vectors
  body <- paste(sapply(lines, profBlock), collapse="\n")
  paste0(
'<?xml version="1.0" encoding="utf-8"?>\n',
"<lineprofileengine>\n",
sprintf('  <lines count="%d">\n', length(lines)),
body, "\n",
"  </lines>\n</lineprofileengine>\n")
}

# --- fixtures: {name, series, list-of-lines(numeric vectors)} ; every line >=2 measurements ---
fixtures <- list(
  list(name="single_line", series="TREEA", lines=list(c(10.5,30.0,20.25))),
  list(name="two_lines",   series="SAMP",  lines=list(c(10.5,30.0,20.25), c(5,15,40,25))),
  list(name="three_lines_varying", series="MIX",
       lines=list(c(1,2,3,4), c(10,25), c(3.333333333,1.111111111,2.222222222))),
  list(name="high_precision_unsorted", series="PREC",
       lines=list(c(3.14159265358979,2.71828182845905,1.41421356237310,9.86960440108936))),
  list(name="many_edges_with_dup", series="MANY",
       lines=list(c(0,5,7,7,12,20,20.5))),
  list(name="five_lines_mixed", series="STAND",
       lines=list(c(2,4,6), c(1,3), c(0.1,0.2,0.35,0.6,1.0),
                  c(100,90,80,70,60,50), c(5.5,5.75)))
)

out <- file.path(base,"test","lps_gt.json")
cat('{\n"cases":[\n', file=out)
first <- TRUE
for (fx in fixtures){
  lps <- makeLps(fx$lines)
  fpath <- file.path(fxdir, paste0(fx$name, ".lps"))
  cat(lps, file=fpath)
  df <- load_lps(fx$series, fpath)
  nm <- colnames(df)
  colsjson <- paste(sapply(seq_len(ncol(df)), function(j) num(df[[j]])), collapse=",")
  rec <- sprintf('{"name":"%s","series":"%s","lps":%s,"names":%s,"cols":[%s]}',
                 fx$name, fx$series, jstr(lps), strs(nm), colsjson)
  if (!first) cat(",\n", file=out, append=TRUE)
  cat(rec, file=out, append=TRUE)
  first <- FALSE
  cat("OK", fx$name, "->", paste(nm, collapse=","), "rows", nrow(df), "\n")
}
cat("\n]\n}\n", file=out, append=TRUE)
cat("wrote", out, "\n")
