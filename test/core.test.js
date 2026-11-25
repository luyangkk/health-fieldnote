import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader} from '@zip.js/zip.js'
import {readFile} from '../src/importer.js'
import {fresh,merge,validate} from '../src/lib.js'
const d='2030-02-03'
function excel(name,rows){
 const wb=XLSX.utils.book_new()
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),name)
 return new Uint8Array(XLSX.write(wb,{type:'array',bookType:'xlsx'}))
}
test('encrypted Nothing X export: password, scope, preview merge and deduplication',async()=>{
 const password='fixture-password'
 const wrapped=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false})
 const add=(file,bytes)=>wrapped.add(file,new Uint8ArrayReader(bytes),{password,useWebWorkers:false,level:0})
 const active=(time,steps)=>({'时间':d+' '+time,'步数(步)':steps,'总卡路里(千卡)':1200,'活动卡路里(千卡)':150,'运动时长(分钟)':5})
 await add('健康数据今日活动_203002.xlsx',excel('今日活动',[active('14:10:20',4321),active('12:29:00',2100)]))
 await add('健康数据运动_203002.xlsx',excel('运动数据',[{'发起时间':d+' 08:14:00','运动类型':'力量训练','运动时长(分钟)':142.5,'活动卡路里(千卡)':142,'GPS运动轨迹':'must not import'}]))
 await add('账号基本信息_info.xlsx',new Uint8Array([1,2,3]))
 const f=new File([await wrapped.close()],'export.zip')
 await assert.rejects(readFile(f),/请输入/)
 await assert.rejects(readFile(f,'wrong'),/核对密码/)
 const r=await readFile(f,password)
 assert.equal(r.files,2)
 assert.equal(r.data.activity.length,1)
 assert.equal(r.data.activity[0].steps,4321)
 assert.equal(r.data.activity[0].partial,true)
 assert.equal(r.data.workouts.length,1)
 assert.equal(r.data.workouts[0].flag,true)
 assert.ok(!JSON.stringify(r).includes('must not import'))
 const first=merge(fresh(),r.data);assert.equal(first.added,2)
 const second=merge(first.next,r.data);assert.equal(second.added,0);assert.equal(second.skipped,2)
 assert.equal(merge(first.next,{activity:[{...r.data.activity[0],asOf:'23:59:55'}]}).updated,1)
 assert.equal(first.next.rest.length,0)
})
test('backup validation keeps zero distinct and does not expand record fields',()=>{
 const b=validate({version:1,meals:[{id:'1',date:d,type:'早餐',name:'水',kcal:0,extra:'not saved'}]})
 assert.equal(b.meals[0].kcal,0)
 assert.equal(b.meals[0].extra,undefined)
 assert.throws(()=>validate({version:1,activity:[{id:'x',date:'2026-02-31'}]}))
})
