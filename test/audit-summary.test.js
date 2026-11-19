'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeBooks}=require('../public/audit-summary');
const episode=(no,n,scene=10,cast=5)=>({no,counts:{pure:n},parts:{scene,cast}});
const book=(id,episodes,extra={})=>({id,name:'剧本'+id,status:'done',res:{format:{ok:true},analysis:{lang:'zh',episodes,issues:[]}},...extra});

test('100本汇总同一口径，边界合格，少字超字空集均列出',()=>{
  const books=Array.from({length:100},(_,i)=>book(i,[episode(1,550),episode(2,1000),episode(3,549),episode(4,1001),episode(5,0)]));
  const summary=summarizeBooks(books);
  assert.equal(summary.totals.books,100);
  assert.equal(summary.totals.ready,100);
  assert.equal(summary.totals.needsWork,100);
  for(const item of summary.books){
    assert.equal(item.totalEpisodes,5);
    assert.equal(item.qualifiedEpisodes,2);
    assert.deepEqual(item.badEpisodes.map(e=>[e.no,e.n,e.kind]),[[3,549,'short'],[4,1001,'long'],[5,0,'empty']]);
  }
  assert.throws(()=>summarizeBooks([...books,book(101,[episode(1,600)])]),/100/);
});

test('修改后旧结果、排队、请求失败与格式未通过都不显示字数合格',()=>{
  const books=[book(1,[episode(1,600)],{dirty:true}),book(2,[episode(1,600)],{status:'running'}),book(3,[episode(1,600)],{status:'queued'}),book(4,[episode(1,600)],{status:'error',error:'解析失败'}),{id:5,name:'格式失败',status:'done',res:{format:{ok:false}}}];
  const s=summarizeBooks(books);
  assert.equal(s.totals.pending,3);
  assert.equal(s.totals.errors,1);
  assert.equal(s.totals.formatErrors,1);
  assert.equal(s.totals.qualified,0);
  for(const row of s.books){assert.equal(row.totalEpisodes,null);assert.equal(row.totalWords,null);assert.equal(row.passed,null);}
});

test('场次头人物行开关与区间同时作用，识别问题单列，单位保留',()=>{
  const a=book(1,[episode(1,540)]);
  a.res.analysis.lang='en';
  a.res.analysis.issues=[{type:'gap',text:'缺集：第2集'}];
  const s=summarizeBooks([a],{min:550,max:600,incScene:true,incCast:true});
  assert.equal(s.books[0].totalWords,555);
  assert.equal(s.books[0].badEpisodes.length,0);
  assert.equal(s.books[0].qualifiedEpisodes,1);
  assert.equal(s.books[0].passed,false);
  assert.equal(s.books[0].unit,'词');
  assert.deepEqual(s.books[0].issues,a.res.analysis.issues);
  assert.equal(summarizeBooks([book(2,[])]).books[0].status,'no_episodes');
});

test('导出入口使用的统计参数拒绝无效区间与损坏计数',()=>{
  for(const options of [{min:-1},{min:1001,max:1000},{max:NaN},{min:.5}])assert.throws(()=>summarizeBooks([],options),/区间/);
  const invalid=book(1,[episode(1,-5)]);
  assert.throws(()=>summarizeBooks([invalid]),/无效/);
});
