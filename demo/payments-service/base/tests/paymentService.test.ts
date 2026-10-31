import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from '../src/payments/PaymentService';
import type { PaymentRepository } from '../src/db/repository';
import type { Payment } from '../src/payments/PaymentService';

function repository(): PaymentRepository {
  const payments = new Map<string, Payment>();
  return {
    findById: async (id) => payments.get(id) ?? null,
    save: async (p) => { payments.set(p.id, p); },
    update: async (p) => { payments.set(p.id, p); },
    recordRefund: async () => undefined,
    query: async () => [],
    withTransaction: async (work) => work(repository()),
  };
}

describe('PaymentService.calculateFee', () => {
  const service = new PaymentService(repository());

  it('applies the small-charge rate below 50 EUR', () => {
    expect(service.calculateFee(1000)).toBe(59);
  });

  it('applies the volume rate at and above 50 EUR', () => {
    expect(service.calculateFee(5000)).toBe(150);
  });

  it('rejects negative amounts', () => {
    expect(() => service.calculateFee(-1)).toThrow('amount must be positive');
  });
});

describe('PaymentService.charge', () => {
  it('persists an authorized payment with a fee', async () => {
    const repo = repository();
    const save = vi.spyOn(repo, 'save');
    const service = new PaymentService(repo);
    const payment = await service.charge({ customerId: 'cus_1', amount: { amountCents: 2500, currency: 'EUR' } });
    expect(payment.status).toBe('authorized');
    expect(payment.feeCents).toBe(103);
    expect(save).toHaveBeenCalledOnce();
  });

  it('rejects unsupported currencies', async () => {
    const service = new PaymentService(repository());
    await expect(service.charge({ customerId: 'cus_1', amount: { amountCents: 100, currency: 'USD' } }))
      .rejects.toThrow('unsupported currency');
  });
});
