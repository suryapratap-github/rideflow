#!/usr/bin/env node
/** RideFlow release evidence gate. No inferred production readiness. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const runPreflight = !process.argv.includes('--skip-dependency-preflight');
const flags = new Set(process.argv.slice(2));
const checks = [];
function check(id, description, ok, evidence, blocking = true) {
  checks.push({ id, description, status: ok ? 'PASS' : 'BLOCKED', evidence, blocking });
}
for (const [id, file] of [
  ['api-manifest', 'apps/api/package.json'],
  ['dashboard-manifest', 'apps/dashboard/package.json'],
  ['flutter-manifest', 'apps/mobile/pubspec.yaml'],
  ['prisma-schema', 'apps/api/prisma/schema.prisma'],
]) {
  const path = resolve(root, file);
  let ok = existsSync(path);
  if (ok && file.endsWith('.json')) {
    try { JSON.parse(readFileSync(path, 'utf8')); } catch { ok = false; }
  }
  check(id, file, ok, ok ? 'File exists and JSON is parseable where applicable' : 'Missing or invalid file');
}
const evidenceFile = resolve(root, 'release-evidence.json');
let evidence = {};
if (existsSync(evidenceFile)) {
  try { evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')); } catch { /* invalid evidence fails closed */ }
}
// Explicit external attestations; missing proof never passes. The file is deliberately not shipped.
const required = [
  ['api-build', 'NestJS production build'],
  ['dashboard-build', 'Next.js production build'],
  ['flutter-build', 'Flutter Android/iOS build on target toolchains'],
  ['prisma-migration', 'Migrations applied to staging PostgreSQL'],
  ['database-integration', 'PostgreSQL integration tests'],
  ['payments-live', 'Payment provider sandbox and production configuration verified'],
  ['telecom-live', 'Masked calling provider integration and disconnect verified'],
  ['booking-e2e', 'Booking, dispatch, trip and cancellation E2E verified'],
  ['security-review', 'Security, authorization and secrets review signed off'],
  ['deployment-smoke', 'Deployed environment smoke test and rollback drill'],
];
for (const [id, description] of required) {
  const record = evidence[id];
  const ok = record?.passed === true && typeof record?.reference === 'string' && record.reference.trim().length > 0 && record.reference.trim().length <= 2048;
  check(id, description, ok, ok ? `Operator-supplied evidence: ${record.reference}` : 'No verified completion evidence supplied');
}
for (const [id, path] of [['api-lockfile','apps/api/package-lock.json'],['dashboard-lockfile','apps/dashboard/package-lock.json'],['flutter-lockfile','apps/mobile/pubspec.lock']]) {
  check(id, `Reproducible dependency lock: ${path}`, existsSync(resolve(root,path)), existsSync(resolve(root,path)) ? 'Lockfile exists (run dependency-preflight for consistency)' : 'Lockfile missing');
}
// Lockfile existence is insufficient: a fabricated or inconsistent lock must not clear a release blocker.
if (runPreflight) {
  const result = spawnSync(process.execPath, ['scripts/dependency-preflight.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  check('dependency-preflight', 'Dependency lockfile consistency preflight',
    result.status === 0 && !result.error,
    result.status === 0 ? 'Dependency preflight completed successfully' :
      `Preflight blocked (exit=${result.status ?? 'unavailable'}): ${(result.stderr || result.stdout || result.error?.message || '').slice(-500)}`);
}
if (flags.has('--run-offline-tests')) {
  const result = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: root, shell: true, stdio: 'pipe', encoding: 'utf8' });
  check('offline-tests', 'Offline Node test suite', result.status === 0, `exit=${result.status}; ${result.stdout.match(/# pass \d+/)?.[0] ?? 'no pass count'}; ${result.stdout.match(/# fail \d+/)?.[0] ?? 'no failure count'}`);
}
const blockers = checks.filter(c => c.blocking && c.status !== 'PASS');
const report = { project: 'RideFlow', phase: 120, readyForProduction: blockers.length === 0, checks, blockingCount: blockers.length };
if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const c of checks) console.log(`${c.status.padEnd(7)} ${c.id}: ${c.evidence}`);
  console.log(`RELEASE ${report.readyForProduction ? 'READY' : 'BLOCKED'} (${blockers.length} blockers)`);
}
if (flags.has('--output')) writeFileSync(resolve(root, 'release-readiness-report.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = blockers.length ? 1 : 0;
