/**
 * Opening balances — the cutover entry.
 *
 * When a shop moves off paper, three things already exist that the system has never
 * seen: what customers owe, what the shop owes the companies, and what is on the
 * shelf. Those must enter once, on a stated date, and balance.
 *
 * Double entry makes the balancing figure meaningful: net assets minus liabilities
 * is the owner's capital, so the difference posts to equity rather than being
 * parked in a "suspense" account nobody ever clears.
 *
 *     Dr  Receivable (customers)      Dr  Cash / Bank
 *     Dr  Inventory (opening stock)       Cr  Payable (companies)
 *                                         Cr  Capital (the balancing figure)
 *
 * Sign convention, chosen so the screen reads naturally:
 *   customers  positive = the customer owes the shop (debit)
 *              negative = the shop owes the customer, i.e. an advance (credit)
 *   suppliers  positive = the shop owes the company (credit)
 *              negative = the company owes the shop (debit)
 *   cash       positive = money in the drawer / bank (debit)
 *              negative = overdrawn (credit)
 *   stock      quantity + unit cost, always an asset
 */

import { newId } from './ids';
import { buildLedgerRows, type LedgerLine, ledgerInsertStatements } from './ledger';
import { customGuard, isGuardFailure, withGuards } from './guard';

export interface OpeningInput {
  docDate: string;
  customers?: Array<{ customerId: string; amountPaisa: number }>;
  suppliers?: Array<{ companyId: string; amountPaisa: number }>;
  cash?: Array<{ cashAccountId: string; amountPaisa: number }>;
  stock?: Array<{ productId: string; qtyMilli: number; unitCostPaisa: number }>;
  notes?: string;
  userId?: string;
}

export interface OpeningResult {
  ok: true;
  posted: {
    customers: number;
    suppliers: number;
    cash: number;
    stock: number;
  };
  totals: {
    receivablePaisa: number;
    cashPaisa: number;
    inventoryPaisa: number;
    payablePaisa: number;
    /**
     * The owner's stake, signed the way a balance sheet reads it: positive = the
     * shop is worth something to its owner (capital is a credit), negative =
     * liabilities exceed assets (capital is a debit).
     */
    capitalPaisa: number;
  };
}

export type PostOpeningResult = OpeningResult | { ok: false; error: string; code?: string };

