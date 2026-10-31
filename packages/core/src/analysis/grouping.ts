import type { ChangeGroup, ChangedSymbol, Evidence, FileChange } from '../types';
import { moduleOf } from './languages';
import { stableId, truncate } from '../util/text';
import { isDocumentationFile, isTestFile } from './languages';

const DOMAIN_HINTS: Array<{ re: RegExp; label: string }> = [
  { re: /payment|charge|invoice|settle|ledger|refund/i, label: 'payment' },
  { re: /auth|login|token|session|permission|role/i, label: 'authentication' },
  { re: /user|account|profile|member/i, label: 'account' },
  { re: /order|cart|checkout|shipment/i, label: 'order' },
  { re: /report|analytic|metric|dashboard/i, label: 'reporting' },
  { re: /config|setting|env|option/i, label: 'configuration' },
  { re: /migration|schema|database|repository/i, label: 'persistence' },
  { re: /test|spec/i, label: 'verification' },
];

function domainOf(text: string): string | null {
  for (const h of DOMAIN_HINTS) if (h.re.test(text)) return h.label;
  return null;
}

/**
 * Group related modifications into semantic change groups.
 *
 * Grouping is intentionally explainable: a group is a module plus the container
 * of the changed symbols inside it. The purpose line is a hypothesis derived
 * from symbol names and diff content, and the report labels it as such.
 */
export function groupChanges(changes: FileChange[], symbols: ChangedSymbol[]): ChangeGroup[] {
  const byModule = new Map<string, FileChange[]>();
  for (const c of changes) {
    const mod = moduleOf(c.path);
    (byModule.get(mod) ?? byModule.set(mod, []).get(mod)!).push(c);
  }

  const groups: ChangeGroup[] = [];
  for (const [mod, files] of byModule) {
    const fileSet = new Set(files.map((f) => f.path));
    const modSymbols = symbols.filter((s) => fileSet.has(s.file));
    const byContainer = new Map<string, ChangedSymbol[]>();
    for (const s of modSymbols) {
      const key = s.container ?? '\u0000top';
      (byContainer.get(key) ?? byContainer.set(key, []).get(key)!).push(s);
    }
    if (byContainer.size === 0) {
      groups.push(makeGroup(mod, mod, files, [], 'diff-content'));
      continue;
    }
    for (const [container, list] of byContainer) {
      const names = [...new Set(list.map((s) => s.name))];
      const label = container === '\u0000top' ? mod : `${mod} › ${container}`;
      groups.push(makeGroup(label, mod, files, list, names.length ? 'symbol-names' : 'diff-content'));
    }
  }

  return groups.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
}

function makeGroup(
  title: string,
  mod: string,
  files: FileChange[],
  symbols: ChangedSymbol[],
  basis: ChangeGroup['purposeBasis'],
): ChangeGroup {
  const names = [...new Set(symbols.map((s) => s.name))];
  const fileNames = files.map((f) => f.path);
  const domain = domainOf(`${names.join(' ')} ${fileNames.join(' ')}`) ?? 'behaviour';
  const changedFiles = files.filter((f) => f.status !== 'deleted').length;
  const verbs = new Set<string>();
  for (const s of symbols) {
    if (s.change === 'added') verbs.add('adds');
    else if (s.change === 'removed') verbs.add('removes');
    else verbs.add('changes');
  }
  const verb = verbs.size === 0 ? 'modifies' : [...verbs].join('/');
  const purpose = names.length
    ? `${verb} ${domain} logic in ${files.length} file(s) — ${names.slice(0, 4).map((n) => `\`${n}\``).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}. Inferred from changed symbol names.`
    : `${verb} ${changedFiles} ${domain} file(s) in \`${mod}\`; no parseable symbols were found, so this group is based on the diff alone.`;

  const evidence: Evidence[] = files.slice(0, 4).map((f) => ({
    kind: 'diff',
    file: f.path,
    line: f.hunks[0]?.newStart ?? 1,
    snippet: `${f.status} · +${f.additions} −${f.deletions}${isTestFile(f.path) ? ' · test' : ''}${isDocumentationFile(f.path) ? ' · documentation' : ''}`,
    note: 'File included in this group.',
    source: 'deterministic',
  }));

  const changeTypes = new Set<ChangedSymbol['change']>();
  for (const s of symbols) changeTypes.add(s.change);

  return {
    id: stableId('grp', mod, title, names.join(',')),
    title: truncate(title, 90),
    purpose,
    module: mod,
    files: fileNames,
    symbols: names,
    changeTypes: [...changeTypes],
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    purposeBasis: basis,
    evidence,
  };
}
