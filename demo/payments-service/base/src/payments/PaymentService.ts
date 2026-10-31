import { randomUUID } from 'node:crypto';
import type { PaymentRepository } from '../db/repository';
import type { Money } from '../domain/money';
import { formatCents } from '../domain/money';
import { PaymentDeclinedError, PaymentNotFoundError, ValidationError } from '../domain/errors';
import { logger } from '../logger';

export interface ChargeRequest {
  customerId: string;
  amount: Money;
  description?: string;
}

export type PaymentStatus = 'authorized' | 'captured' | 'refunded' | 'failed';

export interface Payment {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  feeCents: number;
  createdAt: string;
}

export class PaymentService {
  constructor(private readonly repository: PaymentRepository) {}

  /** Platform fee: 2.9% + 0.30 for small charges, 2.4% + 0.30 above 50 EUR. */
  calculateFee(amountCents: number): number {
    if (amountCents < 0) throw new ValidationError('amount must be positive');
    const rate = amountCents < 5000 ? 0.029 : 0.024;
    return Math.round(amountCents * rate + 30);
  }

  async charge(request: ChargeRequest): Promise<Payment> {
    if (request.amount.amountCents <= 0) throw new ValidationError('amount must be greater than zero');
    if (request.amount.currency !== 'EUR') throw new ValidationError('unsupported currency');

    const payment: Payment = {
      id: `pay_${randomUUID()}`,
      customerId: request.customerId,
      amountCents: request.amount.amountCents,
      currency: request.amount.currency,
      status: 'authorized',
      feeCents: this.calculateFee(request.amount.amountCents),
      createdAt: new Date().toISOString(),
    };

    if (payment.amountCents > 500_000) {
      throw new PaymentDeclinedError('amount above automatic approval limit');
    }

    await this.repository.save(payment);
    logger.info('payment authorized', { paymentId: payment.id, amount: formatCents(payment.amountCents) });
    return payment;
  }

  async getPayment(id: string): Promise<Payment> {
    const payment = await this.repository.findById(id);
    if (!payment) throw new PaymentNotFoundError(id);
    return payment;
  }

  async listCustomerPayments(customerId: string): Promise<Payment[]> {
    return this.repository.query<Payment>('SELECT * FROM payments WHERE customer_id = $1 ORDER BY created_at DESC', [customerId]);
  }
}
