import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {healthAPI} from '../worker/api.js'
const host='https://test.example'
const url=host+'/api/health-log'
test('cloud persistence uses applied SQL, isolates accounts and rejects stale versions',async()=>{
 const sql=new DatabaseSync(':memory:')
 sql.exec(readFileSync(new URL('../drizzle/0000_health_logs.sql',import.meta.url),'utf8'))
 function prepare(query){return {bind:(...args)=>({first:async()=>sql.prepare(query).get(...args),run:async()=>({meta:sql.prepare(query).run(...args)})})}}
 const env={DB:{prepare}}
 const get=owner=>healthAPI(new Request(url,{headers:owner?{'oai-authenticated-user-id':owner}:{}}),env)
 const put=(owner,origin,v,data)=>healthAPI(new Request(url,{method:'PUT',headers:{origin,'x-fieldnote':'1','oai-authenticated-user-id':owner,'content-type':'application/json'},body:JSON.stringify({revision:v,data})}),env)
 const meal={id:'fake',date:'2030-02-03',type:'午餐',name:'测试餐',kcal:600,privateUnrecognizedField:'stripped'}
 const data={version:1,meals:[meal]}
 assert.equal((await get()).status,401)
 assert.equal((await get('alice')).headers.get('cache-control'),'private, no-store')
 assert.equal((await put('alice','https://different.example',0,data)).status,403)
 assert.equal((await put('alice',host,0,{version:1,meals:[{...meal,kcal:-1}]})).status,400)
 assert.equal((await get('alice')).status,200)
 assert.equal((await put('alice',host,0,data)).status,200)
 assert.equal((await put('alice',host,0,data)).status,409)
 assert.equal((await (await get('bob')).json()).data,null)
 const alice=await (await get('alice')).json()
 assert.equal(alice.data.meals[0].kcal,600)
 assert.equal(alice.data.meals[0].privateUnrecognizedField,undefined)
 assert.equal((await put('alice',host,alice.revision,{version:1,meals:[]})).status,200)
 assert.deepEqual((await (await get('alice')).json()).data.meals,[])
 assert.equal((await (await get('alice')).json()).revision,2)
 sql.close()
})
