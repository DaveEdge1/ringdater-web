suppressMessages(library(dplR)); set.seed(3)
src <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(src,"comb_NA_function.R"))
num <- function(v) paste0("[", paste(sapply(v, function(z) if(is.na(z)) "null" else format(z,digits=17)), collapse=","), "]")
mat <- function(m){ m<-as.data.frame(m); paste0("[", paste(sapply(seq_len(ncol(m)), function(j) num(m[[j]])), collapse=","), "]") }
# comb.NA cases
a <- data.frame(x=1:10, y=2:11); b <- data.frame(c=5:10, d=6:11)
v <- c(100,200,300)
c1 <- comb.NA(a,b); c2 <- comb.NA(a, v); c3 <- comb.NA(v, b, c(7,7))
cat('{\n', file="/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/foundation_gt.json")
cat(sprintf('"combNA_ab":%s,\n', mat(c1)), file="/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/foundation_gt.json", append=TRUE)
cat(sprintf('"combNA_av":%s,\n', mat(c2)), file="/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/foundation_gt.json", append=TRUE)
cat(sprintf('"combNA_vbc":%s,\n', mat(c3)), file="/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/foundation_gt.json", append=TRUE)
# cor.test cases
ct <- list()
for (i in 1:6){
  n <- sample(8:40,1); x <- rnorm(n); y <- 0.5*x + rnorm(n)
  r <- cor.test(x,y)
  ct[[i]] <- sprintf('{"x":%s,"y":%s,"r":%s,"t":%s,"df":%s,"p":%s}',
                     num(x),num(y),format(r$estimate,digits=17),format(r$statistic,digits=17),
                     r$parameter, format(r$p.value,digits=17))
}
cat(sprintf('"cortest":[%s]\n}\n', paste(unlist(ct),collapse=",")), file="/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/foundation_gt.json", append=TRUE)
cat("wrote ground truth\n")
