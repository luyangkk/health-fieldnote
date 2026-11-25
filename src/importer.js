import {validate,workoutId,fresh} from './lib.js'
const max=35_000_000
export const importable=n=>/^(?:.*\/)?健康数据(?:今日活动|运动)_\d{6}\.xlsx$/i.test(n)
const dt=x=>String(x??'').trim().replace('T',' ').split(/\s+/)
const n=x=>x==null||x===''?NaN:Number(x)
export function readRows(rows,kind,out) {
 let rejected=0
 for(const r of rows){
  try{
   if(kind==='workouts'){
    const [date,time]=dt(r['发起时间']);const type=String(r['运动类型']??'').trim();const minutes=n(r['运动时长(分钟)']);const v=n(r['活动卡路里(千卡)'])
    const row={id:workoutId(date,time,type),date,time,type,minutes,kcal:Number.isFinite(v)?v:null,source:'CMF',flag:type.includes('力量')&&minutes>100}
    out.workouts.push(validate({version:1,workouts:[row]}).workouts[0])
   }else{
    const [date,asOf]=dt(r['时间']);const row={id:'activity:'+date,date,asOf,steps:n(r['步数(步)']),total:n(r['总卡路里(千卡)']),kcal:n(r['活动卡路里(千卡)']),minutes:n(r['运动时长(分钟)'])}
    const item=validate({version:1,activity:[row]}).activity[0];const old=out.activity.get(date);if(!old||item.asOf>old.asOf)out.activity.set(date,item)
   }
  }catch{rejected++}
 }
 return rejected
}
export async function readFile(file,password=''){
 if(!file||file.size>max)throw Error('请选择小于 35 MB 的文件。')
 const ext=file.name.toLowerCase().split('.').pop()
 if(ext==='json'){const p=JSON.parse(await file.text());return {data:validate(p),rejected:0,files:1,label:'体能手记备份'}}
 if(!['zip','xlsx'].includes(ext))throw Error('支持 Nothing X ZIP、运动或今日活动 XLSX，以及体能手记 JSON。')
 const XLSX=await import('xlsx'); const out={workouts:[],activity:new Map()};let rejected=0,files=0
 const parse=(arr,name)=>{
  const w=XLSX.read(arr,{type:'array',dense:true,raw:true,sheetRows:30001});let found=false
  for(const label of w.SheetNames){
   if(!['运动数据','今日活动'].includes(label))continue
   found=true;const rows=XLSX.utils.sheet_to_json(w.Sheets[label],{raw:true,defval:null})
   if(rows.length>=30000)throw Error('单表记录过多，请按月拆分后导入。')
   rejected+=readRows(rows,label==='运动数据'?'workouts':'activity',out)
  }
  if(!found)throw Error('未找到 Nothing X 运动或今日活动工作表：'+name.split('/').pop())
  files++
 }
 if(ext==='xlsx')parse(await file.arrayBuffer(),file.name)
 else {
  const {ZipReader,BlobReader,Uint8ArrayWriter}=await import('@zip.js/zip.js')
  const zr=new ZipReader(new BlobReader(file),{useWebWorkers:false})
  try {
   const entries=(await zr.getEntries()).filter(e=>!e.directory&&importable(e.filename))
   if(!entries.length)throw Error('这个 ZIP 没有 Nothing X 运动或今日活动表。')
   if(entries.length>80||entries.reduce((a,e)=>a+e.uncompressedSize,0)>max)throw Error('解压体积过大，请按月导入。')
   if(entries.some(e=>e.encrypted)&&!password)throw Error('请输入 Nothing X 给你的 ZIP 解压密码。')
   for(const e of entries){
    let data
    try{data=await e.getData(new Uint8ArrayWriter(),{password,checkSignature:true})}catch{throw Error('无法解压，请核对密码或重新下载文件。')}
    parse(data,e.filename)
   }
  }finally{await zr.close()}
 }
 if(!out.workouts.length&&!out.activity.size)throw Error('找不到可导入的有效运动或活动记录。')
 const workouts=[...new Map(out.workouts.map(r=>[r.id,r])).values()]
 return {data:{workouts,activity:[...out.activity.values()]},rejected,files,label:'Nothing X'}
}
