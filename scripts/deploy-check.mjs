#!/usr/bin/env node
/**
 * Deployment preflight.
 *
 * Every failure this checks has actually cost someone a deploy, and the two that
 * matter most fail *quietly*: a placeholder `database_id` deploys a Worker that
 * points at nothing, and a missing `SESSION_SECRET` deploys a Worker where login
 * returns a 500 that the error handler deliberately disguises. Both look like a
 * successful deploy from the terminal.
 *
 * Run it before `wrangler deploy`. Exit code 0 = safe to deploy.
 *
 *   npm run deploy:check            # checks production config
 *   npm run deploy:check -- --live  # also curls the deployed host
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', 'apps', 'api');
const webDist = join(apiDir, '..', 'web', 'dist');

const problems = [];
const warnings = [];
const passes = [];

const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);
const pass = (msg) => passes.push(msg);

// ---------------------------------------------------------------- wrangler.toml
const tomlPath = join(apiDir, 'wrangler.toml');
if (!existsSync(tomlPath)) {
  fail('apps/api/wrangler.toml is missing.');
} else {
  const toml = readFileSync(tomlPath, 'utf8');

  const idMatch = toml.match(/database_id\s*=\s*"([^"]*)"/);
  if (!idMatch) {
    fail('wrangler.toml has no database_id. Run `npx wrangler d1 create ihsancenter`.');
  } else if (/REPLACE|YOUR_DATABASE/i.test(idMatch[1]) || idMatch[1].length < 30) {
    fail(
      'database_id is still a placeholder. Run `npx wrangler d1 create ihsancenter` ' +
        'and paste the id it prints into apps/api/wrangler.toml.',
    );
  } else {
    pass(`database_id looks real (${idMatch[1].slice(0, 8)}…)`);
  }

  if (/^\s*\[\[d1_databases\]\]/m.test(toml) && !/database_name\s*=\s*"ihsancenter"/.test(toml)) {
    warn('database_name is not "ihsancenter" — the npm scripts assume that name.');
  }

  // Single origin is what makes session cookies work in production.
  if (/^\s*\[assets\]/m.test(toml)) {
    const dirMatch = toml.match(/directory\s*=\s*"([^"]*)"/);
    if (dirMatch && dirMatch[1] !== '../web/dist') {
      warn(`[assets] directory is "${dirMatch[1]}", expected "../web/dist".`);
    } else {
      pass('[assets] configured — the Worker serves the SPA and the API from one origin');
    }
    if (!/not_found_handling\s*=\s*"single-page-application"/.test(toml)) {
      fail(
        'not_found_handling must be "single-page-application", or every hard refresh ' +
          'on /reports, /opening, etc. returns 404.',
      );
    }
  } else {
    fail('No [assets] block: the SPA would not be served, and /api cookies would be cross-site.');
  }

  // Secrets must never be in the committed toml.
  if (/SESSION_SECRET\s*=/.test(toml)) {
    fail(
      'SESSION_SECRET is written in wrangler.toml. Remove it and use ' +
        '`npx wrangler secret put SESSION_SECRET`.',
    );
  } else {
    pass('no secret in wrangler.toml (use `wrangler secret put`)');
  }
}

// ---------------------------------------------------------------- web build
if (!existsSync(webDist)) {
  fail('apps/web/dist does not exist. Run `npm run build --workspace @ihsan/web` first.');
} else {
  const index = join(webDist, 'index.html');
  if (!existsSync(index)) {
    fail('apps/web/dist exists but has no index.html — the build did not finish.');
  } else {
    const builtAt = statSync(index).mtime;
    const apiSrc = join(apiDir, 'src');
    const newestSrc = newestMtime(apiSrc);
    pass(`SPA build found (${(statSync(index).size / 1024).toFixed(1)} kB index.html)`);
    if (newestSrc && builtAt < newestSrc) {
      warn('apps/web/dist is older than the API source. Rebuild before deploying.');
    }
    const assets = join(webDist, 'assets');
    if (!existsSync(assets)) fail('apps/web/dist/assets is missing.');

    // A build left pointing at localhost would break the deployed app in a way
    // that only shows up in the browser.
    for (const f of listFiles(webDist).filter((f) => f.endsWith('.js'))) {
      const body = readFileSync(f, 'utf8');
      if (body.includes('localhost:8787') || body.includes('127.0.0.1:8787')) {
        fail(`${f} contains a hardcoded localhost API URL — it will fail in production.`);
      }
    }
  }
}

// ---------------------------------------------------------------- migrations
const migrationsDir = join(apiDir, 'migrations');
if (!existsSync(migrationsDir)) {
  fail('apps/api/migrations is missing.');
} else {
  const files = listFiles(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const expected = ['0001_init.sql', '0002_seed.sql', '0003_auth_and_idempotency.sql'];
  for (const e of expected) {
    if (!files.some((f) => f.endsWith(e))) fail(`missing migration ${e}`);
  }
  // Guard the real hazard: demo data must never sit in the migrations directory,
  // where a wildcard would apply it to live books.
  const demo = files.filter((f) => /demo/i.test(f));
  if (demo.length) {
    fail(
      `demo/seed SQL found inside migrations/ (${demo.map((f) => f.split('/').pop()).join(', ')}). ` +
        'Move it out — it would invent fake customers and stock in production.',
    );
  }
  // A migration that cannot be re-run makes a half-finished deploy unrecoverable.
  for (const f of files) {
    // Strip `--` comments first: a note *about* ALTER TABLE is not an ALTER TABLE.
    const body = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    if (/ALTER TABLE/i.test(body)) {
      warn(
        `${f.split('/').pop()} contains ALTER TABLE, which cannot be re-run. ` +
          'If it fails midway, the database needs manual repair.',
      );
    }
  }
  pass(`${files.length} migration files, no demo data among them`);
}

// ---------------------------------------------------------------- --live
if (process.argv.includes('--live')) {
  const url = process.argv[process.argv.indexOf('--live') + 1];
  if (!url || url.startsWith('-')) {
    fail('--live needs the deployed URL, e.g. --live https://ihsancenter-api.example.workers.dev');
  } else {
    for (const [path, expect] of [
      ['/health', 200],
      ['/api/auth/me', 401],
      ['/', 200],
    ]) {
      try {
        const res = await fetch(new URL(path, url), { redirect: 'manual' });
        if (res.status === expect) pass(`GET ${path} → ${res.status}`);
        else fail(`GET ${path} → ${res.status}, expected ${expect}`);
      } catch (e) {
        fail(`GET ${url}${path} failed: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- report
for (const p of passes) console.log(`  ok    ${p}`);
for (const w of warnings) console.log(`  warn  ${w}`);
for (const p of problems) console.log(`  FAIL  ${p}`);

console.log('');
if (problems.length) {
  console.log(`Not safe to deploy: ${problems.length} problem(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`Preflight passed (${warnings.length} warning(s)). Safe to deploy.`);

// ---------------------------------------------------------------- helpers
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSafe(d)) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const f of listFiles(dir)) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* ignore */
    }
  }
  return newest;
}
