import express from 'express';
import { loadConfig } from '../config';
import { PostgresPaymentRepository } from '../db/repository';
import { PaymentService } from '../payments/PaymentService';
import { SettlementService } from '../payments/SettlementService';
import { createRouter } from './routes';

const config = loadConfig();
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    throw new Error(`No database configured for ${sql.slice(0, 24)} (${params?.length ?? 0} params)`);
  },
};

const repository = new PostgresPaymentRepository(pool);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(createRouter(new PaymentService(repository), new SettlementService(repository)));

app.listen(config.PORT, () => {
  console.log(`payments-service listening on ${config.PORT}`);
});
