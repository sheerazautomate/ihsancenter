#!/usr/bin/env node
/**
 * Generate a password hash the API will accept, for the "the manager forgot the
 * password" case. There is no reset email: the password is one row in one table,
 * and this produces the value to put in that row.
 *
 * The hash format must match `apps/api/src/lib/crypto.ts` exactly:
 *
 *     <salt hex>:<pbkdf2-sha256 hex>      plus a separate iteration count
 *
 * Using Node's WebCrypto rather than reimplementing PBKDF2, so the two can never
 * drift in a way that silently produces hashes that never verify.
 *
 *   node scripts/hash-password.mjs 'the-new-password'
 *   node scripts/hash-password.mjs 'the-new-password' --iterations 25000
 *
 * Prints a ready-to-run SQL statement.
 */

import { webcrypto as crypto } from 'node:crypto';

const args = process.argv.slice(2);
const password = args.find((a) => !a.startsWith('--') && !isNumber(a));
const iterationsArg = args.indexOf('--iterations');
const iterations = iterationsArg >= 0 ? Number(args[iterationsArg + 1]) : 25_000;

function isNumber(v) {
  return /^\d+$/.test(v);
}

if (!password) {
  console.error("Usage: node scripts/hash-password.mjs 'password' [--iterations 25000]");
  process.exit(2);
}

if (!Number.isInteger(iterations) || iterations < 10_000) {
  console.error('Iterations must be an integer >= 10000.');
  process.exit(2);
}

if (password.length < 8) {
  // A warning, not a refusal: this is a recovery tool and must not be the reason
  // someone cannot get back into their own shop.
  console.error('Warning: password is shorter than 8 characters.');
}

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(password),
  'PBKDF2',
  false,
  ['deriveBits'],
);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
  key,
  256,
);

const hash = `${toHex(salt.buffer)}:${toHex(bits)}`;

// Verify before printing. A recovery tool that emits a hash the API rejects is
// worse than no tool: it locks the shop out with no diagnostic.
const [saltHex, expected] = hash.split(':');
const check = crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
  await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  ),
  256,
);
if (toHex(await check) !== expected || saltHex !== toHex(salt.buffer)) {
  console.error('Internal error: the generated hash does not verify. Aborting.');
  process.exit(1);
}

const username = args.find((a, i) => args[i - 1] === '--user') ?? 'ihsan';

console.log(`Iterations: ${iterations}`);
console.log(`Hash:       ${hash}`);
console.log('');
console.log('Run this against the deployed database:');
console.log('');
console.log(
  `npx wrangler d1 execute ihsancenter --remote --command "UPDATE users ` +
    `SET password_hash='${hash}', iterations=${iterations}, ` +
    `token_version=token_version+1 WHERE username='${username}'"`,
);
console.log('');
console.log(
  'token_version+1 signs out every existing session, which is what you want if the\n' +
    'old password may have leaked. Check the row count in the output: if it updated\n' +
    `0 rows, no user named '${username}' exists — run POST /api/auth/bootstrap instead.`,
);
