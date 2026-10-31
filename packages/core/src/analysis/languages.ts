import type { Language } from '../types';

const EXT: Record<string, Language> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx', '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.go': 'go', '.rs': 'rust', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
  '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.mdx': 'markdown',
};

export const CODE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'java', 'kotlin', 'go', 'rust', 'csharp', 'ruby', 'php',
]);

export function isCodeFile(path: string): boolean {
  return CODE_LANGUAGES.has(detectLanguage(path));
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

export function detectLanguage(path: string): Language {
  return EXT[extensionOf(path)] ?? 'other';
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//.test(path)
    || /\.(test|spec)\.[a-z]+$/i.test(path)
    || /(^|\/)test_[^/]+\.py$/.test(path)
    || /_test\.(go|py)$/.test(path)
    || /Tests?\.(java|kt|cs)$/.test(path);
}

export function isDocumentationFile(path: string): boolean {
  if (/\.(md|mdx)$/i.test(path)) return true;
  return /(^|\/)(openapi|asyncapi|swagger)[^/]*\.(ya?ml|json)$/i.test(path);
}

export function isManifestFile(path: string): boolean {
  return /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle|composer\.json|requirements\.txt)$/.test(path);
}

export function isMigrationFile(path: string): boolean {
  return /(^|\/)(migrations?|db\/migrate|schema)\//i.test(path) || /\.sql$/i.test(path);
}

export function isRouteFile(path: string): boolean {
  return /(^|\/)(routes?|controllers?|handlers?|api|endpoints?)\//i.test(path);
}

export function moduleOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  if (parts[0] === 'src' && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts[0]!;
}

export function baseName(path: string): string {
  const b = path.slice(path.lastIndexOf('/') + 1);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}
