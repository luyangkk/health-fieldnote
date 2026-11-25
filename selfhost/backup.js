import { DatabaseSync, backup } from 'node:sqlite'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

process.umask(0o077)
const source = resolve(process.env.FIELDNOTE_DB ?? '/data/health.sqlite')
const target = resolve(process.argv[2] ?? '/data/backups/fieldnote-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite')
if(source === target || target.startsWith(source+'-'))throw Error('Unsafe backup target')
mkdirSync(dirname(target),{recursive:true,mode:0o700})
const dir=mkdtempSync(join(dirname(target),'.fieldnote-'))
const temp=join(dir,'backup.sqlite')
try {
 const db = new DatabaseSync(source,{ readOnly:true,timeout:5000 })
 try {await backup(db,temp)} finally {db.close()}
 const check=new DatabaseSync(temp,{readOnly:true})
 try {if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Backup verification failed')}
 finally{check.close()}
 chmodSync(temp,0o600)
 linkSync(temp,target)
 console.log(target)
}finally{rmSync(dir,{recursive:true,force:true})}
