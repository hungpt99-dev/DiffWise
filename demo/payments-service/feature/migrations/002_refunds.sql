-- Partial refunds and settlement reconciliation.
CREATE TABLE refunds (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refund_stats (
  payment_id TEXT PRIMARY KEY REFERENCES payments (id),
  total_refunded BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE payments DROP COLUMN legacy_reference;
