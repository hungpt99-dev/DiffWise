/**
 * Verification execution.
 *
 * The command comes from developer-authored configuration, never from
 * repository content or model output. It runs with a hard timeout, output is
 * captured (and redacted by the caller before display), and the result records
 * exactly what ran — `not-run` is a first-class outcome so nothing can be
 * reported as passing without having been executed.
 */
import { spawn } from 'node:child_process';
import type { TestExecution } from '@diffwise/core';

export interface VerificationOptions {
  root: string;
  command: string;
  timeoutMs: number;
  ranBy: TestExecution['ranBy'];
  /** Extra, non-secret environment for the child (e.g. CI=1). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export async function runVerificationCommand(options: VerificationOptions): Promise<TestExecution> {
  const { root, command, timeoutMs, ranBy } = options;
  const startedAt = new Date().toISOString();
  if (!command.trim()) {
    return {
      command,
      startedAt,
      durationMs: 0,
      exitCode: null,
      status: 'not-run',
      outputTail: 'No verification command configured. Set verification.command in .diffwise/config.json.',
      ranBy,
      relatedTestsExecuted: false,
    };
  }
  if (options.signal?.aborted) {
    return {
      command, startedAt, durationMs: 0, exitCode: null, status: 'not-run',
      outputTail: 'Verification was cancelled before it started.', ranBy, relatedTestsExecuted: false,
    };
  }

  return new Promise<TestExecution>((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(command, {
      cwd: root,
      shell: true,
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finalise = (status: TestExecution['status'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        command,
        startedAt,
        durationMs: Date.now() - t0,
        exitCode,
        status,
        outputTail: output.slice(-8000),
        ranBy,
        relatedTestsExecuted: /(?:test|spec|vitest|jest|pytest|go test|mvn .*test|gradle .*test)/i.test(command),
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[verification timed out after ${timeoutMs}ms]`;
      finalise('timed-out', null);
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      output += '\n[verification cancelled]';
      finalise('not-run', null);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (err) => {
      output += `\nFailed to start: ${err.message}`;
      finalise('failed', null);
    });
    child.on('close', (code) => finalise(code === 0 ? 'passed' : 'failed', code));
  });
}
