import React,{useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Activity,ArrowDownToLine,BarChart3,CalendarDays,Check,Cloud,ChevronDown,ChevronLeft,ChevronRight,CircleHelp,Dumbbell,Footprints,HeartPulse,LayoutDashboard,List,LockKeyhole,Plus,Scale,Settings2,Upload,Utensils,FileArchive,Pencil,Trash2} from 'lucide-react'
import {Button} from './components/ui/button'
import {Card,Badge} from './components/ui/card'
import {Dialog,DialogTitle,DialogDescription,DialogContent} from './components/ui/dialog'
import {fresh,load,dbKey,add,today,fullDate,dates,fmt,sum,meals,merge,validate,sample} from './lib'
import {readFile} from './importer'
import {readCloud,saveCloud,syncKey} from './cloud'
import './style.css'
const nav=[['home','今日总览',LayoutDashboard],['log','每日记录',List],['trend','趋势分析',BarChart3],['data','数据管理',ArrowDownToLine]]
const kinds={meal:['饮食',Utensils],workout:['运动',Dumbbell],metric:['身体指标',Scale]}
const captions={intake:'千卡',steps:'步',strength:'分钟',weight:'kg',bodyFat:'%'}
const labels={intake:'摄入热量',steps:'日常步数',strength:'力量训练',weight:'体重趋势',bodyFat:'体脂率趋势'}
const id=()=>globalThis.crypto.randomUUID()
const weekStart=d=>add(d,-((new Date(d+'T12:00:00Z').getUTCDay()+6)%7))
const totalOn=(db,date)=>db.dailyTotals?.find(row=>row.date===date)
const targetOn=(db,date)=>db.targetSchedule?.filter(row=>row.date<=date).sort((a,b)=>b.date.localeCompare(a.date))[0]?.kcal??(db.targetSchedule?.length?1900:db.target)
const values=(db,d,n,what)=>dates(d,n).map(date=>{
 if(what==='steps') {const a=db.activity.find(r=>r.date===date);return {date,v:a?.steps??null,partial:a?.partial}}
 if(what==='weight'||what==='bodyFat') {const key=what==='weight'?'weight':'bodyFatPct';return {date,v:db.metrics.filter(r=>r.date===date&&r[key]!=null).sort((a,b)=>(b.time??'').localeCompare(a.time??''))[0]?.[key]??null}}
 if(what==='intake'){const m=db.meals.filter(r=>r.date===date);return {date,v:totalOn(db,date)?.kcal??(m.length?sum(m,'kcal'):null),partial:!db.completed.includes(date)}}
 const w=db.workouts.filter(r=>r.date===date&&r.type.includes('力量')&&!r.flag)
 return {date,v:w.length?sum(w,'minutes'):null}
})
function TrendChart({db,day,period=7,metric='intake'}){
 const data=values(db,day,period,metric)
 const filled=data.filter(e=>e.v!=null)
 const nums=filled.map(e=>e.v)
 const isWeight=metric==='weight'||metric==='bodyFat', grid=isWeight?4:3, target=targetOn(db,day)
 const high=isWeight?Math.ceil((Math.max(...nums,0)+.2)*2)/2:Math.ceil(Math.max(...nums,(metric==='intake'?target:metric==='steps'?5000:60))*1.06/(metric==='strength'?30:500))*(metric==='strength'?30:500)
 const actualLow=isWeight&&nums.length?Math.min(high-1,Math.floor((Math.min(...nums)-.15)*2)/2):0
 const bounds=Array.from({length:grid+1},(_,i)=>high-(high-actualLow)*i/grid)
 const scale=v=>Math.min(100,Math.max(0,(v-actualLow)/(high-actualLow)*100))
 const xs=i=>(i+.5)/period*100
 return <>
  <div className="chart" aria-label={labels[metric]+'，最近'+period+'天'}>
   <div className="chart-scale">{bounds.map((v,i)=><span key={i}>{fmt(v,isWeight?1:0)}</span>)}</div>
   <div className="chart-unit">
    <div className="chart-plot">
     <div className="chart-grid">{bounds.map((_,i)=><i key={i}/>)}</div>
     {metric==='intake'&&<i className="chart-target" style={{bottom:scale(target)+'%'}} title={'目标 '+target+' 千卡'}/>}
     {isWeight&&filled.length>0&&<svg className="weight-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={data.flatMap((x,i)=>x.v==null?[]:[xs(i)+','+(100-scale(x.v))]).join(' ')} fill="none" stroke="#285c49" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>}
     {filled.length===0&&<div className="chart-empty">这段时间还没有记录</div>}
     <div className={'chart-bars '+(period>7?'compact':'')} style={{gridTemplateColumns:'repeat('+period+',minmax(0,1fr))'}}>
      {data.map((e,i)=><div key={e.date} className="bar-slot">
       {e.v!=null&&(isWeight?<span className="weight-dot" style={{bottom:scale(e.v)+'%'}} title={e.date+'：'+e.v+' '+captions[metric]}/>:<span title={e.date+'：'+fmt(e.v,1)+' '+captions[metric]+(e.partial?'（部分记录）':'')} className={'bar '+(e.partial?'partial':'')+' '+(i===period-1?'focusbar':'')} style={{height:Math.max(scale(e.v),1)+'%'}}/>)}
      </div>)}
     </div>
    </div>
    <div className="chart-labels">{data.map((e,i)=>(period===7||i%5===0||i===period-1)?<span key={e.date} style={{left:xs(i)+'%'}}>{e.date.slice(5).replace('-','/')}</span>:null)}</div>
   </div>
  </div>
  <div className="chart-legend"><span><i/> {labels[metric]}</span>{metric==='intake'&&<><span><i className="legend-part"/> 未记完</span><span><i className="legend-goal"/> 摄入目标</span></>}{metric==='steps'&&<span><i className="legend-part"/> 部分日</span>}</div>
 </>
}
function Field({label,children}){return <label className="field"><span>{label}</span>{children}</label>}
function Entry({kind,setKind,row,day,onSave,onDelete}){
 const [error,setError]=useState(''),[confirm,setConfirm]=useState(false)
 function submit(e){
  e.preventDefault();const f=new FormData(e.currentTarget);const val=k=>f.get(k)===''||f.get(k)==null?null:Number(f.get(k));const date=f.get('date');const base={id:row?.id??id(),date}
  let v,key
  if(kind==='meal'){key='meals';v={...base,type:f.get('type'),name:f.get('name').trim(),kcal:val('kcal'),protein:val('protein'),estimate:f.has('estimate')}}
  if(kind==='workout'){key='workouts';v={...base,type:f.get('type').trim(),time:f.get('time'),minutes:val('minutes'),kcal:val('kcal'),source:row?.source??'手动',flag:f.has('flag')}}
  if(kind==='metric'){key='metrics';v={...base,weight:val('weight'),waist:val('waist'),bodyFatPct:val('bodyFatPct'),time:f.get('measurementTime')||null}}
  try{const rec=validate({version:1,[key]:[v]})[key][0];onSave(key,rec,row)}catch{setError(kind==='metric'?'请至少填写一项有效的身体指标。':'请检查日期和数值，或补齐必要的字段。')}
 }
 return <>
 <DialogTitle>{row?'编辑记录':'添加记录'}</DialogTitle>
 <DialogDescription>{row?'修改会保存到当前启用的存储位置。':'记下你想跟踪的项目，没测的数据可以留空。'}</DialogDescription>
 {!row&&<div className="segmented entry-tabs">{Object.entries(kinds).map(([k,[l,I]])=><button key={k} className={kind===k?'selected':''} onClick={()=>setKind(k)} type="button"><I size={15}/>{l}</button>)}</div>}
 <form onSubmit={submit} key={kind} className="form">
  <div className={kind==='metric'?'form-row measurement-time':'form-row'}><Field label="日期"><input name="date" type="date" defaultValue={row?.date??day} required/></Field>{kind==='metric'&&<Field label="测量时间（可选）"><input name="measurementTime" type="time" step="1" defaultValue={row?.time??undefined}/></Field>}{kind==='workout'&&<Field label="开始时间"><input name="time" type="time" step="1" defaultValue={row?.time??'12:00'} required/></Field>}</div>
  {kind==='meal'&&<>
   <Field label="餐次"><select name="type" defaultValue={row?.type}>{meals.map(x=><option key={x}>{x}</option>)}</select></Field>
   <Field label="吃了什么"><input name="name" required maxLength={160} defaultValue={row?.name} placeholder="例如：鸡腿饭、蔬菜"/></Field>
   <div className="form-row"><Field label="摄入热量（千卡）"><input type="number" name="kcal" inputMode="decimal" min="0" max="10000" step="any" required defaultValue={row?.kcal}/></Field><Field label="蛋白质（克，可选）"><input type="number" name="protein" inputMode="decimal" min="0" max="500" step="any" defaultValue={row?.protein}/></Field></div>
   <label className="checkbox"><input name="estimate" type="checkbox" defaultChecked={row?.estimate??true}/> 这是估算值</label>
  </>}
  {kind==='workout'&&<>
   <Field label="运动类型"><input list="workout-types" name="type" required maxLength={80} defaultValue={row?.type??'力量训练'}/><datalist id="workout-types">{['力量训练','户外步行','户外骑行','室内单车','跑步','游泳'].map(x=><option key={x} value={x}/>)}</datalist></Field>
   <div className="form-row"><Field label="时长（分钟）"><input type="number" name="minutes" inputMode="decimal" min=".01" max="1440" step="any" required defaultValue={row?.minutes}/></Field><Field label="活动热量（千卡，可选）"><input type="number" name="kcal" inputMode="decimal" min="0" max="10000" step="any" defaultValue={row?.kcal}/></Field></div>
   <label className="checkbox"><input name="flag" type="checkbox" defaultChecked={row?.flag}/> 标为待核对（不计入训练趋势）</label>
  </>}
  {kind==='metric'&&<div className="form-row"><Field label="体重（kg）"><input type="number" name="weight" inputMode="decimal" min="10" max="600" step="any" defaultValue={row?.weight}/></Field><Field label="腰围（cm）"><input type="number" name="waist" inputMode="decimal" min="15" max="350" step="any" defaultValue={row?.waist}/></Field><Field label="体脂率（%）"><input type="number" name="bodyFatPct" inputMode="decimal" min="0.01" max="99.99" step="0.01" defaultValue={row?.bodyFatPct}/></Field></div>}
  {error&&<p role="alert" className="error">{error}</p>}
  {confirm&&<p className="error">再点一次「确认删除」即移除该条记录。</p>}
  <div className="form-actions">{row&&<Button variant="danger" type="button" onClick={()=>confirm?onDelete(kind,row):setConfirm(true)}><Trash2 size={16}/>{confirm?'确认删除':'删除'}</Button>}<Button type="submit">保存记录</Button></div>
 </form></>
}
function ImportForm({db,onImport}){
 const [file,setFile]=useState(null),[pass,setPass]=useState(''),[parsed,setParsed]=useState(null),[busy,setBusy]=useState(false),[err,setErr]=useState('')
 const preview=parsed?merge(db,parsed.data):null
 const range=parsed?[...new Set(['workouts','activity','meals','metrics'].flatMap(k=>(parsed.data[k]??[]).map(r=>r.date)))].sort():[]
 const fileExt=file?.name.toLowerCase().split('.').pop()
 async function parse(e){e.preventDefault();setBusy(true);setErr('');setParsed(null);try{const r=await readFile(file,pass);setParsed(r);setPass('')}catch(e){setErr(e.message)}finally{setBusy(false)}}
 return <>
 <DialogTitle>导入数据</DialogTitle><DialogDescription>支持 Nothing X 的加密 ZIP、运动或今日活动 XLSX，以及本站的 JSON 备份。文件和密码只在浏览器中处理；仅在开启云端后保存整理过的记录。</DialogDescription>
 <form className="form" onSubmit={parse}>
  <Field label="选择本地文件"><input required type="file" accept=".zip,.xlsx,.json" onChange={e=>{setFile(e.target.files[0]);setParsed(null);setErr('')}} disabled={busy}/></Field>
  {fileExt==='zip'&&!parsed&&<Field label="ZIP 解压密码（未加密可留空）"><input type="password" autoComplete="off" value={pass} onChange={e=>setPass(e.target.value)} disabled={busy}/></Field>}
  {err&&<p role="alert" className="error">{err}</p>}
  {parsed&&<div className="preview"><strong>{parsed.label} · 导入预览</strong><p>发现 {parsed.data.workouts?.length??0} 条训练、{parsed.data.activity?.length??0} 天活动快照{parsed.label!=='Nothing X'?'，另有 '+(parsed.data.meals?.length??0)+' 条饮食':''}。</p>{range.length>0&&<p>日期范围：{range[0]} 至 {range.at(-1)}</p>}<p>将新增 {preview.added} 条，更新 {preview.updated} 条，跳过 {preview.skipped} 条已有记录{parsed.rejected?'、'+parsed.rejected+' 条无效行':''}。</p></div>}
  <div className="form-actions">{parsed?<Button type="button" onClick={()=>onImport(parsed.data)}>确认导入</Button>:<Button type="submit" disabled={!file||busy}>{busy?'正在本地读取…':'预览导入'}</Button>}</div>
 </form></>
}
function App(){
 const [db,setDb]=useState(load),[page,setPage]=useState('home'),[day,setDay]=useState(today),[demo,setDemo]=useState(()=>{try{return !localStorage.getItem(dbKey)}catch{return true}}),[modal,setModal]=useState(null),[kind,setKind]=useState('meal'),[period,setPeriod]=useState(7),[metric,setMetric]=useState('intake'),[notice,setNotice]=useState(''),[target,setTarget]=useState(db.target)
 const [cloud,setCloud]=useState({mode:'checking',revision:0}), busy=useRef(false), cloudRef=useRef(cloud)
 cloudRef.current=cloud
 const hasEntries=data=>Object.keys({meals:1,workouts:1,activity:1,metrics:1,completed:1,rest:1}).some(k=>data[k].length)||data.target!==fresh().target
 const adopted=()=>{try{return localStorage.getItem(syncKey)==='1'}catch{return false}}
 const remember=()=>{try{localStorage.setItem(syncKey,'1')}catch{}}
 function useRemote(r){remember();setDb(r.data);setTarget(r.data.target);setDemo(false);setCloud({...r,mode:'cloud'})}
 async function refresh(){
  if(busy.current)return
  busy.current=true
  try{
   const r=await readCloud()
   if(r.data&&(adopted()||!hasEntries(load())))useRemote(r)
   else setCloud({...r,mode:r.data?'choice':'local'})
  }catch(e){setCloud(x=>({...x,mode:adopted()?'disconnected':'unavailable',error:e.message}))}
  finally{busy.current=false}
 }
 useEffect(()=>{refresh();const onFocus=()=>{if(['cloud','disconnected','checking'].includes(cloudRef.current.mode))refresh()};window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus)},[])
 async function activate(how){
  if(busy.current)return
  busy.current=true
  try{
   const r=await readCloud()
   if(how==='use'){if(!r.data)throw Error('还没有云端日志。');useRemote(r);notify('已切换到云端；原本机记录未删除。');return}
   const disk=load()
   const next=r.data?merge(r.data,{...disk,target:r.data.target}).next:disk
   const result=await saveCloud(r.revision,next)
   useRemote({...result,data:result.data??next});notify('云端保存已开启')
  }catch(e){notify(e.message||'无法开启云端保存。')}
  finally{busy.current=false}
 }
 const data=demo?sample(today()):db
 const m=data.meals.filter(r=>r.date===day), w=data.workouts.filter(r=>r.date===day).sort((a,b)=>b.time.localeCompare(a.time)), a=data.activity.find(r=>r.date===day), measurements=data.metrics.filter(r=>r.date===day)
 const done=data.completed.includes(day), rest=data.rest.includes(day), dailyTotal=totalOn(data,day), intake=dailyTotal?.kcal??sum(m,'kcal'), hasIntake=Boolean(dailyTotal||m.length), dailyTarget=targetOn(data,day), prot=m.some(x=>x.protein!=null)?sum(m,'protein'):null
 const since=weekStart(day), weekly=data.workouts.filter(x=>x.date>=since&&x.date<=day&&x.type.includes('力量')&&!x.flag)
 const recent=data.workouts.filter(x=>x.date<=day).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time)).slice(0,4)
 const body=data.metrics.filter(x=>x.date<=day&&x.weight!=null).sort((a,b)=>b.date.localeCompare(a.date))[0]
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),5000);return ()=>clearTimeout(t)},[notice])
 const go=p=>{setPage(p);window.scrollTo(0,0)}
 async function commit(next){
  if(busy.current){notify('正在连接或保存，请稍后重试。');return false}
  if(cloud.mode==='disconnected'||(adopted()&&cloud.mode!=='cloud')){notify('云端未连接，为避免覆盖记录，未保存。请先刷新云端。');return false}
  if(cloud.mode==='cloud'){
   busy.current=true
   try{
    const result=await saveCloud(cloud.revision,next)
    if(result.data)useRemote(result)
    else {setCloud({...result,data:next,mode:'cloud'});setDb(next);setDemo(false)}
    return true
   }catch(e){notify(e.message||'保存失败，请检查网络再试。');return false}
   finally{busy.current=false}
  }
  try{localStorage.setItem(dbKey,JSON.stringify(next));setDb(next);setDemo(false);return true}catch{notify('浏览器未能保存，请检查存储权限或空间。');return false}
 }
 const notify=t=>setNotice(t)
 function edit(k,row){setKind(k);setModal({type:'entry',row})}
 async function quitDemo(){if(await commit(db))notify('已进入你的私人日志')}
 async function toggleDay(k){const arr=db[k];if(await commit({...db,[k]:arr.includes(day)?arr.filter(x=>x!==day):[...arr,day]}))notify('已更新当天状态')}
 async function save(key,r,old){
  const next={...db,[key]:[...db[key].filter(x=>x.id!==r.id&&x.id!==old?.id),r]}
  if(key==='workouts')next.rest=db.rest.filter(x=>x!==r.date)
  if(await commit(next)){setDay(r.date);setModal(null);notify('记录已保存')}
 }
 async function remove(k,row){
  const key={meal:'meals',workout:'workouts',metric:'metrics'}[k]
  if(await commit({...db,[key]:db[key].filter(x=>x.id!==row.id)})){setModal(null);notify('已删除该条记录')}
 }
 async function finishImport(x){const r=merge(db,x);if(await commit(r.next)){setTarget(r.next.target);setModal(null);setPage('data');notify('导入完成：新增 '+r.added+' 条，更新 '+r.updated+' 条')}}
 function backup(){const url=URL.createObjectURL(new Blob([JSON.stringify(db,null,2)],{type:'application/json'}));const e=document.createElement('a');e.href=url;e.download='体能手记-备份-'+today()+'.json';e.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('备份已准备下载')}
 const headings={home:['今日总览','把饮食、训练和日常活动放在一起看。'],log:['每日记录','记录摄入、运动与身体指标。缺失的数据留空，不当作零。'],trend:['趋势分析','在日常波动之外，看看自己这段时间的变化。'],data:['数据管理','导入手表数据、设置目标，或者备份你的个人日志。']}
 function session(r,editable=false) {const Icon=r.type.includes('力量')?Dumbbell:r.type.includes('步')?Footprints:Activity;return <div className="activity-row" key={r.id}><div className="activity-symbol"><Icon size={18}/></div><div className="activity-info"><strong>{r.type}</strong><small>{r.date.slice(5).replace('-','/')} · {r.time.slice(0,5)} · {r.source}{r.flag?' · 待核对':''}</small></div><div className="activity-metric"><strong>{fmt(r.minutes,1)} <small>分钟</small></strong>{r.kcal!=null&&<small>{fmt(r.kcal)} 活动千卡</small>}</div>{editable&&!demo&&<Button size="icon" variant="ghost" aria-label={'编辑'+r.type} onClick={()=>edit('workout',r)}><Pencil size={16}/></Button>}</div>}
 function dailyLog(){return <div className="log-grid"><Card className="pad"><div className="panel-head"><div><small className="kicker">NUTRITION</small><h2>饮食记录</h2></div><Button variant="outline" size="sm" onClick={()=>edit('meal')}><Plus size={16}/> 记一餐</Button></div>
 <p className="muted">{dailyTotal?'全天总量 '+fmt(intake)+' 千卡，逐餐记录另列':hasIntake?'已记录 '+fmt(intake)+' 千卡':'这一天还没有饮食记录。'}{prot!=null?' · 已知蛋白质 '+fmt(prot,1)+' 克':''}</p>
 {meals.map(t=><div className="meal-section" key={t}><h3>{t}</h3>{m.filter(r=>r.type===t).map(r=><div className="meal-line" key={r.id}><div><strong>{r.name}</strong><small>{r.estimate?'估算':'手动记录'}{r.protein!=null?' · '+fmt(r.protein,1)+' 克蛋白质':''}</small></div><strong>{fmt(r.kcal)} <small>千卡</small></strong>{!demo&&<Button size="icon" variant="ghost" aria-label={'编辑'+r.name} onClick={()=>edit('meal',r)}><Pencil size={16}/></Button>}</div>)}{!m.some(r=>r.type===t)&&<small className="muted">未记录</small>}</div>)}
 <label className="checkbox done"><input checked={done} disabled={demo} type="checkbox" onChange={()=>toggleDay('completed')}/> 已记完当天饮食（含加餐和饮料）</label></Card>
 <div className="stack"><Card className="pad"><div className="panel-head"><div><small className="kicker">WORKOUT</small><h2>运动记录</h2></div><Button variant="outline" size="sm" onClick={()=>edit('workout')}><Plus size={16}/> 记训练</Button></div>
 {w.length?w.map(r=>session(r,true)):<p className="muted">{rest?'已标记为休息日。':'这一天还没有运动记录。'}</p>}
 {!w.length&&<label className="checkbox done"><input type="checkbox" checked={rest} disabled={demo} onChange={()=>toggleDay('rest')}/> 今天是休息日</label>}</Card>
 <Card className="pad"><div className="panel-head"><div><small className="kicker">BODY</small><h2>身体指标</h2></div><Button variant="outline" size="sm" onClick={()=>edit('metric')}><Plus size={16}/> 记录</Button></div>{measurements.length?measurements.map(row=><div className="activity-row" key={row.id}><div className="activity-info"><strong>{[row.weight!=null?fmt(row.weight,2)+' kg':null,row.bodyFatPct!=null?'体脂率 '+fmt(row.bodyFatPct,2)+'%':null,row.waist!=null?'腰围 '+fmt(row.waist,1)+' cm':null].filter(Boolean).join(' · ')}</strong>{row.time&&<small>{row.time.slice(0,5)}</small>}</div>{!demo&&<Button size="icon" variant="ghost" aria-label="编辑这次身体测量" onClick={()=>edit('metric',row)}><Pencil size={16}/></Button>}</div>):<p className="muted">当天没有身体测量。</p>}</Card></div></div>}
 return <div className="shell">
 <aside className="sidebar"><div className="brand"><span className="brand-icon"><HeartPulse size={24} strokeWidth={2}/></span><div><strong>体能手记</strong><small>FIELDNOTE</small></div></div>
  <div className="menu-label">个人工作台</div><nav aria-label="主导航">{nav.map(([k,l,Icon])=><button key={k} aria-current={page===k?'page':undefined} className={page===k?'active':''} onClick={()=>go(k)}><Icon size={18}/>{l}</button>)}</nav>
  <div className="side-bottom"><LockKeyhole size={17}/><div><strong>{cloud.mode==='cloud'?'私人云端已启用':'本机日志'}</strong><small>{cloud.mode==='cloud'?'同一账号跨设备同步':'可在数据管理中开启云端保存'}</small></div></div>
 </aside>
 <main className="main"><div className="wrap">
  <header className="topbar"><div className="breadcrumb">个人健康 <span>/</span> {headings[page][0]}</div><div className="top-actions"><Button variant="outline" onClick={()=>setModal({type:'import'})}><Upload size={17}/> 导入数据</Button><Button onClick={()=>edit('meal')}><Plus size={18}/> 添加记录</Button></div></header>
  <div className="page-head"><div><p className="kicker green">{page==='home'?'DAILY OVERVIEW':page==='log'?'DAILY JOURNAL':page==='trend'?'PROGRESS':'DATA & PRIVACY'}</p><h1>{headings[page][0]}</h1><p>{headings[page][1]}</p></div>
  {page!=='data'&&<div className="date-box"><Button variant="ghost" size="icon" aria-label="前一天" onClick={()=>setDay(add(day,-1))}><ChevronLeft size={18}/></Button><label className="date-display"><CalendarDays size={17}/><span>{fullDate(day)}</span><input type="date" aria-label="选择日期" value={day} onChange={e=>e.target.value&&setDay(e.target.value)} onClick={e=>{try{e.target.showPicker?.()}catch{}}}/></label><Button variant="ghost" size="icon" aria-label="后一天" onClick={()=>setDay(add(day,1))}><ChevronRight size={18}/></Button></div>}</div>
  {demo&&<div className="demo-banner"><span><CircleHelp size={17}/> <strong>示例模式</strong><span className="demo-copy">此处为虚构数据，不会混入你的日志。</span></span><Button size="sm" variant="outline" onClick={quitDemo}>进入我的日志</Button></div>}
  {page==='home'&&<>
   <div className="overview">
    <Card className="energy"><div className="energy-copy"><div className="hero-label"><Utensils size={16}/> 当日能量</div><h2>距摄入目标</h2><div className="energy-number">{hasIntake?fmt(Math.abs(dailyTarget-intake)):'—'} <span>千卡</span></div><p>{!hasIntake?'还没有饮食记录':intake>dailyTarget?'已超出当天目标':'按目前已记录的饮食计算'}{!done&&hasIntake?' · 饮食未记完':''}</p></div>
     <div className="energy-ring" aria-label={hasIntake?'已记录 '+intake+' 千卡':'未记录'}><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="51" className="ring-base"/><circle cx="60" cy="60" r="51" className="ring-value" strokeDasharray={Math.min(intake/dailyTarget,1)*320+' 320'} transform="rotate(-90 60 60)"/></svg><div><strong>{hasIntake?fmt(intake):'—'}</strong><small>已记录 · 千卡</small></div></div>
     <div className="energy-footer"><span>每日目标 <strong>{fmt(dailyTarget)} 千卡</strong></span><Button variant="ghost" size="sm" onClick={()=>go('log')}>看饮食明细</Button></div>
    </Card>
    <div className="top-metrics">
     <Card className="stat"><div className="stat-head"><span className="activity-symbol"><Dumbbell size={18}/></span><span>本周力量训练</span></div><div className="big">{weekly.length}<span> / 4 次</span></div><p>{weekly.length?'已记录 '+fmt(sum(weekly,'minutes'))+' 分钟':'本周尚未记录'} · 周一开始</p></Card>
     <Card className="stat"><div className="stat-head"><span className="activity-symbol"><Footprints size={18}/></span><span>当日活动</span></div><div className="big">{fmt(a?.steps)}<span> 步</span></div><p>{a?(a.partial?'截至 '+a.asOf.slice(0,5):'日终快照')+' · '+fmt(a.kcal)+' 活动千卡':'还没有手表活动快照'}</p></Card>
    </div>
   </div>
   <div className="section-row"><h2>最近动态</h2><Button size="sm" variant="ghost" onClick={()=>go('trend')}>查看完整趋势 <ChevronRight size={15}/></Button></div>
   <div className="dashboard-grid">
    <Card className="pad trend-panel"><div className="panel-head"><div><small className="kicker">NUTRITION TREND</small><h2>摄入热量</h2></div><Badge>最近 7 天</Badge></div><TrendChart db={data} day={day}/></Card>
    <Card className="pad recent-panel"><div className="panel-head"><div><small className="kicker">WORKOUT LOG</small><h2>最近运动</h2></div><Badge>{recent.length} 条</Badge></div>{recent.length?recent.slice(0,4).map(x=>session(x)):<div className="empty"><Dumbbell size={24}/><p>还没有运动记录</p><Button size="sm" variant="outline" onClick={()=>edit('workout')}>记一次训练</Button></div>}</Card>
   </div>
   <div className="small-foot"><LockKeyhole size={14}/> {cloud.mode==='cloud'?'私人云端':'本机保存'} · 手表消耗为估算，不从摄入里重复抵扣</div>
  </>}
  {page==='log'&&dailyLog()}
  {page==='trend'&&<>
    <div className="trend-kpis"><Card className="stat"><span>最近体重</span><div className="big">{fmt(body?.weight,1)} <span>kg</span></div><p>{body?.date??'请先记录体重'}</p></Card><Card className="stat"><span>完整饮食天数</span><div className="big">{data.completed.filter(x=>dates(day,period).includes(x)&&(totalOn(data,x)||data.meals.some(y=>y.date===x))).length}<span> / {period} 天</span></div><p>仅完整记录计入平均摄入</p></Card><Card className="stat"><span>完整日平均摄入</span><div className="big">{(()=>{const a=values(data,day,period,'intake').filter(x=>x.v!=null&&!x.partial);return a.length?fmt(sum(a,'v')/a.length):'—'})()} <span>千卡</span></div><p>不把缺失日期按零计算</p></Card></div>
    <Card className="pad detail-chart"><div className="panel-head trend-head"><div><small className="kicker">TRENDS</small><h2>{labels[metric]}</h2></div><div className="segmented" aria-label="趋势时间范围">{[7,30].map(x=><button key={x} className={period===x?'selected':''} onClick={()=>setPeriod(x)}>{x} 天</button>)}</div></div><div className="segmented trend-tabs" aria-label="趋势指标">{Object.entries(labels).map(([k,t])=><button key={k} className={metric===k?'selected':''} onClick={()=>setMetric(k)}>{t}</button>)}</div><TrendChart db={data} day={day} period={period} metric={metric}/></Card>
   </>}
  {page==='data'&&<div className="data-grid">
    <Card className="pad cloud-card"><div className="panel-head"><div><small className="kicker">CLOUD SYNC</small><h2>私人云端存储</h2></div><div className="activity-symbol"><Cloud size={20}/></div></div>
      {cloud.mode==='cloud'?<><p className="muted">已启用。之后的录入和导入会保存到你的账号。换设备时，用同一个账号打开本站即可读取。</p><p className="muted">{cloud.updatedAt?'最近保存：'+new Date(cloud.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':''}</p></>
      :cloud.mode==='choice'?<p className="muted">这个浏览器同时有本机记录和已有云端日志。你可以合并（重复记录保留云端版本，活动取较新的快照），也可以只看云端，本机原始记录不会删除。</p>
      :cloud.mode==='local'?<p className="muted">开启后，会将本机日志复制到仅同一账号可访问的云端。不会上传 Nothing X 原始文件、密码、路线或账号信息；不会自动迁移聊天记录。</p>
      :<p className="muted">{cloud.mode==='checking'?'正在查询账号的云端存储…':cloud.mode==='disconnected'?'云端暂时连不上。已启用云端的日志不会退回本机写入，以免覆盖数据。':'暂时无法使用云端存储。当前仍可保存到本机。'}</p>}
      <div className="data-actions">
        {cloud.mode==='local'&&<Button onClick={()=>activate('merge')}><Cloud size={17}/> 开启并复制本机数据</Button>}
        {cloud.mode==='choice'&&<><Button onClick={()=>activate('merge')}>合并本机和云端</Button><Button variant="outline" onClick={()=>activate('use')}>只读取云端</Button></>}
        {cloud.mode!=='checking'&&<Button variant="outline" onClick={refresh}>刷新云端</Button>}
      </div>
    </Card>
    <Card className="pad"><div className="panel-head"><div><small className="kicker">IMPORT</small><h2>Nothing X 与备份</h2></div><div className="activity-symbol"><FileArchive size={20}/></div></div>
     <p className="muted">选择 Nothing X 导出的 ZIP，或单独选择运动、今日活动表。导入前可预览，重复训练不会叠加，活动只保留每天最新快照。</p>
     <p className="muted">不会导入心率、压力、GPS 路线或账号资料，也不会读取 iPhone 健康或后台同步。已保存 {db.workouts.length} 条训练、{db.activity.length} 天活动、{db.meals.length} 条饮食。</p>
     <div className="data-actions"><Button onClick={()=>setModal({type:'import'})}><Upload size={17}/> 选择文件</Button><Button variant="outline" onClick={backup}><ArrowDownToLine size={17}/> 导出 JSON 备份</Button></div>
    </Card>
    <Card className="pad"><div className="panel-head"><div><small className="kicker">PREFERENCES</small><h2>个人设置</h2></div><div className="activity-symbol"><Settings2 size={20}/></div></div>
     <form className="form" onSubmit={async e=>{e.preventDefault();if(await commit({...db,target:Number(target)}))notify('摄入目标已更新')}}><Field label="每日摄入目标（千卡）"><input required type="number" inputMode="numeric" min="500" max="10000" step="1" value={target} onChange={e=>setTarget(e.target.value)}/></Field><Button type="submit">保存目标</Button></form>
     <p className="muted small-note">日期按北京时间记录。未启用云端时，清除浏览器数据前请先备份。示例模式只展示虚构数据。</p>
     <Button variant="outline" size="sm" onClick={()=>demo?quitDemo():setDemo(true)}>{demo?'退出示例':'查看示例'}</Button>
    </Card>
   </div>}
 </div></main>
 <Dialog open={!!modal} onOpenChange={open=>!open&&setModal(null)}>{modal&&<DialogContent>{modal.type==='import'?<ImportForm db={db} onImport={finishImport}/>:<Entry kind={kind} setKind={setKind} row={modal.row} day={day} onSave={save} onDelete={remove}/>}</DialogContent>}</Dialog>
 {notice&&<div className="toast" role="status"><Check size={17}/>{notice}</div>}
 </div>
}
createRoot(document.getElementById('root')).render(<App/>)
