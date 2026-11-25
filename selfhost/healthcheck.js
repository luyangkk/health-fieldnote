import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { checkServerIdentity } from 'node:tls'
import { existsSync,readFileSync } from 'node:fs'
import { join } from 'node:path'

const tlsDir=process.env.FIELDNOTE_TLS_DIR
const cfg={hostname:'127.0.0.1',port:Number(process.env.PORT??(tlsDir?8443:8080)),path:'/healthz',timeout:3000}
if(tlsDir){
 const host=new URL(process.env.FIELDNOTE_ORIGIN).hostname.replace(/^\[|\]$/g,'')
 const ca=join(tlsDir,'ca.crt')
 if(existsSync(ca))cfg.ca=readFileSync(ca)
 cfg.rejectUnauthorized=true
 cfg.checkServerIdentity=(_,cert)=>checkServerIdentity(host,cert)
}
const req=(tlsDir?httpsGet:httpGet)(cfg,res=>{
 res.resume()
 res.on('end',()=>process.exit(res.statusCode===200?0:1))
})
req.on('timeout',()=>req.destroy())
req.on('error',()=>process.exit(1))
