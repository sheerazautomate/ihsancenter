// Applies migrations to the test D1 database using Cloudflare's official helper.
import { env, applyD1Migrations } from 'cloudflare:test';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed.sql?raw';
import authSql from '../migrations/0003_auth_and_idempotency.sql?raw';

const DB = env.DB as D1Database;

/**
 * Split a migration file into individual statements. Safe here because none of
 * our SQL contains a semicolon inside a string literal or a trigger body.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

await applyD1Migrations(DB, [
  { name: '0001_init', queries: splitStatements(initSql) },
  { name: '0002_seed', queries: splitStatements(seedSql) },
  { name: '0003_auth_and_idempotency', queries: splitStatements(authSql) },
]);
