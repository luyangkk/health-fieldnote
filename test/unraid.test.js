import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import * as XLSX from 'xlsx'
import {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader} from '@zip.js/zip.js'

async function freePort(){
 const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening')
 const {port}=s.address();await new Promise(r=>s.close(r));return port
}
test('Unraid runtime rejects spoofed identity and persists/reliably restores a SQLite snapshot',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fieldnote-unraid-'))
 const password='synthetic-test-token-1234567890123456789'
 const path=join(dir,'health.sqlite'), snap=join(dir,'snapshot.sqlite'), restore=join(dir,'restore.sqlite'), secret=join(dir,'password')
 writeFileSync(secret,password,{mode:0o600})
 const port=await freePort(), origin='http://127.0.0.1:'+port
 const env={...process.env,PORT:String(port),FIELDNOTE_ORIGIN:origin,FIELDNOTE_BIND:'127.0.0.1',FIELDNOTE_DB:path,FIELDNOTE_PASSWORD_FILE:secret}
 const authorization='Basic '+Buffer.from('fieldnote:'+password).toString('base64')
 let child
 const start=async(db=path)=>{
  child=spawn(process.execPath,['selfhost/server.js'],{env:{...env,FIELDNOTE_DB:db},stdio:'pipe'})
  let stderr='';child.stderr.on('data',x=>stderr+=x)
  for(let i=0;i<60;i++){
   if(child.exitCode!=null)throw Error('server exited: '+stderr)
   try {if((await fetch(origin+'/healthz')).ok)return}catch{}
   await delay(50)
  }
  throw Error('server did not start: '+stderr)
 }
 const stop=async()=>{if(child&&child.exitCode==null){const closed=once(child,'exit');child.kill('SIGTERM');await closed}}
 const url=origin+'/api/health-log'
 const get=()=>fetch(url,{headers:{authorization}})
 const put=(revision,data,from=origin)=>fetch(url,{method:'PUT',headers:{authorization,origin:from,'x-fieldnote':'1','content-type':'application/json'},body:JSON.stringify({revision,data})})
 try {
  await start()
  assert.equal((await fetch(origin)).status,401)
  assert.match(await (await fetch(origin,{headers:{authorization}})).text(),/体能手记/)
  assert.equal((await fetch(url,{headers:{'oai-authenticated-user-id':'unraid-owner'}})).status,401)
  assert.equal((await put(0,{version:1},'http://other.example')).status,403)
  const meals=[{id:'demo',date:'2030-02-03',name:'fixture',type:'早餐',kcal:321}]
  assert.equal((await put(0,{version:1,meals})).status,200)
  assert.equal((await put(0,{version:1})).status,409)
  execFileSync(process.execPath,['selfhost/backup.js',snap],{env})
  assert.equal((await put(1,{version:1,meals:[]})).status,200)
  await stop();await start()
  assert.equal((await (await get()).json()).revision,2)
  await stop();copyFileSync(snap,restore);await start(restore)
  assert.equal((await (await get()).json()).data.meals[0].kcal,321)
  const importURL=origin+'/api/import/nothing'
  const incoming={workouts:[{'发起时间':'2030-02-03 08:14:00','运动类型':'力量训练','运动时长(分钟)':42,'活动卡路里(千卡)':142}]}
  const post=headers=>fetch(importURL,{method:'POST',headers:{'x-fieldnote':'1','content-type':'application/json',...headers},body:JSON.stringify(incoming)})
  assert.equal((await post({'oai-authenticated-user-id':'unraid-owner'})).status,401)
  assert.equal((await post({authorization,origin:'https://other.example'})).status,403)
  const imported=await post({authorization})
  assert.equal(imported.status,200)
  assert.equal((await imported.json()).added,1)
  assert.equal((await (await post({authorization})).json()).added,0)
  const afterImport=await (await get()).json()
  assert.equal(afterImport.revision,2)
  assert.equal(afterImport.data.meals[0].kcal,321)
  assert.equal(afterImport.data.workouts[0].source,'CMF')
  assert.equal((await put(1,{version:1})).status,409)
  const workbook=XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{'时间':'2030-02-03 23:59:55','步数(步)':8000,'总卡路里(千卡)':2100,'活动卡路里(千卡)':450,'运动时长(分钟)':42}]),'今日活动')
  const bytes=new Uint8Array(XLSX.write(workbook,{type:'array',bookType:'xlsx'}))
  const zipped=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false})
  await zipped.add('健康数据今日活动_203002.xlsx',new Uint8ArrayReader(bytes),{password:'test-password',useWebWorkers:false,level:0})
  const form=new FormData()
  form.set('file',new File([await zipped.close()],'nothing.zip'));form.set('password','test-password')
  const uploaded=await fetch(importURL,{method:'POST',headers:{authorization,'x-fieldnote':'1'},body:form})
  assert.equal(uploaded.status,200)
  assert.equal((await uploaded.json()).added,1)
  assert.equal((await (await get()).json()).data.activity[0].steps,8000)
 }finally{await stop();rmSync(dir,{force:true,recursive:true})}
})
