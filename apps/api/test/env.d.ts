/// <reference types="@cloudflare/vitest-pool-workers" />

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

/** Wrangler/vite `?raw` imports used by the test setup to load migrations. */
declare module '*?raw' {
  const content: string;
  export default content;
}
