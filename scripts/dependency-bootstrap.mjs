#!/usr/bin/env node
/** Generate real npm lockfiles only via the configured npm registry; never synthesize dependency hashes. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const write=process.argv.includes('--write');
const packages=['apps/api','apps/dashboard'];
const result=[];
for(const pkg of packages){
 const cwd=resolve(root,pkg), manifest=resolve(cwd,'package.json'), lock=resolve(cwd,'package-lock.json');
 if(!existsSync(manifest)){result.push({package:pkg,status:'BLOCKED',reason:'package.json missing'});continue;}
 if(!write){result.push({package:pkg,status:existsSync(lock)?'PRESENT':'BLOCKED',reason:existsSync(lock)?'Existing lockfile (run dependency-preflight to verify)':'Missing lockfile; run with --write in a network-enabled environment'});continue;}
 const proc=spawnSync('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{cwd,encoding:'utf8',timeout:120000});
 result.push({package:pkg,status:proc.status===0?'GENERATED':'BLOCKED',reason:proc.status===0?'npm generated package-lock.json':`npm exit ${proc.status??'unavailable'}: ${(proc.stderr||proc.stdout||'').slice(-500)}`});
}
if(process.argv.includes('--json'))console.log(JSON.stringify({results:result},null,2));
else for(const r of result)console.log(`${r.status} ${r.package}: ${r.reason}`);
if(result.some(r=>r.status==='BLOCKED'))process.exitCode=1;
