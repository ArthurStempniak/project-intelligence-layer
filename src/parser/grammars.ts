/**
 * Carregamento das gramáticas tree-sitter.
 *
 * As gramáticas vêm como `.wasm` pré-compilado dentro dos pacotes npm, o que é
 * o que torna a instalação livre de compilador (ver ARCHITECTURE.md §3.3).
 *
 * O carregamento é preguiçoso e memoizado: um projeto só TypeScript não deve
 * pagar o custo de instanciar a gramática de Python, e um projeto com 10 mil
 * arquivos não deve instanciá-la 10 mil vezes.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

import { PilError } from '../core/errors.js';

const require = createRequire(import.meta.url);

/**
 * Onde mora o `.wasm` de cada linguagem.
 *
 * Resolvido via `package.json` do pacote, e não por caminho relativo a
 * `node_modules`: com pnpm, yarn PnP ou workspaces, o layout físico de
 * `node_modules` não é previsível, mas a resolução de módulo do Node é.
 */
const GRAMMAR_LOCATIONS: Readonly<Record<string, { pkg: string; file: string }>> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
};

let initialized: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();

/** `Parser.init()` é global e só pode rodar uma vez por processo. */
async function ensureInitialized(): Promise<void> {
  initialized ??= Parser.init();
  await initialized;
}

export function grammarPath(language: string): string {
  const location = GRAMMAR_LOCATIONS[language];
  if (!location) {
    throw new PilError(
      'PARSER_UNAVAILABLE',
      `Sem gramática registrada para a linguagem "${language}".`,
    );
  }
  return join(dirname(require.resolve(`${location.pkg}/package.json`)), location.file);
}

export function hasGrammar(language: string): boolean {
  return language in GRAMMAR_LOCATIONS;
}

export async function loadLanguage(language: string): Promise<Language> {
  const cached = languageCache.get(language);
  if (cached) return cached;

  const loading = (async () => {
    await ensureInitialized();
    try {
      return await Language.load(grammarPath(language));
    } catch (error) {
      throw new PilError(
        'PARSER_UNAVAILABLE',
        `Falha ao carregar a gramática de "${language}": ${(error as Error).message}`,
        'Rode `npm install` para restaurar os pacotes tree-sitter.',
      );
    }
  })();

  languageCache.set(language, loading);
  return loading;
}

/**
 * Parser configurado para uma linguagem.
 *
 * Um `Parser` do tree-sitter é stateful e não é seguro compartilhar entre
 * análises concorrentes, então cada chamada devolve uma instância nova — a
 * `Language`, essa sim cara de construir, é que fica em cache.
 */
export async function createParser(language: string): Promise<Parser> {
  // A gramática é carregada ANTES de construir o parser: `loadLanguage` é quem
  // garante o `Parser.init()`, e o construtor lança se o runtime WASM ainda não
  // subiu. Inverter estas duas linhas quebra tudo silenciosamente — o erro sai
  // como PARSE_ERROR por arquivo, não como falha de inicialização.
  const grammar = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}
