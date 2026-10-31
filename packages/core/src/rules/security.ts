import type { Confidence, Severity } from '../types';
import { isTestFile, isMigrationFile } from '../analysis/languages';
import { addedLines, codeEvidence, diffEvidence, snippetAround } from './util';
import { draftFinding } from './types';
import type { CandidateFinding, Rule, RuleContext } from './types';

interface LinePatternRule {
  id: string;
  title: (m: RegExpExecArray, line: string) => string;
  description: (m: RegExpExecArray, line: string) => string;
  why: string;
  consequences: string[];
  recommendation: string;
  severity: Severity;
  confidence: Confidence;
  pattern: RegExp;
  tags: string[];
  skip?: (path: string) => boolean;
}

const PATTERN_RULES: LinePatternRule[] = [
  {
    id: 'security.hardcoded-secret',
    title: () => 'Hardcoded credential in source',
    description: (m) => `A literal value is assigned to \`${m[1] ?? 'a credential field'}\`. The value is committed to the repository and ships with every checkout, build artefact and container image.`,
    why: 'Git history is copied to every clone, CI cache and fork. Rotating a leaked key requires rotating the deployment, not just the file.',
    consequences: ['Credential reuse across environments', 'Unauthorised access with the developer\'s privileges', 'Secret remains recoverable from git history after deletion'],
    recommendation: 'Read the value from the environment or a secret manager, validate it at startup, and rotate the committed value. Removing the line alone does not revoke the secret.',
    severity: 'critical',
    confidence: 'verified',
    // Allow declaration modifiers in any order (`export const`, `private static
    // readonly`); real-world credential assignments almost always carry one.
    pattern: /^\s*(?:(?:export|default|declare|const|let|var|private|public|protected|readonly|static|final)\s+){0,5}([A-Za-z_$][\w$]*(?:key|secret|token|password|passwd|pwd|credential)[\w$]*)\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]/i,
    tags: ['secrets', 'CWE-798'],
    skip: (p) => isTestFile(p) || /\.env\.example$|\.md$/.test(p),
  },
  {
    id: 'security.dynamic-code',
    title: () => 'Dynamic code evaluation of non-literal input',
    description: (m) => `\`${m[1]}\` receives a value that is not a string literal. Dynamic evaluation turns data into code.`,
    why: 'If any part of the evaluated string can be influenced by a request, file or configuration, the process executes attacker-controlled code with the application\'s privileges.',
    consequences: ['Remote code execution', 'Sandbox escape in plugin/expression features'],
    recommendation: 'Replace dynamic evaluation with a parser or an explicit dispatch table. If evaluation is unavoidable, restrict it to a documented allow-list and never pass user data.',
    severity: 'critical',
    confidence: 'high',
    pattern: /\b(eval|new\s+Function|vm\.runIn\w+)\s*\(\s*([^'"`)]|\w+\s*\+)/,
    tags: ['CWE-95'],
    skip: (p) => isTestFile(p),
  },
  {
    id: 'security.tls-verification',
    title: () => 'TLS certificate verification disabled',
    description: () => 'Certificate validation is explicitly turned off for outbound connections.',
    why: 'Disabling verification makes every request on this connection trivially interceptable by anyone on the network path.',
    consequences: ['Credential and payload disclosure to a man-in-the-middle', 'Silent acceptance of an impersonated service'],
    recommendation: 'Remove the override. If an internal CA is used, trust that CA explicitly instead of disabling validation.',
    severity: 'high',
    confidence: 'verified',
    pattern: /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true)/,
    tags: ['CWE-295'],
  },
  {
    id: 'security.weak-crypto',
    title: () => 'Weak hash used for a security-sensitive value',
    description: (m) => `\`${m[1]}\` is used. It is a fast, collision-prone digest and provides no meaningful protection for passwords or signatures.`,
    why: 'Fast hashes allow offline brute force at billions of guesses per second on commodity hardware.',
    consequences: ['Password recovery from a database dump', 'Forged integrity checks'],
    recommendation: 'Use a password KDF (argon2id, scrypt, bcrypt) for passwords and SHA-256+ for integrity. Rehash existing values on next login.',
    severity: 'high',
    confidence: 'medium',
    pattern: /\b(md5|sha1)\s*\(|createHash\(\s*['"](?:md5|sha1)['"]/i,
    tags: ['CWE-328'],
    skip: (p) => isTestFile(p) || isMigrationFile(p),
  },
  {
    id: 'security.insecure-random',
    title: () => 'Non-cryptographic randomness for a security value',
    description: () => '`Math.random()` is used to produce a value named like a token, nonce, key or identifier for authentication.',
    why: '`Math.random()` is a predictable PRNG seeded per process; outputs can be reproduced by an attacker who observes a few values.',
    consequences: ['Predictable password-reset or session tokens', 'Bypass of nonce-based replay protection'],
    recommendation: 'Use `crypto.randomBytes(32)` (Node) or `crypto.getRandomValues` (web) and compare tokens in constant time.',
    severity: 'high',
    confidence: 'medium',
    // Match Math.random() on a line whose identifier contains a security word in
    // any casing (`refundToken`, `otpNonce`, `sessionKey`), before or after it.
    pattern: /Math\.random\(\)[^\n]*|^[^\n]*Math\.random\(\)/i,
    tags: ['CWE-330'],
  },
  {
    id: 'security.dom-xss',
    title: () => 'Unsanitised HTML injection into the DOM',
    description: (m) => `\`${m[1]}\` is assigned a value that is not obviously a literal or a sanitiser call.`,
    why: 'Assigning interpolated content to HTML sinks executes it in the page origin, where session tokens and authenticated APIs are reachable.',
    consequences: ['Stored or reflected cross-site scripting', 'Session theft', 'Actions performed as the victim'],
    recommendation: 'Render text through the framework\'s escaping path, or sanitise with a maintained library (DOMPurify) before assigning HTML.',
    severity: 'high',
    confidence: 'medium',
    pattern: /(dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:|\.innerHTML\s*=\s*|document\.write\s*\()\s*[^'"`\s]/,
    tags: ['CWE-79'],
  },
  {
    id: 'security.cors-wildcard',
    title: () => 'Wildcard CORS combined with credentials',
    description: () => 'The response allows any origin while also allowing credentials.',
    why: 'A wildcard origin with credentials lets any website read authenticated responses from this API on behalf of a signed-in user.',
    consequences: ['Cross-origin data exfiltration', 'CSRF-style state changes from a malicious page'],
    recommendation: 'Echo an explicit allow-list of trusted origins and keep `credentials` enabled only for those origins.',
    severity: 'high',
    confidence: 'medium',
    pattern: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/,
    tags: ['CWE-942'],
  },
  {
    id: 'security.jwt-no-verify',
    title: () => 'JWT decoded without signature verification',
    description: () => 'A token is decoded (`decode`) rather than verified, or verification explicitly allows unsigned tokens.',
    why: 'Decoding only parses the payload; nothing proves the token was issued by the trusted authority.',
    consequences: ['Forged identity and privilege escalation', 'Bypass of tenant isolation carried in claims'],
    recommendation: 'Use `verify` with an explicit algorithm allow-list, the issuer and audience, and a bounded clock tolerance.',
    severity: 'critical',
    confidence: 'medium',
    pattern: /\bjwt\.(decode|verify)\s*\([^)]*(none|algorithms\s*:\s*\[\s*['"]none)/i,
    tags: ['CWE-347'],
  },
];

function runPatternRules(ctx: RuleContext): CandidateFinding[] {
  const out: CandidateFinding[] = [];
  for (const change of ctx.changes) {
    if (change.binary || change.status === 'deleted') continue;
    const content = ctx.contents.get(change.path);
    if (!content) continue;
    for (const added of addedLines(change)) {
      for (const rule of PATTERN_RULES) {
        if (rule.skip?.(change.path)) continue;
        const trimmedLine = added.text.trim();
        if (/^(\/\/|\*|\/\*|#|--)/.test(trimmedLine)) continue;
        const m = rule.pattern.exec(added.text);
        if (!m) continue;
        // Avoid flagging environment lookups and placeholder ellipses.
        if (rule.id === 'security.hardcoded-secret' && /process\.env|os\.environ|import\.meta\.env/.test(added.text)) continue;
        if (rule.id === 'security.hardcoded-secret' && /['"`](x{4,}|\*{4,}|<[^>]+>|changeme|example|placeholder)/i.test(m[2] ?? '')) continue;
        if (rule.id === 'security.insecure-random' && !/\b\w*(?:token|nonce|secret|key|otp|password|session|reference|csrf)\w*\b/i.test(added.text)) continue;
        rule.pattern.lastIndex = 0;
        out.push(draftFinding({
          ruleId: rule.id,
          title: rule.title(m, added.text),
          description: rule.description(m, added.text),
          severity: rule.severity,
          category: 'security',
          kind: rule.severity === 'high' || rule.severity === 'critical' ? 'problem' : 'risk',
          confidence: rule.confidence,
          file: change.path,
          range: { start: added.line, end: added.line },
          evidence: [
            diffEvidence(change.path, added.line, added.text, 'Added line matched a security-sensitive pattern.'),
            codeEvidence(change.path, added.line, content, 'Surrounding source context.'),
          ],
          whyItMatters: rule.why,
          consequences: rule.consequences,
          recommendation: rule.recommendation,
          tags: rule.tags,
        }));
      }
    }
  }
  return out;
}

/** SQL built by string concatenation or template interpolation. */
function sqlInjection(): Rule {
  return {
    id: 'security.sql-injection',
    category: 'security',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        const fileLines = content.split(/\r?\n/);
        for (const added of addedLines(change)) {
          const trimmed = added.text.trim();
          if (/^(\/\/|\*|\/\*|#|--)/.test(trimmed)) continue;
          // Multi-line SQL: the call may open on a previous line.
          const window = [fileLines[added.line - 3], fileLines[added.line - 2], added.text].filter((l): l is string => typeof l === 'string').join('\n');
          const call = /\.(query|execute|raw|prepare|all|get|run)\s*\(\s*(`|'|")/.exec(window);
          const interpolated = /\$\{[^}]+\}/.test(added.text);
          const concatenated = /['"`]\s*\+\s*[A-Za-z_$][\w$.]*/.test(added.text) || /[A-Za-z_$][\w$.]*\s*\+\s*['"`]/.test(added.text);
          const sqlKeyword = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i.test(added.text);
          if (!call || !sqlKeyword || (!interpolated && !concatenated)) continue;
          out.push(draftFinding({
            ruleId: 'security.sql-injection',
            title: 'SQL statement built by string interpolation',
            description: `The statement passed to \`.${call[1]}\` is assembled from ${interpolated ? 'a template literal' : 'string concatenation'}, so the query text depends on runtime values rather than bound parameters.`,
            severity: 'critical',
            category: 'security',
            kind: 'problem',
            confidence: 'high',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Interpolated SQL statement.'),
              codeEvidence(change.path, added.line, content, 'Query construction in context.'),
            ],
            whyItMatters: 'Parameter binding is the only reliable separation between SQL syntax and data. Interpolation makes every caller of this function an injection surface.',
            consequences: ['Data exfiltration across tenants', 'Data modification or deletion', 'Authentication bypass when the query guards a login'],
            recommendation: 'Use bound parameters (`$1`, `?`, named parameters) and pass values separately. Never build query text from request data.',
            tags: ['CWE-89', 'injection'],
          }));
        }
      }
      return out;
    },
  };
}

/** Shell execution with interpolated input. */
function commandInjection(): Rule {
  return {
    id: 'security.command-injection',
    category: 'security',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\b(exec|execSync|spawnSync|spawn|execFileSync)\s*\(/.test(added.text)) continue;
          if (!/\$\{|\+\s*[A-Za-z_$]/.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'security.command-injection',
            title: 'Shell command assembled from runtime values',
            description: 'A process is started with a command string that contains interpolated or concatenated values, and the shell interprets the result.',
            severity: 'critical',
            category: 'security',
            kind: 'problem',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Command string built from runtime data.'),
              codeEvidence(change.path, added.line, content, 'Process invocation context.'),
            ],
            whyItMatters: 'Shell metacharacters (`;`, `&&`, `$()`, backticks) inside an interpolated value become additional commands.',
            consequences: ['Arbitrary command execution on the host or container', 'Exfiltration of mounted credentials'],
            recommendation: 'Use `execFile`/`spawn` with an argument array and `shell: false`. Validate arguments against an allow-list when they originate from user input.',
            tags: ['CWE-78'],
          }));
        }
      }
      return out;
    },
  };
}

/** Untrusted text used in a privileged operation without validation. */
function unsafeDeserialisation(): Rule {
  return {
    id: 'security.unsafe-deserialisation',
    category: 'security',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\bunserialize\s*\(|pickle\.loads\s*\(|yaml\.load\s*\([^,)]*\)/.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'security.unsafe-deserialisation',
            title: 'Untrusted payload deserialised with an unsafe loader',
            description: 'A deserialiser that can instantiate arbitrary objects is called. For YAML this is `yaml.load` without `SafeLoader`; for Python it is `pickle.loads`.',
            severity: 'high',
            category: 'security',
            kind: 'problem',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Unsafe deserialiser call.')],
            whyItMatters: 'These formats can encode object construction, which becomes code execution when the payload is attacker-controlled.',
            consequences: ['Remote code execution through an uploaded file or queue message'],
            recommendation: 'Use a data-only format (JSON) or a safe loader (`yaml.safe_load`). If pickle is unavoidable, sign the payload and verify before loading.',
            tags: ['CWE-502'],
          }));
        }
      }
      return out;
    },
  };
}

export const securityRules: Rule[] = [
  {
    id: 'security.patterns',
    category: 'security',
    run: runPatternRules,
  },
  sqlInjection(),
  commandInjection(),
  unsafeDeserialisation(),
];

export { snippetAround };
