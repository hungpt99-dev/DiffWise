import type { Payment } from '../payments/PaymentService';

export interface PaymentRepository {
  findById(id: string): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
  update(payment: Payment): Promise<void>;
  recordRefund(paymentId: string, amountCents: number, reference: string): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  withTransaction<T>(work: (tx: PaymentRepository) => Promise<T>): Promise<T>;
}

/** Thin adapter over `pg`. Real deployments inject a pooled client. */
export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {}

  async findById(id: string): Promise<Payment | null> {
    const rows = await this.query<Payment>('SELECT * FROM payments WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ?? null;
  }

  async save(payment: Payment): Promise<void> {
    await this.query(
      'INSERT INTO payments (id, customer_id, amount_cents, currency, status, fee_cents, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [payment.id, payment.customerId, payment.amountCents, payment.currency, payment.status, payment.feeCents, payment.createdAt],
    );
  }

  async update(payment: Payment): Promise<void> {
    await this.query('UPDATE payments SET status = $1, amount_cents = $2 WHERE id = $3', [payment.status, payment.amountCents, payment.id]);
  }

  async recordRefund(paymentId: string, amountCents: number, reference: string): Promise<void> {
    await this.query('INSERT INTO refunds (payment_id, amount_cents, reference) VALUES ($1,$2,$3)', [paymentId, amountCents, reference]);
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async withTransaction<T>(work: (tx: PaymentRepository) => Promise<T>): Promise<T> {
    const client = this.pool as unknown as { connect?: () => Promise<unknown> };
    void client;
    return work(this);
  }
}
