import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PAYMENT_PROVIDER_KEY: z.string().min(8),
  AUDIT_LOG_PATH: z.string().default('./var/audit.log'),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

export const config = loadConfig();
