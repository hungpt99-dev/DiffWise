# Payments domain

## Fee model

`calculateFee(amountCents)` returns the platform fee in cents:

- charges below 50 EUR: 2.9% + 0.30
- charges of 50 EUR and above: 2.4% + 0.30

## Settlement

`SettlementService.settleBatch(batchId)` reads captured payments for a batch and appends them to
the `ledger` table. Batches are exposed through `GET /api/settlements/pending`.

Settlement currently runs once per day at 02:00 UTC. A batch is considered settled when every
payment row has a matching ledger row.

## Refunds

Partial refunds are planned for the next release. Until then, customer support issues manual
ledger corrections. Refund limits are configured per merchant in the admin console.
