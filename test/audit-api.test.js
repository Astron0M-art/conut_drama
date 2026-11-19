'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const zip=require('../lib/format/zip');
let child,base,cookie;
before(async()=>{
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',AUTH:'audit:api-test',SESSION_SECRET:'audit-api-secret'},stdio:['ignore','pipe','inherit']});
  base=await new Promise((resolve,reject)=>{
    let out='';const timer=setTimeout(()=>reject(Error('审核测试服务启动超时')),8000);
    child.stdout.on('data',chunk=>{out+=chunk;const m=/http:\/\/127\.0\.0\.1:(\d+)/.exec(out);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});
    child.on('exit',()=>{clearTimeout(timer);reject(Error('审核测试服务提前退出'));});
  });
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'audit',password:'api-test'})});
  assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
});
after(()=>child?.kill());
const payload=()=>({books:Array.from({length:100},(_,i)=>({id:i,name:i===0?'=公式&安全<剧本>':'剧本'+i,status:'done',format:{ok:true},analysis:{lang:'zh',episodes:[{no:1,counts:{pure:i===0?1001:600},parts:{scene:20,cast:10}}],issues:[]}})),options:{min:550,max:1000,incScene:false,incCast:false}});
const post=body=>fetch(base+'/api/audit/export',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('审核Excel导出需登录，拒绝101本与损坏数据',async()=>{
  assert.equal((await fetch(base+'/api/audit/export',{method:'POST',body:'{}'})).status,401);
  const p=payload();p.books.push({...p.books[0],id:101});assert.equal((await post(p)).status,400);
  assert.equal((await post({books:[]})).status,400);
  const bad=payload();bad.books[0].analysis.episodes[0].counts.pure=-1;assert.equal((await post(bad)).status,400);
});

test('100本一键导出为真实xlsx，合格异常与未完成都在工作簿中',async()=>{
  const p=payload();
  p.books[98]={id:98,name:'待统计的剧本',status:'queued'};
  p.books[99]={id:99,name:'格式需调整的剧本',status:'done',format:{ok:false,errors:3}};
  const response=await post(p);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/spreadsheetml\.sheet/);
  assert.match(response.headers.get('content-disposition'),/\.xlsx/);
  const files=zip.readAll(Buffer.from(await response.arrayBuffer()));
  assert.ok(files.has('xl/workbook.xml'));
  const sheet=files.get('xl/worksheets/sheet1.xml').toString();
  for(const name of ['剧本名称','剧本总集数','超标集','超标集字数','待统计的剧本','格式需调整的剧本'])assert.ok(sheet.includes(name));
  for(let i=1;i<98;i++)assert.ok(sheet.includes('剧本'+i+'<'));
  assert.match(sheet,/1001/);
  assert.ok(sheet.includes('公式&amp;安全&lt;剧本&gt;'));
  assert.doesNotMatch(sheet,/<f[ >]/);
  assert.match(sheet,/排队中/);
  assert.match(sheet,/格式未通过/);
  const note=files.get('xl/worksheets/sheet2.xml').toString();
  assert.ok(note.includes('550'));assert.ok(note.includes('1000'));
});
