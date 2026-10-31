-- Initial schema for the payments service.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  fee_cents BIGINT NOT NULL,
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_customer_idx ON payments (customer_id);
CREATE INDEX payments_batch_idx ON payments (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  amount_cents BIGINT NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- down
DROP TABLE ledger;
DROP TABLE payments;
