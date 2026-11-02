/**
 * Atomic invariant guards.
 *
 * D1's batch() runs as ONE transaction, but a batch cannot read a result and
 * branch on it. So business invariants that depend on current data (credit limit,
 * stock availability, allocation totals) cannot be checked in application code
 * before the batch without opening a race window.
 *
 * Instead we push the check INTO the transaction as an INSERT ... SELECT against
 * tx_guard. The table has CHECK (code = 'ok'). If the condition is violated, a row
 * with a different code is inserted, the CHECK fails, and D1 rolls back the ENTIRE
 * batch. If the condition holds, the SELECT returns no rows, nothing is inserted,
 * and the batch proceeds.
 *
 * Note: `UPDATE ... WHERE qty >= ?` matching zero rows does NOT fail a batch.
 * That is why stock availability also goes through a guard, not just the UPDATE.
 */

export type GuardResult =
  | { ok: true }
  | { ok: false; code: GuardCode; detail: string };

export type GuardCode =
  | 'credit_limit_exceeded'
  | 'credit_hold'
  | 'insufficient_stock'
  | 'negative_stock_disallowed'
  | 'allocation_mismatch';

/** D1 types come from the runtime; we depend on nothing else. */
export type BatchExecutor = D1Database;

interface GuardSpec {
  code: GuardCode;
  /** SQL that returns rows ONLY when the invariant is violated. */
  violatedWhenSql: string;
  params: unknown[];
  /** Human-readable message surfaced to the UI when the guard trips. */
  message: string;
}

/**
 * Builds the guard INSERT statement. Append it to the batch as the statement
 * immediately AFTER the writes it protects (order does not matter for atomicity,
 * but keeping it last means the writes stay grouped and readable).
 */
