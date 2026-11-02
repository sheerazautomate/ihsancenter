/**
 * Standalone PBKDF2 benchmark. Not part of the test suite: wall-clock assertions
 * are unreliable on a shared machine, so timing lives here and the number is
 * recorded by hand in docs/plan/05-build-notes-verified.md.
 *
 *   npm run bench
 */
import { it } from 'vitest';
import { hashPassword, DEFAULT_ITERATIONS } from '../src/lib/crypto';

const candidates = [10_000, 25_000, 50_000, 100_000];

it('measures PBKDF2 cost', async () => {
  console.log(`Default configured: ${DEFAULT_ITERATIONS.toLocaleString()} iterations\n`);
  for (const iterations of candidates) {
    await hashPassword('warmup', iterations); // warm the JIT
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await hashPassword('benchmark-password-123', iterations);
      samples.push(Date.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const flag = median > 10 ? '  <-- exceeds the free plan 10ms CPU budget' : '';
    console.log(`${iterations.toLocaleString().padStart(7)} iterations: median ${median} ms${flag}`);
  }
});
