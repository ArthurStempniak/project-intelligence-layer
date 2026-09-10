/**
 * Fachada de parsing: fonte → entidades + relações.
 *
 * Mantém um `Parser` do tree-sitter por linguagem, reaproveitado entre arquivos.
 * Instanciar um por arquivo dominaria o custo da indexação — o parse em si é
 * rápido, a construção do parser não.
 */

import type { Tree } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';

import type { ParseState } from '../core/types/index.js';
import { createParser, hasGrammar } from './grammars.js';
import type { ExtractionInput, ExtractionResult, Extractor } from './extraction.js';
import { TypeScriptExtractor } from './extractors/typescript.js';
import { PythonExtractor } from './extractors/python.js';

export interface ParseOutcome extends ExtractionResult {
  parseState: ParseState;
  parseError?: string | undefined;
}

const EXTRACTORS: Readonly<Record<string, () => Extractor>> = {
  typescript: () => new TypeScriptExtractor(),
  tsx: () => new TypeScriptExtractor(),
  javascript: () => new TypeScriptExtractor(),
  python: () => new PythonExtractor(),
};

export class CodeParser {
  readonly #parsers = new Map<string, Parser>();
  readonly #extractors = new Map<string, Extractor>();

  static supports(language: string): boolean {
    return language in EXTRACTORS && hasGrammar(language);
  }

  async parse(input: ExtractionInput): Promise<ParseOutcome> {
    if (!CodeParser.supports(input.language)) {
      return { entities: [], relations: [], parseState: 'UNSUPPORTED_LANGUAGE' };
    }

    let tree: Tree | null;
    try {
      const parser = await this.#parserFor(input.language);
      tree = parser.parse(input.source);
    } catch (error) {
      return {
        entities: [],
        relations: [],
        parseState: 'PARSE_ERROR',
        parseError: (error as Error).message,
      };
    }

    if (!tree) {
      return { entities: [], relations: [], parseState: 'PARSE_ERROR', parseError: 'parse vazio' };
    }

    try {
      const result = this.#extractorFor(input.language).extract(tree, input);

      /*
       * `hasError` sinaliza sintaxe inválida, mas a extração continua valendo:
       * tree-sitter é tolerante a erro e produz uma árvore parcial. Um arquivo
       * em edição, com um parêntese faltando, ainda tem símbolos úteis — e
       * descartá-los deixaria o índice cego justamente no arquivo em que o
       * usuário está trabalhando.
       */
      return tree.rootNode.hasError
        ? { ...result, parseState: 'PARSE_ERROR', parseError: 'sintaxe inválida (extração parcial)' }
        : { ...result, parseState: 'OK' };
    } finally {
      tree.delete();
    }
  }

  /** Libera os parsers WASM. */
  dispose(): void {
    for (const parser of this.#parsers.values()) parser.delete();
    this.#parsers.clear();
  }

  async #parserFor(language: string): Promise<Parser> {
    const existing = this.#parsers.get(language);
    if (existing) return existing;

    const parser = await createParser(language);
    this.#parsers.set(language, parser);
    return parser;
  }

  #extractorFor(language: string): Extractor {
    const existing = this.#extractors.get(language);
    if (existing) return existing;

    const factory = EXTRACTORS[language];
    if (!factory) throw new Error(`sem extrator para ${language}`);

    const extractor = factory();
    this.#extractors.set(language, extractor);
    return extractor;
  }
}
