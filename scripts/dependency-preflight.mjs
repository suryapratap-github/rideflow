#!/usr/bin/env node
/** Fail closed: never synthesize dependency resolution or claim reproducible builds without locks. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const fixtureRoot = process.env.RIDEFLOW_PREFLIGHT_ROOT ? resolve(process.env.RIDEFLOW_PREFLIGHT_ROOT) : root;
const rootPath = p => resolve(fixtureRoot,p);
const checks = [
  {id:'api-npm-lock', manifest:'apps/api/package.json', lock:'apps/api/package-lock.json'},
  {id:'dashboard-npm-lock', manifest:'apps/dashboard/package.json', lock:'apps/dashboard/package-lock.json'},
  {id:'flutter-lock', manifest:'apps/mobile/pubspec.yaml', lock:'apps/mobile/pubspec.lock'},
];
let failures=0;
for(const c of checks){
  const manifest=rootPath(c.manifest), lock=rootPath(c.lock);
  let reason='';
  if(!existsSync(manifest)) reason='Manifest missing';
  else if(!existsSync(lock)) reason='Lockfile missing; generate using the official package manager with registry access';
  else if(c.id.endsWith('npm-lock')) {
    try {
      const pkg=JSON.parse(readFileSync(manifest,'utf8'));
      const data=JSON.parse(readFileSync(lock,'utf8'));
      const rootPkg=data.packages?.[''];
      if(!Number.isInteger(data.lockfileVersion)||data.lockfileVersion<2||!rootPkg) reason='Invalid npm lockfile structure';
      else if(data.name!==pkg.name || rootPkg.name!==pkg.name) reason='Lockfile package name does not match manifest';
      else if(!rootPkg.version && pkg.version) reason='Lockfile root version missing';
      else if(Object.keys(data.packages).length<2) reason='Lockfile has no resolved package entries';
      else if(!Object.values(data.packages).some(x=>x && x.resolved && x.integrity)) reason='Lockfile lacks resolved integrity-checked packages';
      else if(!['dependencies','devDependencies','optionalDependencies'].every(key=>{
        const actual=rootPkg[key]||{}, expected=pkg[key]||{};
        return Object.keys(actual).length===Object.keys(expected).length && Object.entries(expected).every(([name,range])=>actual[name]===range);
      })) reason='Lockfile root dependencies do not match manifest';
    }catch { reason='Invalid lockfile or manifest JSON'; }
  } else {
    const content=readFileSync(lock,'utf8');
    if(!/^packages:\s*$/m.test(content) || !/^sdks:\s*$/m.test(content) || !/^\s+sha256:\s*[a-fA-F0-9]{64}\s*$/m.test(content)) reason='Flutter lockfile lacks package, SDK or SHA256 integrity data';
  }
  const status=reason?'BLOCKED':'PASS';
  if(reason)failures++;
  console.log(`${status.padEnd(7)} ${c.id}: ${reason||'Lockfile present and basic structure verified'}`);
}
if(failures)process.exitCode=1;
