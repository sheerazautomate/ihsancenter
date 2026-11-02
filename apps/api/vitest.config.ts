import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        // Single worker so D1 state is shared and deterministic across tests.
        singleWorker: true,
        // Needed for the SELF service binding used by the HTTP tests.
        main: './src/index.ts',
        // Each test gets its own storage snapshot, rolled back afterwards. Every
        // test creates the fixtures it needs in beforeEach, so no test can be
        // broken by another file's cleanup -- which is what happened when all
        // files shared one database.
        isolatedStorage: true,
        miniflare: {
          compatibilityDate: '2024-12-18',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: {
            SESSION_SECRET: 'test-secret-not-used-in-production',
            ENVIRONMENT: 'test',
            ALLOWED_ORIGINS: 'http://localhost:5173',
          },
        },
      },
    },
  },
});
