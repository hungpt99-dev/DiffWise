# Payments Service

Handles customer charges, platform fees, partial refunds and daily settlement for the storefront.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/payments` | Charge a customer |
| GET | `/api/payments/:id` | Read a payment |
| POST | `/api/payments/:id/refund` | Refund part of a payment |

## Development

```bash
npm install
npm run dev
npm test
npm run test:integration
```

Configuration lives in `.env` — see `.env.example` for the full list.

## Money handling

All amounts are integer cents. `calculateFee` returns the platform fee for a charge.
