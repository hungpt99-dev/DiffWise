#!/usr/bin/env node
/**
 * Materialise the DiffWise demo repository.
 *
 * The fixture lives as two overlays (base + feature) instead of a committed git
 * repository, so the demo history is reproducible and no nested repository is
 * stored inside this project.
 *
 *   node demo/build-demo-repo.mjs --target /tmp/diffwise-demo
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const targetArg = args[args.indexOf('--target') + 1];
const target = resolve(targetArg && targetArg !== '--target' ? targetArg : '/tmp/diffwise-demo');
const fixture = join(here, 'payments-service');

function git(...cmd) {
  return execFileSync('git', cmd, { cwd: target, encoding: 'utf8' });
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(join(fixture, 'base'), target, { recursive: true });

git('init', '-b', 'main');
git('config', 'user.name', 'DiffWise Demo');
git('config', 'user.email', 'demo@diffwise.local');
git('config', 'commit.gpgsign', 'false');
git('add', '-A');
git('commit', '-m', 'Initial payments service with charge and settlement');
const baseCommit = git('rev-parse', 'HEAD').trim();

git('checkout', '-b', 'feature/partial-refunds');
await cp(join(fixture, 'feature'), target, { recursive: true });
git('add', '-A');
git('commit', '-m', 'Add partial refunds and settlement reconciliation');
const headCommit = git('rev-parse', 'HEAD').trim();

console.log(JSON.stringify({
  target,
  branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
  baseCommit,
  headCommit,
  log: git('log', '--oneline').trim().split('\n'),
  status: git('status', '--porcelain').trim(),
}, null, 2));
