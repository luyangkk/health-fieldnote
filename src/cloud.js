import {fresh,validate} from './lib.js'
export const syncKey='fieldnote.cloud.v1'
export async function readCloud() {
 const r=await fetch('/api/health-log',{cache:'no-store',credentials:'same-origin',redirect:'error'})
 return decode(r,true)
}
export async function saveCloud(revision,data) {
 const r=await fetch('/api/health-log',{method:'PUT',headers:{'Content-Type':'application/json','X-Fieldnote':'1'},cache:'no-store',credentials:'same-origin',redirect:'error',body:JSON.stringify({revision,data})})
 return decode(r,false)
}
async function decode(r,withData) {
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('未能连接到私人云端日志。')
 const value=await r.json()
 if(!r.ok){const e=new Error(value.error||'云端日志暂不可用。');e.status=r.status;throw e}
 if(!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('云端返回格式错误。')
 return {...value,...(withData&&value.data?{data:{...fresh(),...validate(value.data)}}:{})}
}
