/**
 * Detecção de linguagem por extensão.
 *
 * Extensão é sinal fraco mas barato e suficiente para o MVP. Detecção por
 * conteúdo (shebang, heurística) entra se e quando o benchmark mostrar que a
 * classificação errada está custando recall — antes disso seria otimizar sem
 * evidência.
 */

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.json': 'json',
  '.md': 'markdown',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

/** Linguagens com extrator de AST implementado. */
export const PARSEABLE_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
]);

export const UNKNOWN_LANGUAGE = 'unknown';

export function detectLanguage(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot <= 0) return UNKNOWN_LANGUAGE;

  // Casos como `.d.ts` precisam da extensão composta antes da simples, senão
  // um arquivo de tipos seria classificado só por `.ts` e perderia a distinção.
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.d.ts')) return 'typescript';

  return LANGUAGE_BY_EXTENSION[lower.slice(lastDot)] ?? UNKNOWN_LANGUAGE;
}

export function isParseable(language: string): boolean {
  return PARSEABLE_LANGUAGES.has(language);
}

/**
 * Heurística de binário: um NUL nos primeiros bytes.
 *
 * Verificar só o começo é intencional — ler o arquivo inteiro para classificar
 * anularia o ganho de pular binários, que é justamente não lê-los.
 */
export function looksBinary(sample: Uint8Array): boolean {
  const limit = Math.min(sample.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}
