#!/usr/bin/env node
import { resolve } from 'node:path';
import { startStdioServer } from './server';

/**
 * MCP stdio entry point.
 *
 *   diffwise-mcp [--root <path>]
 *
 * Root resolution order: --root, DIFFWISE_REPO_ROOT, cwd.
 * stdout is reserved for the protocol; diagnostics go to stderr.
 */
function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const root = resolve(argValue('root') ?? process.env.DIFFWISE_REPO_ROOT ?? process.cwd());

startStdioServer(root).catch((err: Error) => {
  process.stderr.write(`diffwise-mcp failed to start: ${err.message}\n`);
  process.exitCode = 1;
});
