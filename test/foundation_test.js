'use strict';
const fs=require('fs'), path=require('path');
const C=require('../src/analysis/comb.js');
const {pearsonCorTest}=require('../src/stats/cortest.js');
const gt=JSON.parse(fs.readFileSync(path.join(__dirname,'foundation_gt.json'),'utf8'));
function m2(f){return f.cols.map(c=>c.map(v=>C.isNA(v)?null:v));}
function eqMat(a,b){if(a.length!==b.length)return 1e9;let m=0;for(let j=0;j<a.length;j++){if(a[j].length!==b[j].length)return 1e9;for(let i=0;i<a[j].length;i++){const x=a[j][i],y=b[j][i];if((x==null)!==(y==null))return 1e9;if(x!=null)m=Math.max(m,Math.abs(x-y));}}return m;}
let ok=true;
const a={names:['x','y'],cols:[[1,2,3,4,5,6,7,8,9,10],[2,3,4,5,6,7,8,9,10,11]]};
const b={names:['c','d'],cols:[[5,6,7,8,9,10],[6,7,8,9,10,11]]};
for(const [name,got,exp] of [['combNA_ab',C.combNA(a,b),gt.combNA_ab],['combNA_av',C.combNA(a,[100,200,300]),gt.combNA_av],['combNA_vbc',C.combNA([100,200,300],b,[7,7]),gt.combNA_vbc]]){
  const d=eqMat(m2(got),exp); if(d>1e-12)ok=false; console.log(name.padEnd(14),'maxdiff',d,d<1e-12?'PASS':'FAIL');
}
let mr=0,mt=0,mp=0;
for(const c of gt.cortest){const o=pearsonCorTest(c.x,c.y);mr=Math.max(mr,Math.abs(o.r-c.r));mt=Math.max(mt,Math.abs(o.t-c.t));mp=Math.max(mp,Math.abs(o.p-c.p));}
const cok=mr<1e-12&&mt<1e-11&&mp<1e-10; if(!cok)ok=false;
console.log('cortest'.padEnd(14),'dr',mr.toExponential(2),'dt',mt.toExponential(2),'dp',mp.toExponential(2),cok?'PASS':'FAIL');
console.log(ok?'\nFOUNDATION PASS':'\nFOUNDATION FAIL'); process.exit(ok?0:1);
