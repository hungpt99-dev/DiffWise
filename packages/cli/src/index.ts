/**
 * Command dispatch, help and top-level error handling.
 *
 * `main()` returns an exit code instead of calling process.exit so tests can
 * exercise it in-process, and so stdout/stderr flush cleanly when piped.
 */
import { DiffWiseService, ServiceError, WorkspaceError } from '@diffwise/app';
import { Help } from './help';
import { assertKnownFlags, flagString, parseArgs, UsageError, type ParsedArgs } from './args';
import { COMMANDS } from './registry';
import { isInteractive, Output, shouldUseColor } from './output';
import { EXIT } from './exit';
import type { CommandContext } from './context';
import { exitCodeFor } from './commands/review';

const ALIASES: Record<string, string> = {
  ls: 'findings',
  history: 'history',
  open: 'report',
  r: 'review',
  v: 'verify',
};

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const out = new Output({ color: shouldUseColor({ env: process.env }), quiet: false, verbose: false });
    out.error((err as Error).message, (err as UsageError).hint);
    out.info(Help.short());
    return EXIT.USAGE;
  }

  const bootstrapOut = (): Output => new Output({
    color: shouldUseColor({ noColorFlag: parsed.flags.color === false, env: process.env }),
    quiet: parsed.flags.quiet === true,
    verbose: parsed.flags.verbose === true,
  });

  if (!parsed.command) {
    if (parsed.flags.version === true) parsed.command = 'version';
    else {
      // `diffwise --help` and bare `diffwise` both show the command overview.
      bootstrapOut().stdout(Help.short());
      return EXIT.OK;
    }
  }

  const commandName = ALIASES[parsed.command] ?? parsed.command;
  const spec = COMMANDS.find((c) => c.name === commandName);
  const out = new Output({
    color: shouldUseColor({
      noColorFlag: parsed.flags.color === false,
      env: process.env,
    }),
    quiet: parsed.flags.quiet === true,
    verbose: parsed.flags.verbose === true,
  });

  if (!spec) {
    out.error(`Unknown command "${parsed.command}".`);
    out.info(Help.short());
    return EXIT.USAGE;
  }
  if (parsed.flags.help === true) {
    out.stdout(Help.forCommand(spec.name));
    return EXIT.OK;
  }

  const json = parsed.flags.json === true || parsed.flags.format === 'json' || parsed.flags.format === 'sarif';
  const noInput = parsed.flags['no-input'] === true || json || !process.stdin.isTTY;

  try {
    assertKnownFlags(parsed.flags, spec.flags);
  } catch (err) {
    out.error((err as Error).message, (err as UsageError).hint);
    return EXIT.USAGE;
  }

  let service: DiffWiseService;
  try {
    service = await DiffWiseService.create({
      ...(flagString(parsed.flags, 'repo') ? { root: flagString(parsed.flags, 'repo') as string } : {}),
      ...(flagString(parsed.flags, 'config') ? { configPath: flagString(parsed.flags, 'config') as string } : {}),
    });
  } catch (err) {
    if (spec.needsRepo === false) {
      // version/help never need a repository; provide an unusable service stub.
      out.debug(`no repository: ${(err as Error).message}`);
      out.error((err as Error).message);
      return exitCodeFor(err);
    }
    out.error((err as Error).message, (err as WorkspaceError) ? undefined : undefined);
    return err instanceof WorkspaceError ? EXIT.WORKSPACE : EXIT.INTERNAL;
  }

  const ctx: CommandContext = {
    argv: parsed,
    out,
    service,
    root: service.root,
    json,
    interactive: isInteractive(),
    noInput,
    ...(flagString(parsed.flags, 'config') ? { configPath: flagString(parsed.flags, 'config') as string } : {}),
  };

  for (const warning of service.configWarnings) out.warn(warning);

  try {
    return await spec.run(ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      out.error(err.message, err.hint);
      return EXIT.USAGE;
    }
    const code = exitCodeFor(err);
    if (code === EXIT.INTERNAL) {
      out.error(`Internal error: ${(err as Error).message}`);
      if (out.options.verbose) out.info((err as Error).stack ?? '');
      else out.info(out.gray('Re-run with --verbose for a stack trace.'));
    } else if (err instanceof ServiceError) {
      out.error(err.message);
    } else {
      out.error((err as Error).message);
    }
    if (json) {
      out.stdout(JSON.stringify({ ok: false, error: (err as Error).message, kind: err instanceof ServiceError ? err.code : 'ERROR' }, null, 2));
    }
    return code;
  }
}


export { REPORT_SCHEMA_VERSION } from '@diffwise/core';
