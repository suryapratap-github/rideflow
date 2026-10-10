#!/usr/bin/env node
/** Honest, reproducible build probe: missing toolchains are BLOCKED, never PASS. */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const specs = [
  { id:'api-build', cwd:'apps/api', command:'npm', args:['run','build'], dependency:'node_modules' },
  { id:'dashboard-build', cwd:'apps/dashboard', command:'npm', args:['run','build'], dependency:'node_modules' },
  { id:'flutter-analyze', cwd:'apps/mobile', command:'flutter', args:['analyze'], tool:'flutter' },
  { id:'flutter-build-android', cwd:'apps/mobile', command:'flutter', args:['build','apk','--release'], tool:'flutter' },
  { id:'prisma-validate', cwd:'apps/api', command:'npx', args:['--no-install','prisma','validate'], dependency:'node_modules' },
];
const selected = new Set(process.argv.filter(a=>a.startsWith('--only=')).map(a=>a.slice(7)));
const dry = process.argv.includes('--dry-run');
const known = new Set(specs.map(s=>s.id));
const unknown = [...selected].filter(id=>!known.has(id));
if(unknown.length){console.error(`Unknown build check(s): ${unknown.join(', ')}`);process.exit(2);}
const results = [];
for(const s of specs){
 if(selected.size && !selected.has(s.id))continue;
 const cwd=resolve(root,s.cwd);
 let status='BLOCKED', reason='', exitCode=null;
 if(!existsSync(cwd))reason=`Application directory missing: ${s.cwd}`;
 else if(s.dependency && !existsSync(resolve(cwd,s.dependency)))reason=`Dependencies missing: ${s.cwd}/${s.dependency}; run npm ci after generating and committing a lockfile`;
 else if(dry)reason='Dry run only: command not executed';
 else {
  const r=spawnSync(s.command,s.args,{cwd,encoding:'utf8',timeout:180000,env:{...process.env,CI:'1'}});
  exitCode=r.status;
  if(r.error)reason=`Unable to run ${s.command}: ${r.error.code ?? r.error.message}`;
  else if(r.signal)reason=`Process terminated by ${r.signal}`;
  else if(r.status!==0)reason=`Build failed (exit ${r.status}): ${(r.stderr||r.stdout||'').slice(-1200)}`;
  else {status='PASS';reason='Command exited successfully';}
 }
 results.push({id:s.id,status,command:[s.command,...s.args].join(' '),exitCode,reason});
 console.log(`${status.padEnd(7)} ${s.id}: ${reason}`);
}
const report={phase:121,generatedAt:new Date().toISOString(),results,allPassed:results.length>0&&results.every(r=>r.status==='PASS')};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--output'))writeFileSync(resolve(root,'build-validation-report.json'),JSON.stringify(report,null,2)+'\n');
if(!report.allPassed)process.exitCode=1;
