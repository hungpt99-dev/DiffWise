import { Router } from 'express';
import { z } from 'zod';
import type { PaymentService } from '../payments/PaymentService';
import type { SettlementService } from '../payments/SettlementService';
import { PaymentError } from '../domain/errors';
import { logger } from '../logger';

const chargeSchema = z.object({
  customerId: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  description: z.string().max(140).optional(),
});

export function createRouter(payments: PaymentService, settlements: SettlementService): Router {
  const router = Router();

  router.post('/api/payments', async (req, res) => {
    const parsed = chargeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    try {
      const payment = await payments.charge({
        customerId: parsed.data.customerId,
        amount: { amountCents: parsed.data.amountCents, currency: parsed.data.currency },
        description: parsed.data.description,
      });
      res.status(201).json(payment);
    } catch (err) {
      if (err instanceof PaymentError) {
        res.status(err.code === 'payment_declined' ? 402 : 400).json({ error: err.code, message: err.message });
        return;
      }
      logger.error('charge failed', { message: (err as Error).message });
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.get('/api/payments/:id', async (req, res) => {
    try {
      res.json(await payments.getPayment(req.params.id));
    } catch (err) {
      if (err instanceof PaymentError) {
        res.status(404).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/api/settlements/pending', async (_req, res) => {
    res.json({ batches: await settlements.pendingBatches() });
  });

  return router;
}
