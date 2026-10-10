#!/usr/bin/env node
/** Non-destructive production deployment preflight. Never prints secrets. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const env = process.env;
const checks = [];
function check(id, pass, detail) { checks.push({ id, status: pass ? 'PASS' : 'BLOCKED', detail }); }
check('production-mode', env.NODE_ENV === 'production', 'NODE_ENV must equal production');
check('jwt-secret', typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length >= 32 && !/replace|development|demo|change.me/i.test(env.JWT_SECRET), 'Set a unique random JWT_SECRET of at least 32 characters');
check('otp-secret', typeof env.OTP_HASH_SECRET === 'string' && env.OTP_HASH_SECRET.length >= 32 && !/replace|development|demo|change.me/i.test(env.OTP_HASH_SECRET), 'Set a separate random OTP_HASH_SECRET of at least 32 characters');
check('otp-dev-disabled', env.DEV_OTP_ENABLED !== 'true', 'Development OTP must be disabled');
check('database-url', /^postgres(?:ql)?:\/\//.test(env.DATABASE_URL ?? '') && !/localhost|127\.0\.0\.1|rideflow_local|placeholder/i.test(env.DATABASE_URL ?? ''), 'Set a production PostgreSQL DATABASE_URL (not local/demo)');
const origins = (env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
check('cors-origins', origins.length > 0 && origins.every(s => { try { const u = new URL(s); return u.protocol === 'https:' && u.origin === s && !/localhost|example\.com/i.test(u.hostname); } catch { return false; } }), 'Set explicit HTTPS CORS_ORIGINS for real domains');
const migrations = resolve(root, 'apps/api/prisma/migrations');
check('prisma-migrations', existsSync(migrations) && (await import('node:fs')).readdirSync(migrations).some(n => /^\d.*_/.test(n)), 'No Prisma migration history found; create and review baseline migration before deploy');
const evidencePath = resolve(root, 'release-evidence.json');
let evidence = {};
try { if (existsSync(evidencePath)) evidence = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch { /* fail closed */ }
for (const id of ['api-build','dashboard-build','flutter-build','prisma-migration','database-integration','payments-live','telecom-live','booking-e2e','security-review','deployment-smoke']) {
 const entry = evidence[id];
 check(`evidence-${id}`, entry?.passed === true && typeof entry?.reference === 'string' && entry.reference.trim().length > 0, `Verified operator evidence required: ${id}`);
}
const blocked = checks.filter(c => c.status !== 'PASS');
const report = { phase: 123, readyForProduction: blocked.length === 0, blockingCount: blocked.length, checks };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else { for (const c of checks) console.log(`${c.status} ${c.id}: ${c.detail}`); console.log(`PRODUCTION DEPLOY ${blocked.length ? 'BLOCKED' : 'PREFLIGHT PASSED'} (${blocked.length} blockers)`); }
process.exitCode = blocked.length ? 1 : 0;
