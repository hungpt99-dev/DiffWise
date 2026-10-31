# Payments Service

Handles customer charges, platform fees and daily settlement for the storefront.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/payments` | Charge a customer |
| GET | `/api/payments/:id` | Read a payment |
| GET | `/api/settlements/pending` | List unsettled batches |

## Development

```bash
npm install
npm run dev
npm test
```

Configuration lives in `.env` — see `.env.example` for the full list.

## Money handling

All amounts are integer cents. `calculateFee` returns the platform fee for a charge.
