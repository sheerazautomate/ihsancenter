import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'ihsancenter-api', env: c.env.ENVIRONMENT }),
);

export default app;
