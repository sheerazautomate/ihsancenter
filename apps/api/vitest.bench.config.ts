import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/** Runs only the micro-benchmarks, in the real Workers runtime. */
export default defineWorkersConfig({
  test: {
    include: ['bench/**/*.test.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: { compatibilityDate: '2024-12-18', compatibilityFlags: ['nodejs_compat'] },
      },
    },
  },
});