export async function postOpeningBalances(
  db: D1Database,
  input: OpeningInput,
): Promise<PostOpeningResult> {
  const customers = (input.customers ?? []).filter((c) => c.amountPaisa !== 0);
  const suppliers = (input.suppliers ?? []).filter((s) => s.amountPaisa !== 0);
  const cash = (input.cash ?? []).filter((c) => c.amountPaisa !== 0);
  const stock = (input.stock ?? []).filter((s) => s.qtyMilli > 0);

  if (customers.length + suppliers.length + cash.length + stock.length === 0) {
    return { ok: false, error: 'Nothing to post' };
  }

  for (const c of [...customers, ...suppliers, ...cash]) {
    if (!Number.isInteger(c.amountPaisa)) {
      return { ok: false, error: 'Amounts must be whole paisa' };
    }
  }
  for (const s of stock) {
    if (!Number.isInteger(s.qtyMilli) || s.qtyMilli <= 0) {
      return { ok: false, error: 'Stock quantities must be positive' };
    }
    if (!Number.isInteger(s.unitCostPaisa) || s.unitCostPaisa < 0) {
      return { ok: false, error: 'Stock cost must be zero or more' };
    }
  }

  // ---------- verify every referenced record exists ----------
  const ids = {
    customers: customers.map((c) => c.customerId),
    suppliers: suppliers.map((s) => s.companyId),
    cash: cash.map((c) => c.cashAccountId),
    products: stock.map((s) => s.productId),
  };

  const check = async (table: string, list: string[]): Promise<Set<string>> => {
    if (list.length === 0) return new Set();
    const rows = await db
      .prepare(`SELECT id FROM ${table} WHERE id IN (${list.map(() => '?').join(', ')})`)
      .bind(...list)
      .all<{ id: string }>();
    return new Set((rows.results ?? []).map((r) => r.id));
  };

  const [
    validCustomers,
    validCompanies,
    validCash,
    validProducts,
  ] = await Promise.all([
    check('customers', ids.customers),
    check('companies', ids.suppliers),
    check('cash_accounts', ids.cash),
    check('products', ids.products),
  ]);

  for (const c of customers) {
    if (!validCustomers.has(c.customerId)) return { ok: false, error: `Customer not found: ${c.customerId}` };
  }
  for (const s of suppliers) {
    if (!validCompanies.has(s.companyId)) return { ok: false, error: `Company not found: ${s.companyId}` };
  }
  for (const c of cash) {
    if (!validCash.has(c.cashAccountId)) return { ok: false, error: `Cash account not found: ${c.cashAccountId}` };
  }
  for (const s of stock) {
    if (!validProducts.has(s.productId)) return { ok: false, error: `Product not found: ${s.productId}` };
  }

  const now = new Date().toISOString();
  const batchId = newId('opn');

  // ---------- build the ledger ----------
  const lines: LedgerLine[] = [];
  const guardSpecs = [];

  const signed = (amount: number) => ({
    debitPaisa: amount > 0 ? amount : 0,
    creditPaisa: amount < 0 ? -amount : 0,
  });

  let totalReceivable = 0;
  for (const c of customers) {
    lines.push({
      accountType: 'customer',
      accountId: c.customerId,
      ...signed(c.amountPaisa),
      memo: 'Opening balance',
    });
    totalReceivable += c.amountPaisa;
    guardSpecs.push(openingGuard('customer', c.customerId));
  }

  let totalPayable = 0;
  for (const s of suppliers) {
    // positive payable = credit (the shop owes)
    lines.push({
      accountType: 'supplier',
      accountId: s.companyId,
      ...signed(-s.amountPaisa),
      memo: 'Opening balance',
    });
    totalPayable += s.amountPaisa;
    guardSpecs.push(openingGuard('supplier', s.companyId));
  }

  let totalCash = 0;
  for (const c of cash) {
    lines.push({
      accountType: 'cash',
      accountId: c.cashAccountId,
      ...signed(c.amountPaisa),
      memo: 'Opening balance',
    });
    totalCash += c.amountPaisa;
    guardSpecs.push(openingGuard('cash', c.cashAccountId));
  }

  let totalInventory = 0;
  for (const s of stock) {
    const value = Math.round((s.qtyMilli * s.unitCostPaisa) / 1000);
    totalInventory += value;
  }
  if (totalInventory > 0) {
    lines.push({
      accountType: 'inventory',
      accountId: null,
      debitPaisa: totalInventory,
      creditPaisa: 0,
      memo: 'Opening stock',
    });
  }

  // ---------- the balancing figure goes to capital ----------
  const netDebits = totalReceivable + totalCash + totalInventory - totalPayable;
  if (netDebits !== 0) {
    lines.push({
      accountType: 'equity',
      accountId: null,
      debitPaisa: netDebits < 0 ? -netDebits : 0,
      creditPaisa: netDebits > 0 ? netDebits : 0,
      memo: 'Opening capital',
    });
  }

  if (lines.length === 0) {
    return { ok: false, error: 'Opening balances net to zero — nothing to post' };
  }

  // ---------- statements ----------
  const statements: D1PreparedStatement[] = [];

  for (const s of stock) {
    statements.push(
      db
        .prepare(
          `UPDATE products SET qty_on_hand_milli = qty_on_hand_milli + ?,
             avg_cost_paisa = ?, purchase_rate_paisa = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(s.qtyMilli, s.unitCostPaisa, s.unitCostPaisa, now, s.productId),
    );

    const row = await db
      .prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(s.productId)
      .first<{ q: number }>();

    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, note, created_at)
           VALUES (?, ?, ?, 'opening', ?, ?, 'opening', ?, ?, 'Opening stock', ?)`,
        )
        .bind(
          newId('sm'),
          s.productId,
          input.docDate,
          s.qtyMilli,
          s.unitCostPaisa,
          batchId,
          (row?.q ?? 0) + s.qtyMilli,
          now,
        ),
    );

    // one opening stock movement per product, ever
    guardSpecs.push(
      customGuard({
        code: 'opening_already_posted',
        violatedWhenSql: `SELECT 1 FROM stock_movements WHERE product_id = ? AND type = 'opening'`,
        params: [s.productId],
        message: 'Opening stock has already been entered for this product',
      }),
    );
  }

  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'opening',
        docId: batchId,
        lines,
        now,
      }),
    ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'opening', ?, ?)`,
      )
      .bind(
        newId('al'),
        now,
        input.userId ?? null,
        batchId,
        JSON.stringify({
          customers: customers.length,
          suppliers: suppliers.length,
          cash: cash.length,
          stock: stock.length,
          netDebits,
          notes: input.notes ?? null,
        }),
      ),
  );

  // ---------- an account may only be opened once ----------
  // Guards must come FIRST: a D1 batch runs its statements in order, so a guard
  // appended after the inserts would see the rows it is supposed to reject and
  // fail every submission. Running it first also means a rejected attempt writes
  // nothing at all.
  const guarded = [
    ...withGuards(db, [], guardSpecs),
    ...statements,
  ];

  try {
    await db.batch(guarded);
  } catch (err) {
    if (isGuardFailure(err)) {
      const already = await findDuplicateOpening(db, customers, suppliers, cash, stock);
      return {
        ok: false,
        error:
          already ?? 'Opening balances have already been entered for one of these accounts.',
        code: 'opening_already_posted',
      };
    }
    throw err;
  }

  return {
    ok: true,
    posted: {
      customers: customers.length,
      suppliers: suppliers.length,
      cash: cash.length,
      stock: stock.length,
    },
    totals: {
      receivablePaisa: totalReceivable,
      cashPaisa: totalCash,
      inventoryPaisa: totalInventory,
      payablePaisa: totalPayable,
      // netDebits is assets - liabilities, which is equity: negative means the shop
      // owes more than it holds. `|| 0` keeps a balanced entry from producing -0.
      capitalPaisa: netDebits || 0,
    },
  };
}

function openingGuard(accountType: string, accountId: string) {
  return customGuard({
    code: 'opening_already_posted',
    violatedWhenSql: `SELECT 1 FROM ledger_entries
                      WHERE doc_type = 'opening' AND account_type = ? AND account_id = ?`,
    params: [accountType, accountId],
    message: 'Opening balance has already been entered for this account',
  });
}

/** After a rollback, work out which account already had an opening entry. */
async function findDuplicateOpening(
  db: D1Database,
  customers: Array<{ customerId: string }>,
  suppliers: Array<{ companyId: string }>,
  cash: Array<{ cashAccountId: string }>,
  stock: Array<{ productId: string }>,
): Promise<string | null> {
  const candidate = async (accountType: string, accountId: string, label: string) => {
    const row = await db
      .prepare(
        `SELECT 1 AS x FROM ledger_entries
         WHERE doc_type = 'opening' AND account_type = ? AND account_id = ? LIMIT 1`,
      )
      .bind(accountType, accountId)
      .first<{ x: number }>();
    return row ? `Opening balance already entered for ${label}.` : null;
  };

  for (const c of customers) {
    const hit = await candidate('customer', c.customerId, 'a customer in this list');
    if (hit) return hit;
  }
  for (const s of suppliers) {
    const hit = await candidate('supplier', s.companyId, 'a company in this list');
    if (hit) return hit;
  }
  for (const c of cash) {
    const hit = await candidate('cash', c.cashAccountId, 'a cash account in this list');
    if (hit) return hit;
  }
  for (const s of stock) {
    const row = await db
      .prepare(`SELECT 1 AS x FROM stock_movements WHERE product_id = ? AND type = 'opening' LIMIT 1`)
      .bind(s.productId)
      .first<{ x: number }>();
    if (row) return 'Opening stock already entered for a product in this list.';
  }
  return null;
}

// ============ reads ============

export interface OpeningState {
  posted: boolean;
  firstOpeningDate: string | null;
  customers: Array<{ id: string; name: string; phone: string | null; amountPaisa: number }>;
  suppliers: Array<{ id: string; name: string; amountPaisa: number }>;
  cash: Array<{ id: string; name: string; type: string; amountPaisa: number }>;
  stock: Array<{
    id: string;
    name: string;
    companyName: string;
    qtyMilli: number;
    unitCostPaisa: number;
  }>;
  totals: {
    receivablePaisa: number;
    payablePaisa: number;
    cashPaisa: number;
    inventoryPaisa: number;
  };
}

/** What has already been opened, so the screen can show and grey out existing rows. */
export async function getOpeningState(db: D1Database): Promise<OpeningState> {
  const customers = await db
    .prepare(
      `SELECT c.id, c.name, c.phone,
              COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                        WHERE l.account_type='customer' AND l.account_id=c.id
                          AND l.doc_type='opening'), 0) AS amountPaisa
       FROM customers c WHERE c.is_active = 1 AND c.type <> 'walkin'
       ORDER BY c.name`,
    )
    .all<{ id: string; name: string; phone: string | null; amountPaisa: number }>();

  const suppliers = await db
    .prepare(
      `SELECT co.id, co.name,
              COALESCE((SELECT SUM(l.credit_paisa - l.debit_paisa) FROM ledger_entries l
                        WHERE l.account_type='supplier' AND l.account_id=co.id
                          AND l.doc_type='opening'), 0) AS amountPaisa
       FROM companies co WHERE co.is_active = 1 ORDER BY co.name`,
    )
    .all<{ id: string; name: string; amountPaisa: number }>();

  const cash = await db
    .prepare(
      `SELECT a.id, a.name, a.type,
              COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                        WHERE l.account_type='cash' AND l.account_id=a.id
                          AND l.doc_type='opening'), 0) AS amountPaisa
       FROM cash_accounts a WHERE a.is_active = 1 ORDER BY a.type DESC, a.name`,
    )
    .all<{ id: string; name: string; type: string; amountPaisa: number }>();

  const stock = await db
    .prepare(
      `SELECT p.id, p.name, co.name AS companyName,
              COALESCE((SELECT SUM(m.qty_change_milli) FROM stock_movements m
                        WHERE m.product_id=p.id AND m.type='opening'), 0) AS qtyMilli,
              p.avg_cost_paisa AS unitCostPaisa
       FROM products p JOIN companies co ON co.id = p.company_id
       WHERE p.is_active = 1
       ORDER BY co.name, p.name`,
    )
    .all<{ id: string; name: string; companyName: string; qtyMilli: number; unitCostPaisa: number }>();

  const first = await db
    .prepare(`SELECT MIN(entry_date) AS d FROM ledger_entries WHERE doc_type = 'opening'`)
    .first<{ d: string | null }>();

  const c = customers.results ?? [];
  const s = suppliers.results ?? [];
  const ca = cash.results ?? [];
  const st = stock.results ?? [];

  return {
    posted: !!first?.d,
    firstOpeningDate: first?.d ?? null,
    customers: c,
    suppliers: s,
    cash: ca,
    stock: st,
    totals: {
      receivablePaisa: c.reduce((sum, r) => sum + r.amountPaisa, 0),
      payablePaisa: s.reduce((sum, r) => sum + r.amountPaisa, 0),
      cashPaisa: ca.reduce((sum, r) => sum + r.amountPaisa, 0),
      inventoryPaisa: st.reduce(
        (sum, r) => sum + Math.round((r.qtyMilli * r.unitCostPaisa) / 1000),
        0,
      ),
    },
  };
}