export function guardStatement(db: D1Database, spec: GuardSpec): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO tx_guard (code, detail) SELECT ?, ? WHERE EXISTS (${spec.violatedWhenSql})`)
    .bind(spec.code, spec.message, ...spec.params);
}

/**
 * Credit limit guard.
 *
 * Violated when (current outstanding + new credit) > credit limit, with
 * credit_limit = 0 meaning "no limit set" (walk-in cash customers).
 * Pass limitOverride = true for a logged manager override.
 */
export function creditLimitGuard(args: {
  customerId: string;
  newCreditPaisa: number;
  override: boolean;
}): GuardSpec | null {
  if (args.override || args.newCreditPaisa <= 0) return null;

  return {
    code: 'credit_limit_exceeded',
    violatedWhenSql: `
      SELECT 1 FROM customers c
      WHERE c.id = ?
        AND c.credit_limit_paisa > 0
        AND (
          COALESCE((
            SELECT SUM(l.debit_paisa - l.credit_paisa)
            FROM ledger_entries l
            WHERE l.account_type = 'customer' AND l.account_id = c.id
          ), 0) + ?
        ) > c.credit_limit_paisa
    `,
    params: [args.customerId, args.newCreditPaisa],
    message: 'Credit limit would be exceeded',
  };
}

/** Credit-hold guard: blocks new credit sales for a flagged customer. */
export function creditHoldGuard(args: {
  customerId: string;
  newCreditPaisa: number;
  override: boolean;
}): GuardSpec | null {
  if (args.override || args.newCreditPaisa <= 0) return null;

  return {
    code: 'credit_hold',
    violatedWhenSql: `SELECT 1 FROM customers WHERE id = ? AND is_credit_hold = 1`,
    params: [args.customerId],
    message: 'Customer is on credit hold',
  };
}

/**
 * Stock guard for a sale line.
 *
 * `alreadySold` is the quantity of this product that earlier lines of the SAME
 * invoice will have removed, so two lines of the same product cannot jointly
 * oversell.
 */
export function stockGuard(args: {
  productId: string;
  qtyMilli: number;
  alreadySoldMilli: number;
  allowNegativeStock: boolean;
  override: boolean;
}): GuardSpec | null {
  if (args.override || args.allowNegativeStock) return null;

  return {
    code: 'insufficient_stock',
    violatedWhenSql: `SELECT 1 FROM products WHERE id = ? AND qty_on_hand_milli < ?`,
    params: [args.productId, args.qtyMilli + args.alreadySoldMilli],
    message: 'Not enough stock available',
  };
}

/**
 * A guard for any custom invariant: `violatedWhenSql` must return rows only when
 * the rule is broken. Used for "this may only happen once" checks (opening
 * balances), where the condition is a query rather than a threshold.
 */
export function customGuard(args: {
  code: GuardCode | string;
  violatedWhenSql: string;
  params: unknown[];
  message: string;
}): GuardSpec {
  return {
    code: args.code as GuardCode,
    violatedWhenSql: args.violatedWhenSql,
    params: args.params,
    message: args.message,
  };
}

/** The statements that make up a guarded write, in one batch. */
export function withGuards(
  db: D1Database,
  statements: D1PreparedStatement[],
  specs: Array<GuardSpec | null>,
): D1PreparedStatement[] {
  const guards = specs
    .filter((s): s is GuardSpec => s !== null)
    .map((spec) => guardStatement(db, spec));
  if (guards.length === 0) return statements;
  return [...statements, ...guards];
}

/**
 * Did this error come from a guard tripping?
 *
 * Note: SQLite reports the violated CHECK as its *expression* -- "CHECK constraint
 * failed: code = 'ok'" -- not the value we tried to insert. So the batch alone
 * cannot tell us WHICH invariant broke. The caller re-reads the relevant data
 * after the rollback and uses `diagnose` below to name the cause. The database is
 * unchanged by definition (the batch rolled back), so the re-read is authoritative.
 */
export function isGuardFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("CHECK constraint failed") && message.includes("code = 'ok'");
}

/** Called only after a guard failure, to explain it. */
export interface SaleDiagnosisInput {
  customerId: string;
  creditPaisa: number;
  lines: Array<{ productId: string; productName: string; qtyMilli: number }>;
}

export async function diagnoseSaleFailure(
  db: D1Database,
  input: SaleDiagnosisInput,
): Promise<{ code: GuardCode; detail: string }> {
  // 1. stock, aggregated per product (two lines of the same product must sum)
  const needed = new Map<string, { name: string; qty: number }>();
  for (const line of input.lines) {
    const prev = needed.get(line.productId);
    needed.set(line.productId, {
      name: line.productName,
      qty: (prev?.qty ?? 0) + line.qtyMilli,
    });
  }

  for (const [productId, want] of needed) {
    const row = await db
      .prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(productId)
      .first<{ q: number }>();
    const have = row?.q ?? 0;
    if (have < want.qty) {
      return {
        code: 'insufficient_stock',
        detail: `Not enough stock for ${want.name}: available ${have / 1000}, requested ${want.qty / 1000}`,
      };
    }
  }

  // 2. credit hold, then limit
  if (input.creditPaisa > 0) {
    const customer = await db
      .prepare(
        `SELECT c.name, c.credit_limit_paisa, c.is_credit_hold,
                COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                           WHERE l.account_type='customer' AND l.account_id=c.id), 0) AS outstanding
         FROM customers c WHERE c.id = ?`,
      )
      .bind(input.customerId)
      .first<{ name: string; credit_limit_paisa: number; is_credit_hold: number; outstanding: number }>();

    if (customer) {
      if (customer.is_credit_hold === 1) {
        return { code: 'credit_hold', detail: `${customer.name} is on credit hold` };
      }
      if (
        customer.credit_limit_paisa > 0 &&
        customer.outstanding + input.creditPaisa > customer.credit_limit_paisa
      ) {
        return {
          code: 'credit_limit_exceeded',
          detail:
            `Credit limit exceeded for ${customer.name}: ` +
            `limit ${customer.credit_limit_paisa / 100}, outstanding ${customer.outstanding / 100}, ` +
            `this sale on credit ${input.creditPaisa / 100}`,
        };
      }
    }
  }

  return { code: 'insufficient_stock', detail: 'A business rule blocked this sale' };
}
