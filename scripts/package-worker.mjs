import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises'
import {build} from 'esbuild'
const root='dist'
const assets={}
assets['/']={type:'text/html; charset=utf-8',body:await readFile(root+'/index.html','utf8')}
for(const f of await readdir(root+'/assets')){
 if(!/\.(js|css)$/.test(f))throw Error('Unexpected asset '+f)
 assets['/assets/'+f]={type:f.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8',body:await readFile(root+'/assets/'+f,'utf8')}
}
const wrapped=`import {healthAPI} from './worker/api.js'
const assets=${JSON.stringify(assets)}
export default {async fetch(request,env){
 const path=new URL(request.url).pathname
 if(path==='/api/health-log')return healthAPI(request,env)
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405})
 const a=Object.hasOwn(assets,path)?assets[path]:null
 if(!a)return new Response('Not found',{status:404})
 return new Response(request.method==='HEAD'?null:a.body,{headers:{
  'Content-Type':a.type,
  'X-Content-Type-Options':'nosniff',
  'Cache-Control':path==='/'?'no-cache':'private, max-age=31536000, immutable',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'"
 }})
}}`
await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true})
await build({stdin:{contents:wrapped,resolveDir:process.cwd(),sourcefile:'worker-entry.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js'})
await build({entryPoints:['selfhost/import-api.js'],bundle:true,format:'esm',platform:'node',target:'node24',outfile:'dist/server/nothing-import.js'})
await writeFile('dist/.openai/hosting.json',await readFile('.openai/hosting.json'))
