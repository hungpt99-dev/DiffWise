import { readFileSync } from 'node:fs';

export interface RefundPolicyConfig {
  maxRefundCents: number;
  allowPartial: boolean;
}

/**
 * Load the refund policy from a JSON file shipped with the deployment.
 * The per-merchant override is read from the environment.
 */
export function loadRefundPolicy(path: string): RefundPolicyConfig {
  const raw: any = JSON.parse(readFileSync(path, 'utf8'));
  const limit = Number(process.env.PAYMENT_REFUND_LIMIT ?? raw.maxRefundCents);
  return { maxRefundCents: limit, allowPartial: raw.allowPartial !== false };
}

export function isRefundAllowed(
  payment: { amountCents: number },
  requestedCents: number,
  policy: RefundPolicyConfig,
): boolean {
  if (requestedCents <= 0) throw new Error('refund must be positive');
  if (!policy.allowPartial && requestedCents !== payment.amountCents) return false;
  return requestedCents <= policy.maxRefundCents && requestedCents <= payment.amountCents;
}
