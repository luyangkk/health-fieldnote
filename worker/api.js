import {fresh,validate} from '../src/lib.js'
const LIMIT=1_500_000
const locked={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}
const json=(value,status=200)=>Response.json(value,{status,headers:locked})
async function readInput(request) {
 const contentLength=request.headers.get('Content-Length');
 if(contentLength&&Number(contentLength)>LIMIT)throw new RangeError()
 const reader=request.body?.getReader();if(!reader)throw new SyntaxError();
 const decoder=new TextDecoder('utf-8',{fatal:true});let content='',n=0
 try{
  for(;;){
   const {value,done}=await reader.read();if(done)break;n+=value.byteLength
   if(n>LIMIT){await reader.cancel();throw new RangeError()}
   content+=decoder.decode(value,{stream:true})
  }
  content+=decoder.decode()
 }finally{reader.releaseLock()}
 return JSON.parse(content)
}
export async function healthAPI(request,env) {
 const owner=request.headers.get('oai-authenticated-user-id')
 if(!owner||owner.length>512)return json({error:'请先使用有权访问本站的 ChatGPT 账号登录。'},401)
 if(!['GET','PUT'].includes(request.method))return json({error:'不支持的请求。'},405)
 if(!env.DB)return json({error:'云端存储暂不可用。'},503)
 const load=async()=>env.DB.prepare('SELECT revision, payload, updated_at FROM health_logs WHERE owner_id = ?').bind(owner).first()
 if(request.method==='GET'){
  try{const row=await load();return json(row?{revision:row.revision,data:JSON.parse(row.payload),updatedAt:row.updated_at}:{revision:0,data:null,updatedAt:null})}
  catch{return json({error:'无法读取云端日志。'},503)}
 }
 const origin=request.headers.get('origin')
 if(origin!==new URL(request.url).origin||request.headers.get('x-fieldnote')!=='1')return json({error:'仅允许从本站保存记录。'},403)
 if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'记录格式错误。'},415)
 let revision,data,payload
 try{
  const input=await readInput(request);revision=input.revision
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error()
  data={...fresh(),...validate(input.data)};payload=JSON.stringify(data)
  if(new TextEncoder().encode(payload).length>LIMIT)throw new RangeError()
 }catch(e){return json({error:e instanceof RangeError?'记录超出单份日志容量，请先导出备份。':'存在无效记录，未保存。'},e instanceof RangeError?413:400)}
 try{
  const updatedAt=new Date().toISOString()
  const result=revision===0
   ?await env.DB.prepare('INSERT INTO health_logs (owner_id, revision, payload, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(owner_id) DO NOTHING').bind(owner,payload,updatedAt).run()
   :await env.DB.prepare('UPDATE health_logs SET revision = revision + 1, payload = ?, updated_at = ? WHERE owner_id = ? AND revision = ?').bind(payload,updatedAt,owner,revision).run()
  if(!result.meta.changes)return json({error:'另一台设备已更新，请读取最新云端记录后重试。'},409)
  return json({revision:revision+1,updatedAt})
 }catch{return json({error:'云端未能确认保存，请刷新核对后重试。'},503)}
}
