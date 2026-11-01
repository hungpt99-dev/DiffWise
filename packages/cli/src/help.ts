/**
 * Help text.
 *
 * Written for a developer at a terminal: commands grouped by workflow, one
 * line each, and every flag that actually exists. `diffwise help <command>`
 * shows the full flag list and examples for that command.
 */
import { COMMANDS } from './registry';
import { exitCodesText } from './exit';

const TAGLINE = 'Understand every change. Detect hidden risks. Make better engineering decisions.';

export const Help = {
  short(): string {
    const lines: string[] = [
      `DiffWise — ${TAGLINE}`,
      '',
      'Usage: diffwise <command> [options]',
      '',
      'Start',
      '  init         Write .diffwise/config.json and ignore local reports',
      '  doctor       Validate git, runtime, config, permissions, model connectivity',
      '  version      Print versions',
      '',
      'Review',
      '  review       Review the working tree, a range, a commit or paths',
      '  findings     List findings (filter by severity, category, text)',
      '  show         Show one finding with evidence and fix options',
      '  history      List stored reviews',
      '  compare      Compare two reviews',
      '',
      'Act',
      '  chat         Ask the report a question',
      '  fix          Generate, compare, preview or apply a fix',
      '  verify       Run the configured verification command',
      '',
      'Deliver',
      '  report       Print, export (json/sarif/html) or serve a review',
      '  config       Show or change configuration',
      '',
      'Platform',
      '  rules        List, explain, validate or install rule packs',
      '  reviewers    List or explain reviewers; show the plan for a review',
      '  policy       Show the effective policy and which layer supplied each value',
      '  evaluate     Run a labelled dataset and print measured metrics',
      '',
      'Global flags: --json --quiet --verbose --no-color --no-input --config <file> --repo <path>',
      'Run "diffwise help <command>" for details, "diffwise help exit-codes" for CI.',
    ];
    return lines.join('\n');
  },

  forCommand(name?: string): string {
    if (!name) return Help.short();
    if (name === 'exit-codes') {
      return ['DiffWise exit codes', '', exitCodesText()].join('\n');
    }
    const spec = COMMANDS.find((c) => c.name === name);
    if (!spec) return `Unknown command "${name}".\n\n${Help.short()}`;
    const flags = spec.flags.filter((f) => !['verbose', 'no-color', 'no-input'].includes(f));
    return [
      `diffwise ${spec.name} — ${spec.summary}`,
      '',
      'Usage',
      `  ${spec.usage}`,
      '',
      'Flags',
      ...flags.map((f) => `  --${f}`),
      '',
      'Global',
      '  --json --quiet --verbose --no-color --no-input --config <file> --repo <path>',
      '',
      EXAMPLES[spec.name] ? 'Examples' : '',
      ...(EXAMPLES[spec.name] ?? []).map((e) => `  ${e}`),
    ].filter((line, i, all) => !(line === '' && all[i + 1] === '')).join('\n');
  },
};

const EXAMPLES: Record<string, string[]> = {
  init: ['diffwise init', 'diffwise init --mcp    # also register the MCP server for coding agents'],
  doctor: ['diffwise doctor', 'diffwise doctor --connect    # also send one request to the model'],
  review: [
    'diffwise review                              # working tree',
    'diffwise review --staged                     # staged only',
    'diffwise review main..HEAD                   # branch comparison',
    'diffwise review --commit HEAD                # single commit',
    'diffwise review src/payments/                # only these paths',
    'diffwise review --base origin/main --head HEAD --json',
    'diffwise review --format sarif --out diffwise.sarif',
    'diffwise review --format html --open',
  ],
  findings: ['diffwise findings --severity high', 'diffwise findings --search refund --json'],
  show: ['diffwise show DW-001', 'diffwise show DW-001 --json'],
  chat: [
    'diffwise chat "which services are affected by this change?"',
    'diffwise chat --finding DW-001 "what is the safest fix?"',
    'diffwise chat                     # interactive session',
  ],
  fix: [
    'diffwise fix DW-001                       # list options',
    'diffwise fix DW-001 --compare             # trade-offs of each option',
    'diffwise fix DW-001 --preview             # validate the patch, write nothing',
    'diffwise fix DW-001 --apply               # asks for confirmation',
    'diffwise fix DW-001 --apply --yes         # non-interactive approval (CI/agent)',
    'diffwise fix --rollback fix-1a2b3c4d      # restore files from the journal',
  ],
  verify: ['diffwise verify', 'diffwise verify --finding DW-001 --json'],
  report: [
    'diffwise report',
    'diffwise report latest --format sarif --out diffwise.sarif',
    'diffwise report latest --format html --out report.html',
    'diffwise report latest --serve --open',
    'diffwise report latest --full --json',
  ],
  history: ['diffwise history --limit 10'],
  compare: ['diffwise compare latest previous'],
  config: ['diffwise config list', 'diffwise config get provider.model', 'diffwise config set verification.command "npm test"'],
};
