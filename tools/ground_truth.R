# Ground-truth generator: sources ringdater's ACTUAL functions (+ dplR) and
# emits JSON the JS test suite checks against. R is the oracle.
suppressMessages(library(dplR))
set.seed(1)
pkg <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(pkg, "comb_NA_function.R"))
source(file.path(pkg, "whiten_function.R"))

data(ca533)
s1 <- as.numeric(ca533[,1]); s1 <- s1[!is.na(s1)]
s2 <- as.numeric(ca533[,10]); s2 <- s2[!is.na(s2)]
s3 <- as.numeric(60 + 40*exp(-0.02*seq_len(200)) + rnorm(200, 0, 3))  # exp-decay like a tree

num <- function(v) paste0("[", paste(format(v, digits=17), collapse=","), "]")
esc <- function(s) gsub('"','\\\\"',s)
items <- list()
add <- function(name, fields) items[[length(items)+1]] <<- list(name=name, fields=fields)

# ---- AR(1) prewhitening (ringdater::whitenSeries) ----
for (nm in c("s1","s2","s3")) {
  y <- get(nm); w <- whitenSeries(y)
  add(paste0("whiten_",nm), list(fn='"whiten"', y=num(y), out=num(w)))
}

# ---- ModNegExp / ModHugershoff detrend curves (dplR via detrend.series) ----
for (meth in c("ModNegExp","ModHugershoff")) {
  for (nm in c("s1","s2","s3")) {
    y <- get(nm)
    d <- try(detrend.series(y, method=meth, make.plot=FALSE, return.info=TRUE), silent=TRUE)
    if (inherits(d,"try-error")) next
    add(paste0(meth,"_",nm),
        list(fn=paste0('"',meth,'"'), y=num(y),
             curve=num(as.numeric(d$curves)), series=num(as.numeric(d$series)),
             fitmethod=paste0('"', d$model.info[[1]]$method, '"')))
  }
}

con <- file("ground_truth2.json","w"); cat("{\n", file=con)
for (i in seq_along(items)) {
  it <- items[[i]]
  kv <- paste(sprintf('"%s":%s', names(it$fields), unlist(it$fields)), collapse=",")
  cat(sprintf('"%s":{%s}%s\n', it$name, kv, if(i<length(items))"," else ""), file=con)
}
cat("}\n", file=con); close(con)
cat("Wrote", length(items), "cases to ground_truth2.json\n")
