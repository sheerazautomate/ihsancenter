#!/usr/bin/env node
/**
 * Reset the local database — safely.
 *
 * `wrangler d1 execute --local` and the dev server share one SQLite file under
 * `.wrangler/state`. Deleting that file while `wrangler dev` is running leaves the
 * server holding a path that no longer exists: every query then fails with
 *
 *     SQLITE_CANTOPEN: unable to open database file
 *
 * which surfaces as a 500 on login — indistinguishable, from the browser, from a
 * missing SESSION_SECRET. This cost real debugging time, so the reset now refuses to
 * run while the API is up rather than silently putting the shop in that state.
 *
 *   npm run db:reset:local
 *   npm run db:reset:local -- --force    # proceed anyway
 */

import { createConnection } from 'node:net';
import { rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', 'apps', 'api');
const stateDir = join(apiDir, '.wrangler', 'state', 'v3', 'd1');
const force = process.argv.includes('--force');

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const running = (await portOpen(8787)) || (await portOpen(8788));
if (running && !force) {
  console.error(
    'The API dev server is running on :8787.\n\n' +
      'Resetting now would delete the database file it has open, and every request\n' +
      'afterwards would fail with SQLITE_CANTOPEN — which looks exactly like a missing\n' +
      'SESSION_SECRET and sends you debugging the wrong thing.\n\n' +
      'Stop the dev server first, then run this again. Or use `npm run dev`, which\n' +
      'resets before starting the servers in the right order.\n\n' +
      'To proceed anyway: npm run db:reset:local -- --force',
  );
  process.exit(1);
}

if (existsSync(stateDir)) {
  rmSync(stateDir, { recursive: true, force: true });
  console.log('Removed local D1 state.');
} else {
  console.log('No local D1 state to remove.');
}

const run = (label, script) => {
  console.log(`\n→ ${label}`);
  const r = spawnSync('npm', ['run', script], { cwd: apiDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
};

run('Applying schema + seed (0001–0003)', 'db:migrate:local');
run('Loading demo data', 'db:seed:local');

console.log(
  '\nLocal database reset.\n\n' +
    'There is no user account on a fresh database. Create the manager with:\n\n' +
    "  curl -X POST http://127.0.0.1:8787/api/auth/bootstrap \\\n" +
    "    -H 'Content-Type: application/json' \\\n" +
    `    -d '{"name":"Manager","username":"manager","password":"ihsan12345"}'\n`,
);
