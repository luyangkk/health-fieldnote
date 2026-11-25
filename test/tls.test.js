import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {request} from 'node:https'
import {setTimeout as delay} from 'node:timers/promises'

test('direct HTTPS uses verified local CA, requires auth and can store a revision',{timeout:25000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fieldnote-tls-'))
 const ip='127.0.0.1'
 const app=process.execPath
 let child
 try{
  const server=createServer()
  server.listen(0,ip);await once(server,'listening')
  const port=server.address().port
  await new Promise(r=>server.close(r))
  const origin='https://'+ip+':'+port
  const password='this-is-an-example-test-password-1234'
  const authorization='Basic '+Buffer.from('fieldnote:'+password).toString('base64')
  const tls=join(dir,'tls-direct')
  if(process.getuid()===0){
   execFileSync('sh',['deploy/init-tls.sh',dir,ip],{stdio:'pipe'})
  }else{
   // GitHub's image build tests the full root-only Unraid initialization script.
   return
  }
  const secret=join(dir,'password')
  writeFileSync(secret,password,{mode:0o600})
  const env={...process.env,PORT:String(port),FIELDNOTE_ORIGIN:origin,FIELDNOTE_BIND:ip,FIELDNOTE_DB:join(dir,'health.sqlite'),FIELDNOTE_PASSWORD_FILE:secret,FIELDNOTE_TLS_DIR:tls}
  const ca=readFileSync(join(tls,'ca.crt'))
  function send(path,headers={},method='GET',data,trust=true){
   return new Promise((resolve,reject)=>{
    const r=request(origin+path,{headers,method,rejectUnauthorized:true,...(trust?{ca}:{})},resp=>{
     let body='';resp.setEncoding('utf8');resp.on('data',chunk=>body+=chunk);resp.on('end',()=>resolve([resp.statusCode,body]))
    })
    r.on('error',reject)
    r.end(data)
   })
  }
  child=spawn(app,['selfhost/server.js'],{env,stdio:'pipe'})
  let ready=false
  for(let i=0;i<60;i++){
   if(child.exitCode!=null)throw Error('server exited before HTTPS became ready')
   try{if((await send('/healthz'))[0]===200){ready=true;break}}catch{}
   await delay(50)
  }
  assert.equal(ready,true)
  assert.equal(execFileSync(app,['selfhost/healthcheck.js'],{env,stdio:'pipe'}).length,0)
  await assert.rejects(send('/healthz',{},'GET',undefined,false))
  assert.equal((await send('/'))[0],401)
  assert.equal((await send('/api/health-log',{'oai-authenticated-user-id':'unraid-owner'}))[0],401)
  assert.match((await send('/',{authorization}))[1],/体能手记/)
  const body=JSON.stringify({revision:0,data:{version:1,target:1900}})
  assert.equal((await send('/api/health-log',{authorization,origin,'content-type':'application/json','content-length':Buffer.byteLength(body),'x-fieldnote':'1'},'PUT',body))[0],200)
  assert.equal(JSON.parse((await send('/api/health-log',{authorization}))[1]).revision,1)
 }finally{
  if(child?.exitCode===null){const closed=once(child,'exit');child.kill('SIGTERM');await closed}
  rmSync(dir,{force:true,recursive:true})
 }
})
