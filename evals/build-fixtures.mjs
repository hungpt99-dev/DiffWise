#!/usr/bin/env node
/**
 * Materialise the evaluation fixtures.
 *
 * Each case is a tiny git repository with a `main` commit and a `feature`
 * branch that introduces exactly one defect class. The fixtures are generated
 * rather than committed so that every case is reproducible from this file and
 * no nested repository is stored in the project.
 *
 *   node evals/build-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures');

const cases = [
  {
    id: 'sql-injection',
    files: {
      base: {
        'src/repository.ts': `import { db } from './db';

export async function findById(id: string) {
  return db.query('SELECT * FROM payments WHERE id = $1', [id]);
}
`,
      },
      feature: {
        'src/repository.ts': `import { db } from './db';

export async function findById(id: string) {
  return db.query('SELECT * FROM payments WHERE id = $1', [id]);
}

export async function findByMerchant(merchantId: string) {
  return db.query("SELECT * FROM payments WHERE merchant_id = '" + merchantId + "'");
}
`,
      },
    },
  },
  {
    id: 'hardcoded-secret',
    files: {
      base: {
        'src/config.ts': `export const config = {\n  baseUrl: process.env.PAYMENTS_URL ?? 'http://localhost:8080',\n};\n`,
      },
      feature: {
        'src/config.ts': `export const config = {
  baseUrl: process.env.PAYMENTS_URL ?? 'http://localhost:8080',
};

export const stripeSecretKey = 'sk_live_51H8xQ2KLm9ZzAbCdEfGh';
`,
      },
    },
  },
  {
    id: 'destructive-migration',
    files: {
      base: {
        'migrations/001_init.sql': `CREATE TABLE payments (\n  id uuid PRIMARY KEY,\n  amount_cents integer NOT NULL\n);\n`,
      },
      feature: {
        'migrations/002_cleanup.sql': `ALTER TABLE payments DROP COLUMN legacy_reference;\n\nCREATE INDEX idx_payments_amount ON payments (amount_cents);\n`,
      },
    },
  },
  {
    id: 'n-plus-one',
    files: {
      base: {
        'src/report.ts': `import { db } from './db';

export async function summarise(batchId: string) {
  return db.query('SELECT * FROM payments WHERE batch_id = $1', [batchId]);
}
`,
      },
      feature: {
        'src/report.ts': `import { db } from './db';

export async function summarise(batchId: string) {
  return db.query('SELECT * FROM payments WHERE batch_id = $1', [batchId]);
}

export async function withMerchants(payments: Array<{ merchantId: string }>) {
  const out = [];
  for (const payment of payments) {
    const merchant = await db.query('SELECT * FROM merchants WHERE id = $1', [payment.merchantId]);
    out.push({ ...payment, merchant });
  }
  return out;
}
`,
      },
    },
  },
  {
    id: 'lost-update',
    files: {
      base: {
        'src/wallet.ts': `import { repository } from './db';

export async function credit(walletId: string, amount: number) {
  const wallet = await repository.findOne(walletId);
  return wallet;
}
`,
      },
      feature: {
        'src/wallet.ts': `import { repository } from './db';

export async function credit(walletId: string, amount: number) {
  const wallet = await repository.findOne(walletId);
  const balance = wallet.balance + amount;
  await repository.save({ ...wallet, balance });
  return balance;
}
`,
      },
    },
  },
  {
    id: 'swallowed-error',
    files: {
      base: {
        'src/sync.ts': `export async function sync(records: unknown[]) {\n  return records.length;\n}\n`,
      },
      feature: {
        'src/sync.ts': `export async function sync(records: unknown[]) {
  try {
    await Promise.all(records.map((r) => fetch('/api/sync', { method: 'POST', body: JSON.stringify(r) })));
  } catch (err) {
  }
  return records.length;
}
`,
      },
    },
  },
  {
    id: 'api-breaking-change',
    files: {
      base: {
        'src/money.ts': `export function calculateFee(amountCents: number, region: string): number {
  return region === 'EU' ? Math.round(amountCents * 0.02) : Math.round(amountCents * 0.029);
}
`,
        'src/checkout.ts': `import { calculateFee } from './money';

export function total(amountCents: number, region: string): number {
  return amountCents + calculateFee(amountCents, region);
}
`,
      },
      feature: {
        'src/money.ts': `export function calculateFee(amountCents: number): number {
  return Math.round(amountCents * 0.029);
}
`,
      },
    },
  },
  {
    id: 'missing-idempotency',
    files: {
      base: {
        'src/payouts.ts': `export async function payout(orderId: string) {\n  return { orderId };\n}\n`,
      },
      feature: {
        'src/payouts.ts': `import { gateway } from './gateway';

export async function payout(orderId: string, amountCents: number) {
  return gateway.transfer({ orderId, amountCents, retry: 3 });
}
`,
      },
    },
  },
];

async function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

await mkdir(root, { recursive: true });
for (const testCase of cases) {
  const dir = join(root, testCase.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'DiffWise Eval');
  git(dir, 'config', 'user.email', 'eval@diffwise.local');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'README.md'), `# ${testCase.id}\n\nEvaluation fixture for the DiffWise corpus.\n`, 'utf8');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: testCase.id, private: true, scripts: { test: 'node --test' } }, null, 2), 'utf8');
  await writeFiles(dir, testCase.files.base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'baseline');
  git(dir, 'checkout', '-b', 'feature');
  await writeFiles(dir, testCase.files.feature);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `introduce ${testCase.id}`);
  process.stdout.write(`built ${testCase.id}\n`);
}

process.stdout.write(`\n${cases.length} fixtures in ${root}\n`);
