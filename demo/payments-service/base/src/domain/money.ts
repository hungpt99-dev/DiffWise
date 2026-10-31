export interface Money {
  amountCents: number;
  currency: string;
}

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error('amount must be finite');
  return Math.round(amount * 100);
}

export function formatCents(cents: number, currency = 'EUR'): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error('currency mismatch');
  return { amountCents: a.amountCents + b.amountCents, currency: a.currency };
}
