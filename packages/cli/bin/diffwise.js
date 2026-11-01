#!/usr/bin/env node
/**
 * DiffWise CLI entry point.
 *
 * Kept deliberately thin: argument parsing and dispatch live in dist/index.js
 * so they can be unit-tested without spawning a process.
 */
'use strict';

const path = require('node:path');

function fail(message) {
  process.stderr.write(`error ${message}\n`);
  process.exit(9);
}

let cli;
try {
  cli = require(path.join(__dirname, '..', 'dist', 'index.js'));
} catch (err) {
  fail(`DiffWise CLI is not built (${err.message}). Run "npm run build -w @diffwise/cli".`);
}

cli.main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`error ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 9;
});
