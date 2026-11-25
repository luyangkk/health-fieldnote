import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'

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
 }finally{await stop();rmSync(dir,{force:true,recursive:true})}
})
