import {clsx} from 'clsx'
import {twMerge} from 'tailwind-merge'
export const cn=(...inputs)=>twMerge(clsx(inputs))
export const zone='Asia/Shanghai'
export const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone}).format(new Date())
export const add=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)}
export const dates=(d,n)=>Array.from({length:n},(_,i)=>add(d,i-n+1))
export const fullDate=d=>new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long',timeZone:zone}).format(new Date(d+'T04:00:00Z'))
export const fresh=()=>({version:1,target:1900,meals:[],workouts:[],metrics:[],activity:[],completed:[],rest:[]})
export const fmt=(x,d=0)=>x==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:d}).format(x)
export const sum=(rs,k)=>rs.reduce((a,b)=>a+(b[k]??0),0)
export const validDate=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d
export const workoutId=(date,time,type)=>'cmf:'+date+'T'+time+':'+type
export const prefix={meals:'meal',workouts:'workout',metrics:'metric',activity:'activity'}
export function merge(db, incoming) {
 const next={...db};let added=0,updated=0,skipped=0
 for(const key of Object.keys(prefix)){
  const m=new Map(db[key].map(r=>[r.id,r]))
  for(const row of incoming[key]??[]){
   const old=m.get(row.id)
   if(!old){m.set(row.id,row);added++}
   else if(key==='activity' && (row.asOf??'')>(old.asOf??'')){m.set(row.id,row);updated++}
   else skipped++
  }
  next[key]=[...m.values()]
 }
 for(const k of ['completed','rest'])next[k]=[...new Set([...db[k],...(incoming[k]??[])])]
 if(incoming.target!=null)next.target=incoming.target
 return {next,added,updated,skipped}
}
const nm=(x,min,max)=>typeof x==='number' && Number.isFinite(x) && x>=min && x<=max
const str=(x,l)=>typeof x==='string' && x.trim().length>0 && x.length<=l
const time=x=>typeof x==='string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(x)
const nullable=(x,a,b)=>x==null||nm(x,a,b)
export const meals=['早餐','午餐','晚餐','加餐 / 饮料']
export function validate(data) {
 if(!data || typeof data!=='object' || data.version!==1) throw Error('不能识别备份格式。请选择体能手记 JSON 备份。')
 const out={};let count=0
 for(const key of Object.keys(prefix)){
  const list=data[key]??[]
  if(!Array.isArray(list))throw Error('备份的记录列表无效。')
  count+=list.length
  if(count>30000)throw Error('备份记录过多。')
  out[key]=list.map(({id,date,type,name,kcal,protein,estimate,time:t,minutes,source,flag,weight,waist,bodyFatPct,asOf,steps,total,partial})=>{
   if(!str(id,220)||!validDate(date))throw Error('存在无效日期或记录编号。')
   if(key==='meals'&&meals.includes(type)&&str(name,160)&&nm(kcal,0,10000)&&nullable(protein,0,500))return {id,date,type,name,kcal,protein:protein??null,estimate:!!estimate}
   if(key==='workouts'&&str(type,80)&&time(t)&&nm(minutes,0.01,1440)&&nullable(kcal,0,10000))return {id,date,type,time:t,minutes,kcal:kcal??null,source:source==='CMF'?'CMF':'手动',flag:flag===true}
   if(key==='metrics'&&nullable(weight,10,600)&&nullable(waist,15,350)&&(bodyFatPct==null||(nm(bodyFatPct,.01,99.99)&&Math.abs(bodyFatPct*100-Math.round(bodyFatPct*100))<1e-8))&&(t===undefined||t===null||time(t))&&(weight!=null||waist!=null||bodyFatPct!=null))return {id,date,weight:weight??null,waist:waist??null,...(bodyFatPct!==undefined?{bodyFatPct}: {}),...(t!==undefined&&(t===null||time(t))?{time:t}: {})}
   if(key==='activity'&&time(asOf)&&nm(steps,0,250000)&&nm(total,0,15000)&&nm(kcal,0,15000)&&nm(minutes,0,1440))return {id,date,asOf,steps,total,kcal,minutes,partial:!asOf.startsWith('23:59')}
   throw Error('备份包含无效记录：'+key+' / '+date)
  })
 }
 for(const k of ['completed','rest']){
  if(data[k]!=null && (!Array.isArray(data[k])||data[k].length>30000||data[k].some(x=>!validDate(x))))throw Error('备份包含无效状态日期。')
  out[k]=data[k]??[]
 }
 for(const [key,min,max] of [['dailyTotals',0,30000],['targetSchedule',500,10000]]){
  if(data[key]===undefined)continue
  if(!Array.isArray(data[key])||data[key].length>30000||data[key].some(r=>!r||!validDate(r.date)||!nm(r.kcal,min,max)))throw Error('备份包含无效的每日热量或目标。')
  out[key]=data[key].map(r=>({date:r.date,kcal:r.kcal,...(key==='dailyTotals'?{estimate:r.estimate===true}:{})}))
 }
 if(data.target!=null){if(!nm(data.target,500,10000))throw Error('摄入目标超出可记录范围。');out.target=data.target}
 return out
}
export const dbKey='fieldnote.health.v1'
export function load(){try {const raw=localStorage.getItem(dbKey);return raw?{...fresh(),...validate(JSON.parse(raw))}:fresh()}catch{return fresh()}}
export function sample(day){
 const db=fresh()
 dates(day,30).forEach((d,i)=>{
  if(i<29&&i%8!==5){
   const cals=[1700,1835,1750,1920,1690,1810,1850,1960,1790,1735,1910,1880,1740][i%13]
   db.meals.push({id:'m'+i,date:d,type:'午餐',name:'当日摄入合计',kcal:cals,estimate:true,protein:101+i%19});db.completed.push(d)
  }
  const steps=[3850,6210,4680,9150,7320,4580,9850,6810,5630,8210,7120,5750][i%12]
  db.activity.push({id:'activity:'+d,date:d,asOf:i===29?'15:20:00':'23:59:55',steps,total:1580+Math.round(steps/14),kcal:Math.round(steps/14),minutes:Math.floor(steps/210),partial:i===29})
  if([0,1,3,5].includes(i%7)) db.workouts.push({id:'w'+i,date:d,type:'力量训练',time:'12:45',minutes:36+i%13,kcal:170+i%12*6,source:'手动',flag:false})
  if(i%7===4)db.workouts.push({id:'c'+i,date:d,type:'户外骑行',time:'18:20',minutes:31,kcal:148,source:'手动',flag:false})
  if(i%3===0)db.metrics.push({id:'b'+i,date:d,weight:Math.round((69.8-i*.039+Math.cos(i)*.2)*10)/10,waist:null})
 })
 db.meals.push({id:'x',date:day,type:'早餐',name:'燕麦、鸡蛋和酸奶',kcal:460,protein:25,estimate:true},{id:'y',date:day,type:'午餐',name:'烤鸡腿饭、时蔬',kcal:685,protein:42,estimate:true})
 return db
}
