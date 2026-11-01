import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, EXIT_DESCRIPTIONS } from '../src/exit';

/**
 * Interface contracts that scripts and CI depend on: exit codes, the config
 * validator, and the cost limit. These run the real binary against real
 * repositories; nothing here is a unit test of a formatter.
 */
const exec = promisify(execFile);
const bin = resolve(__dirname, '../bin/diffwise.js');
const repoRoot = resolve(__dirname, '../../..');

interface RunResult { stdout: string; stderr: string; code: number }

async function run(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, DIFFWISE_AI: 'off', NO_COLOR: '1' },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'diffwise-contracts-'));
  await exec(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', repo], { cwd: repoRoot });
}, 180_000);

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe('exit code contract', () => {
  it('keeps every documented code unique and stable', () => {
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const { code } of EXIT_DESCRIPTIONS) expect(codes).toContain(code);
    // Appending is allowed; renumbering breaks CI pipelines.
    expect(EXIT.OK).toBe(0);
    expect(EXIT.GATE_FAILED).toBe(1);
    expect(EXIT.COST_LIMIT).toBe(10);
  });
});

describe('cli: config validate', () => {
  it('reports a usable configuration with defaults and exits 0', async () => {
    const target = await mkdtemp(join(tmpdir(), 'diffwise-cfg-'));
    try {
      await exec('git', ['init', '-b', 'main'], { cwd: target });
      await exec('git', ['config', 'user.email', 'test@diffwise.local'], { cwd: target });
      await exec('git', ['config', 'user.name', 'Test'], { cwd: target });
      await writeFile(join(target, 'README.md'), '# empty\n', 'utf8');
      await exec('git', ['add', '-A'], { cwd: target });
      await exec('git', ['commit', '-m', 'init'], { cwd: target });

      const { stdout, code } = await run(['config', 'validate', '--json'], target);
      const parsed = JSON.parse(stdout) as { ok: boolean; issues: Array<{ level: string; path: string; message: string }>; path: string | null };
      expect(code).toBe(EXIT.OK);
      expect(parsed.ok).toBe(true);
      expect(parsed.path).toBeNull();
      expect(parsed.issues.some((i) => i.path === '.diffwise/config.json')).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails with a workspace error when the URL is not http(s)', async () => {
    const target = await mkdtemp(join(tmpdir(), 'diffwise-cfg-bad-'));
    try {
      await exec('git', ['init', '-b', 'main'], { cwd: target });
      await exec('git', ['config', 'user.email', 'test@diffwise.local'], { cwd: target });
      await exec('git', ['config', 'user.name', 'Test'], { cwd: target });
      await mkdir(join(target, '.diffwise'), { recursive: true });
      await writeFile(join(target, 'README.md'), '# empty\n', 'utf8');
      await writeFile(join(target, '.diffwise/config.json'), JSON.stringify({
        provider: { id: 'openai-compatible', baseUrl: 'not-a-url', model: 'm', apiKeyEnvVar: 'DIFFWISE_API_KEY' },
      }), 'utf8');
      await exec('git', ['add', '-A'], { cwd: target });
      await exec('git', ['commit', '-m', 'init'], { cwd: target });

      const { stdout, code } = await run(['config', 'validate', '--json'], target);
      const parsed = JSON.parse(stdout) as { ok: boolean; issues: Array<{ level: string; path: string }> };
      expect(code).toBe(EXIT.WORKSPACE);
      expect(parsed.ok).toBe(false);
      expect(parsed.issues.some((i) => i.level === 'error' && i.path === 'provider.baseUrl')).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('cli: cost limit', () => {
  it('refuses --max-cost when no price is configured, and says why', async () => {
    await run(['config', 'set', 'ai.enabled', 'false'], repo);
    const { stderr, code } = await run(['review', 'main..HEAD', '--no-ai', '--max-cost', '0.01'], repo);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain('needs configured prices');
  }, 120_000);

  it('rejects a non-numeric cost limit', async () => {
    const { stderr, code } = await run(['review', '--max-cost', 'cheap'], repo);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toMatch(/expects a number/);
  }, 120_000);

  it('accepts a cost limit when prices exist and reports the spend', async () => {
    await run(['config', 'set', 'pricing', '{"deepseek-*":{"inputPerMTok":1,"outputPerMTok":1,"source":"test"}}'], repo);
    const { stderr, stdout, code } = await run(['review', 'main..HEAD', '--no-ai', '--max-cost', '5'], repo);
    // No model call happened, so the limit cannot be evaluated; the CLI says so
    // instead of implying that $0.00 was verified.
    expect([EXIT.OK, EXIT.GATE_FAILED]).toContain(code);
    expect(`${stdout}${stderr}`).toMatch(/Cost limit not evaluated/);
  }, 180_000);
});
