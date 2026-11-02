/**
 * Command registry.
 *
 * Separated from the dispatcher so help text and tests can enumerate commands
 * without constructing a service or touching the filesystem.
 */
import type { CommandContext } from './context';
import { chatCommand, fixCommand, verifyCommand } from './commands/chatfix';
import { compareCommand, findingsCommand, historyCommand, showCommand } from './commands/inspect';
import { configCommand, doctorCommand, initCommand, versionCommand } from './commands/project';
import { reportCommand } from './commands/report';
import { Help } from './help';
import { EXIT } from './exit';
import { reviewCommand } from './commands/review';
import { evaluateCommand, policyCommand, reviewersCommand, rulesCommand } from './commands/platform';
import { docsCommand, mcpCommand, providersCommand } from './commands/workspace';

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  flags: string[];
  /** Commands that must work outside a git repository. */
  needsRepo?: boolean;
  run(ctx: CommandContext): Promise<number>;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'init',
    summary: 'Create .diffwise/config.json and git-ignore local reports',
    usage: 'diffwise init [--force] [--mcp] [--json]',
    flags: ['force', 'mcp'],
    run: initCommand,
  },
  {
    name: 'doctor',
    summary: 'Validate git, runtime, config, permissions and (optionally) model connectivity',
    usage: 'diffwise doctor [--connect] [--json]',
    flags: ['connect'],
    run: doctorCommand,
  },
  {
    name: 'review',
    summary: 'Review a change and produce a report',
    usage: 'diffwise review [range|paths] [--staged|--commit REF|--base A --head B] [--format text|json|html|sarif] [--out FILE] [--open] [--serve] [--interactive] [--fail-on SEV] [--ai|--no-ai] [--ai-required] [--max-cost USD]',
    flags: ['staged', 'commit', 'base', 'head', 'format', 'out', 'open', 'serve', 'interactive', 'fail-on', 'ai', 'no-ai', 'ai-required', 'max-cost', 'verbose', 'no-color', 'no-input', 'title', 'allow-public'],
    run: reviewCommand,
  },
  {
    name: 'findings',
    summary: 'List findings from the latest review, with filters',
    usage: 'diffwise findings [--severity SEV] [--category CAT] [--kind KIND] [--search TEXT] [--sort severity|file|category] [--limit N] [--json]',
    flags: ['severity', 'category', 'kind', 'search', 'sort', 'limit', 'report', 'json'],
    run: findingsCommand,
  },
  {
    name: 'show',
    summary: 'Show one finding with evidence, consequences and fix options',
    usage: 'diffwise show <finding-id> [--json]',
    flags: ['json'],
    run: showCommand,
  },
  {
    name: 'chat',
    summary: 'Ask the report a question (report-aware, evidence-validated)',
    usage: 'diffwise chat [--finding ID] [--report REF] ["question"]',
    flags: ['finding', 'report', 'json'],
    run: chatCommand,
  },
  {
    name: 'fix',
    summary: 'Generate, compare, preview or apply a fix (explicit approval required)',
    usage: 'diffwise fix <finding-id> [--compare] [--preview] [--apply [--yes]] [--solution ID] [--rollback APPLIED-FIX-ID] [--json]',
    flags: ['compare', 'preview', 'apply', 'yes', 'solution', 'rollback', 'allow-delete', 'patch-file', 'title', 'json'],
    run: fixCommand,
  },
  {
    name: 'verify',
    summary: 'Run the configured verification command and record the real result',
    usage: 'diffwise verify [--finding ID] [--json]',
    flags: ['finding', 'json', 'tests'],
    run: verifyCommand,
  },
  {
    name: 'report',
    summary: 'Print, export or serve a stored review',
    usage: 'diffwise report [latest|ID] [--format text|json|sarif|html] [--out FILE] [--open] [--serve [--port N]] [--full] [--json]',
    flags: ['format', 'out', 'open', 'serve', 'port', 'host', 'full', 'severity', 'title', 'allow-public'],
    run: reportCommand,
  },
  {
    name: 'history',
    summary: 'List stored reviews',
    usage: 'diffwise history [--limit N] [--json]',
    flags: ['limit', 'json'],
    run: historyCommand,
  },
  {
    name: 'compare',
    summary: 'Compare two reviews (resolved / introduced / still present)',
    usage: 'diffwise compare <left> <right> [--json]',
    flags: ['json'],
    run: compareCommand,
  },
  {
    name: 'config',
    summary: 'Show or change project configuration',
    usage: 'diffwise config [list|get <key>|set <key> <value>|validate] [--json]',
    flags: ['json'],
    run: configCommand,
  },
  {
    name: 'version',
    summary: 'Print CLI, report-schema and runtime versions',
    usage: 'diffwise version [--json]',
    flags: ['json'],
    needsRepo: false,
    run: versionCommand,
  },
  {
    name: 'rules',
    summary: 'List, explain, validate, install or manage custom rule packs',
    usage: 'diffwise rules [list|explain <id>|validate <dir>|install <dir>|create <id>|update <id>|remove <id>|enable|disable|test|export|import] [--json]',
    flags: [
      'category', 'json', 'force', 'name', 'severity', 'confidence', 'pattern', 'absence', 'forbidden-import',
      'scope', 'must-not-match', 'message', 'description', 'recommendation', 'files', 'exclude', 'languages',
      'priority', 'enforcement', 'gate', 'out', 'max-files',
    ],
    run: rulesCommand,
  },
  {
    name: 'reviewers',
    summary: 'List or explain specialised reviewers, or show the plan for the latest review',
    usage: 'diffwise reviewers [list|explain <id>|plan] [--json]',
    flags: ['json'],
    run: reviewersCommand,
  },
  {
    name: 'policy',
    summary: 'Show the effective review policy, its layer provenance, and its recorded history',
    usage: 'diffwise policy [effective [path...]|history] [--limit N] [--json]',
    flags: ['json', 'limit'],
    run: policyCommand,
  },
  {
    name: 'docs',
    summary: 'Manage documentation sources and inspect the bounded index',
    usage: 'diffwise docs [list|index|add <path>|remove <path>|enable <path>|disable <path>] [--category CAT] [--priority N] [--json]',
    flags: ['category', 'priority', 'modules', 'json'],
    run: docsCommand,
  },
  {
    name: 'mcp',
    summary: 'Manage external MCP connections, permissions and read-only context tools',
    usage: 'diffwise mcp [list|status|add <name>|update <name>|remove <name>|enable <name>|disable <name>|test <name>|tools <name>|call <name> <tool>] [--json]',
    flags: ['transport', 'command', 'args', 'url', 'allow-tools', 'allow-resources', 'context-tools', 'context-tool', 'context-resource', 'context-args', 'allow-write', 'max-output', 'timeout', 'approve-write', 'json'],
    run: mcpCommand,
  },
  {
    name: 'providers',
    summary: 'Manage AI provider profiles and per-task model routing',
    usage: 'diffwise providers [list|add <name>|update <name>|remove <name>|route <task>] [--id ID] [--model M] [--key-env VAR] [--json]',
    flags: ['id', 'name', 'base-url', 'model', 'fast-model', 'key-env', 'max-tokens', 'temperature', 'timeout', 'header', 'primary', 'disabled', 'provider', 'fallback', 'allow-cross-provider', 'clear', 'api-version', 'deployment', 'json'],
    run: providersCommand,
  },
  {
    name: 'evaluate',
    summary: 'Run a labelled evaluation dataset and print measured metrics',
    usage: 'diffwise evaluate [--dataset DIR] [--json]',
    flags: ['dataset', 'json'],
    run: evaluateCommand,
  },
  {
    name: 'help',
    summary: 'Show help for DiffWise or one command',
    usage: 'diffwise help [command]',
    flags: [],
    needsRepo: false,
    run: async (ctx) => {
      ctx.out.stdout(Help.forCommand(ctx.argv.positionals[0]));
      return EXIT.OK;
    },
  },
];

