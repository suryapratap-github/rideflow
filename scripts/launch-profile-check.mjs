#!/usr/bin/env node
/** Validates non-secret owner launch configuration; does not infer live verification. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path = resolve(import.meta.dirname, '..', 'launch-profile.json');
let p;
try { p = JSON.parse(readFileSync(path, 'utf8')); } catch { p = {}; }
const checks = [];
const add = (id, passed, action) => checks.push({id, status: passed ? 'PASS' : 'BLOCKED', action});
const validHttps = s => { try { const u = new URL(s); return u.protocol === 'https:' && u.origin === s && !/localhost|example\.com/i.test(u.hostname); } catch { return false; } };
add('hosting-provider', typeof p.hosting?.provider === 'string' && p.hosting.provider.trim().length > 1, 'Name the hosting company/platform');
add('staging-url', validHttps(p.hosting?.stagingUrl), 'Provide HTTPS staging URL');
add('production-url', validHttps(p.hosting?.productionUrl), 'Provide HTTPS production URL (domain required before launch)');
add('database-staging', p.database?.provisioned === true && p.database?.stagingDatabaseConfirmed === true, 'Confirm isolated staging PostgreSQL database; do not share credentials');
add('database-recovery', p.database?.backupRestoreTested === true, 'Verify backup and restore on staging');
add('payment-provider', typeof p.payments?.provider === 'string' && p.payments.provider.trim().length > 1, 'Identify payment provider');
add('payment-verification', p.payments?.sandboxVerified === true && p.payments?.productionVerified === true, 'Verify provider webhooks, payments, refunds and settlement');
add('stripe-connect-driver-payouts', p.payments?.driverPayouts?.platformApprovalConfirmed === true && p.payments?.driverPayouts?.supportedChargeModelConfirmed === true && p.payments?.driverPayouts?.sandboxPayoutVerified === true && p.payments?.driverPayouts?.productionPayoutVerified === true, 'Obtain Stripe India written platform approval and verify supported automatic driver payouts end-to-end');
add('sms-provider', typeof p.smsOtp?.provider === 'string' && p.smsOtp.provider.trim().length > 1, 'Identify SMS/OTP provider');
add('sms-verification', p.smsOtp?.sandboxVerified === true && p.smsOtp?.productionVerified === true, 'Verify delivery, rate limiting and OTP flows');
add('masked-calling', p.maskedCalling?.enabledForLaunch === true ? Boolean(p.maskedCalling?.provider) : p.maskedCalling?.featureDisabledAndTested === true, 'Either provision and verify masked calling, or prove it is disabled end-to-end for initial launch');
add('signed-apps', p.appStores?.signedBuildsVerified === true, 'Build, sign and test Android/iOS release artifacts');
add('pilot-city', typeof p.pilotCity === 'string' && p.pilotCity.trim().length > 1, 'Choose operational pilot city and dispatch coverage');
const blocked = checks.filter(c => c.status === 'BLOCKED');
const report = {phase:127, launchProfileComplete:blocked.length === 0, blockingCount:blocked.length, checks};
console.log(process.argv.includes('--json') ? JSON.stringify(report,null,2) : checks.map(c=>`${c.status} ${c.id}: ${c.action}`).join('\n') + `\nLAUNCH PROFILE ${blocked.length ? 'INCOMPLETE' : 'COMPLETE'} (${blocked.length} blockers)`);
if (blocked.length) process.exitCode = 1;
