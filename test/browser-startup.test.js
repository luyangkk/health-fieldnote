import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {dbKey,fresh} from '../src/lib.js'

// Render the real initial App tree with browser storage failures. Effects and
// network requests are deliberately excluded from this first-render check.
const root=fileURLToPath(new URL('../',import.meta.url))
const result=await build({
 absWorkingDir:root,entryPoints:['src/main.jsx'],bundle:true,write:false,
 format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent',
 plugins:[{name:'startup-render',setup(builder){
  builder.onResolve({filter:/^react-dom\/client$/},()=>({path:'client',namespace:'startup'}))
  builder.onLoad({filter:/.*/,namespace:'startup'},()=>({
   contents:`import {renderToString} from 'react-dom/server';
    export const createRoot=()=>({render(element){document.markup=renderToString(element)}})`,
   resolveDir:root
  }))
 }}]
})
const run=new Function('require','document','localStorage',result.outputFiles[0].text)
function render(storage){
 const document={getElementById:()=>({})}
 run(createRequire(import.meta.url),document,storage)
 assert.match(document.markup,/<main/)
 assert.match(document.markup,/今日总览/)
 return document.markup
}

test('initial App renders when localStorage access is denied',()=>{
 const html=render({getItem(){throw new DOMException('Access denied','SecurityError')}})
 assert.match(html,/示例/)
})
test('initial App renders with empty, existing, or malformed local records',()=>{
 render({getItem:()=>null})
 render({getItem:()=>'{invalid'})
 const data={...fresh(),target:2345}
 const html=render({getItem:key=>key===dbKey?JSON.stringify(data):null})
 assert.match(html,/2,345/)
 assert.doesNotMatch(html,/demo-banner/)
})
