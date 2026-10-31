import type { PaymentRepository } from '../db/repository';
import { logger } from '../logger';
import { ValidationError } from '../domain/errors';

export interface SettlementResult {
  batchId: string;
  settled: number;
  totalCents: number;
  atomic: boolean;
}

export class SettlementService {
  constructor(private readonly repository: PaymentRepository) {}

  /**
   * Move every captured payment in a batch into the settlement ledger.
   * The batch is settled inside a transaction so a failure half way through
   * does not leave the ledger ahead of the batch.
   */
  async settleBatchAtomic(batchId: string): Promise<SettlementResult> {
    if (!batchId) throw new ValidationError('batchId is required');
    const rows = await this.repository.query<{ id: string; amount_cents: number }>(
      "SELECT id, amount_cents FROM payments WHERE status = 'captured' AND batch_id = $1",
      [batchId],
    );

    let total = 0;
    await this.repository.withTransaction(async (tx) => {
      for (const row of rows) {
        await tx.query('INSERT INTO ledger (payment_id, amount_cents) VALUES ($1,$2)', [row.id, row.amount_cents]);
        total += row.amount_cents;
      }
    });

    logger.info('settlement completed', { batchId, count: rows.length, total });
    return { batchId, settled: rows.length, totalCents: total, atomic: true };
  }

  async pendingBatches(): Promise<string[]> {
    const rows = await this.repository.query<{ batch_id: string }>(
      "SELECT DISTINCT batch_id FROM payments WHERE status = 'captured' AND batch_id IS NOT NULL",
    );
    return rows.map((r) => r.batch_id);
  }
}
