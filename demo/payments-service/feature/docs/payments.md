# Payments domain

## Fee model

`calculateFee(amountCents)` returns the platform fee in cents:

- charges below 50 EUR: 2.9% + 0.30
- charges of 50 EUR and above: 2.4% + 0.30

## Settlement

`SettlementService.settleBatch(batchId)` reads captured payments for a batch and appends them to
the `ledger` table. Settlement runs once per day at 02:00 UTC. A batch is considered settled when
every payment row has a matching ledger row.

## Refunds

`PaymentService.refund(paymentId, amountCents)` records a partial refund and updates the settlement
statistics used by reporting. Refund limits are configured per merchant in the admin console and
enforced before funds are released.

Refunds are accepted immediately (`202 Accepted`) and reconciled with the provider in the daily
settlement run.
