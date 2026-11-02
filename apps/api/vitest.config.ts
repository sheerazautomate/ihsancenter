import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        // Single worker so D1 state is shared and deterministic across tests.
        singleWorker: true,
        // The suite is written as a sequence (later tests assert on state built by
        // earlier ones), so storage must persist across tests in a file.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: '2024-12-18',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
        },
      },
    },
  },
});
