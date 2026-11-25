import {fresh,validate} from './lib.js'
export const syncKey='fieldnote.cloud.v1'
export async function readCloud() {
 const r=await fetch('/api/health-log',{cache:'no-store',credentials:'same-origin',redirect:'error'})
 return decode(r)
}
export async function saveCloud(revision,data) {
 const r=await fetch('/api/health-log',{method:'PUT',headers:{'Content-Type':'application/json','X-Fieldnote':'1','X-Fieldnote-Schema':'2'},cache:'no-store',credentials:'same-origin',redirect:'error',body:JSON.stringify({revision,data})})
 return decode(r)
}
async function decode(r) {
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('未能连接到私人云端日志。')
 const value=await r.json()
 if(!r.ok){const e=new Error(value.error||'云端日志暂不可用。');e.status=r.status;throw e}
 if(!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('云端返回格式错误。')
 return {...value,...(value.data?{data:{...fresh(),...validate(value.data)}}:{})}
}
