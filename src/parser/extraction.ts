/**
 * Contrato dos extratores de linguagem.
 *
 * Cada linguagem traduz sua AST para o modelo semântico universal. O resto do
 * PIL nunca vê um nó de tree-sitter — é o que permite acrescentar uma linguagem
 * sem tocar no Context Engine, no grafo ou na CLI.
 */

import type { Node, Tree } from 'web-tree-sitter';

import type { CodeEntity, CodeRelation, EntityType, RelationType } from '../core/types/index.js';
import { confidenceForTier } from '../core/types/index.js';
import { makeEntityId, makeFileEntityId, makeFingerprint, qualifyName } from '../core/ids.js';
import { estimateTokens } from '../core/tokens.js';
import { extractLiteralTerms } from '../core/text.js';

export interface ExtractionInput {
  /** Caminho relativo à raiz, separador POSIX. */
  filePath: string;
  language: string;
  source: string;
}

export interface ExtractionResult {
  entities: CodeEntity[];
  relations: CodeRelation[];
}

export interface Extractor {
  extract(tree: Tree, input: ExtractionInput): ExtractionResult;
}

/**
 * Acumulador usado pelos extratores.
 *
 * Centraliza o que toda linguagem precisa fazer igual — desambiguar homônimos,
 * calcular fingerprint, estimar tokens, recortar assinatura — para que o
 * extrator de cada linguagem cuide só do que é específico dela: quais nós da AST
 * viram qual tipo de entidade.
 */
export class ExtractionBuilder {
  readonly #input: ExtractionInput;
  readonly #entities: CodeEntity[] = [];
  readonly #relations: CodeRelation[] = [];
  /** Contador por nome qualificado, para o sufixo `~n` de desempate. */
  readonly #seen = new Map<string, number>();
  readonly #fileEntityId: string;

  constructor(input: ExtractionInput) {
    this.#input = input;
    this.#fileEntityId = makeFileEntityId(input.filePath);
    this.#entities.push(this.#buildFileEntity());
  }

  get fileEntityId(): string {
    return this.#fileEntityId;
  }

  #buildFileEntity(): CodeEntity {
    const { filePath, language, source } = this.#input;
    return {
      id: this.#fileEntityId,
      type: 'FILE',
      name: filePath.slice(filePath.lastIndexOf('/') + 1),
      qualifiedName: filePath,
      language,
      filePath,
      startLine: 1,
      endLine: Math.max(1, source.split('\n').length),
      startByte: 0,
      endByte: source.length,
      exported: true,
      fingerprint: makeFingerprint(source),
      tokenEstimate: estimateTokens(source),
      literals: extractLiteralTerms(source),
    };
  }

  /**
   * Registra uma entidade e devolve seu id, para servir de `parentId` das
   * entidades aninhadas dentro dela.
   */
  addEntity(params: {
    type: EntityType;
    name: string;
    scopeChain: readonly string[];
    node: Node;
    parentId: string;
    signature?: string | undefined;
    documentation?: string | undefined;
    exported: boolean;
    metadata?: Record<string, unknown> | undefined;
  }): string {
    const qualifiedName = qualifyName(params.scopeChain, params.name);
    const key = `${params.type}:${qualifiedName}`;
    const ordinal = this.#seen.get(key) ?? 0;
    this.#seen.set(key, ordinal + 1);

    const id = makeEntityId({
      filePath: this.#input.filePath,
      type: params.type,
      qualifiedName,
      ordinal,
    });

    const slice = this.#input.source.slice(params.node.startIndex, params.node.endIndex);

    this.#entities.push({
      id,
      type: params.type,
      name: params.name,
      qualifiedName,
      language: this.#input.language,
      filePath: this.#input.filePath,
      parentId: params.parentId,
      // tree-sitter conta linhas a partir de 0; o modelo usa 1-indexado porque
      // é o que editores e mensagens de erro mostram.
      startLine: params.node.startPosition.row + 1,
      endLine: params.node.endPosition.row + 1,
      startByte: params.node.startIndex,
      endByte: params.node.endIndex,
      signature: params.signature,
      documentation: params.documentation,
      exported: params.exported,
      fingerprint: makeFingerprint(slice),
      tokenEstimate: estimateTokens(slice),
      // Reaproveita o trecho ja recortado: extrair literais nao custa uma
      // segunda leitura do arquivo nem uma segunda travessia da arvore.
      literals: extractLiteralTerms(slice),
      metadata: params.metadata,
    });

    return id;
  }

  /**
   * Registra uma aresta ainda não resolvida.
   *
   * Extratores nunca resolvem alvos: eles só sabem o que está escrito no
   * arquivo. A resolução precisa do índice do projeto inteiro e acontece depois,
   * em `resolver.ts` — separação que também é o que permite reprocessar um
   * arquivo isolado sem reabrir os outros.
   */
  addRelation(params: {
    sourceId: string;
    type: RelationType;
    targetHint: string;
    node: Node;
    metadata?: Record<string, unknown> | undefined;
  }): void {
    this.#relations.push({
      sourceId: params.sourceId,
      targetId: null,
      targetHint: params.targetHint,
      type: params.type,
      resolution: 'UNRESOLVED',
      confidence: confidenceForTier('UNRESOLVED'),
      filePath: this.#input.filePath,
      line: params.node.startPosition.row + 1,
      metadata: params.metadata,
    });
  }

  build(): ExtractionResult {
    return { entities: this.#entities, relations: this.#relations };
  }
}

/**
 * Assinatura: o texto do nó menos o corpo.
 *
 * Base da compressão da spec §15 — é o que permite enviar o contrato de uma
 * função sem enviar a implementação. Colapsa espaços em branco porque
 * identação e quebras de linha de uma lista de parâmetros longa custariam
 * tokens sem acrescentar informação.
 */
export function signatureOf(node: Node, source: string, bodyField = 'body'): string {
  const body = node.childForFieldName(bodyField);
  const end = body ? body.startIndex : node.endIndex;
  return source.slice(node.startIndex, end).replace(/\s+/g, ' ').trim();
}

/**
 * Documentação imediatamente anterior ao nó.
 *
 * Só aceita um comentário colado (no máximo uma linha em branco de distância):
 * um comentário separado por várias linhas quase sempre pertence à seção, não à
 * declaração, e atribuí-lo à entidade poluiria o índice de busca com termos que
 * não descrevem aquele símbolo.
 */
export function documentationOf(node: Node, source: string): string | undefined {
  let candidate = node.previousNamedSibling;
  // Declarações exportadas ficam embrulhadas: o comentário é irmão do wrapper.
  if (!candidate && node.parent?.type === 'export_statement') {
    candidate = node.parent.previousNamedSibling;
  }
  if (!candidate || !candidate.type.includes('comment')) return undefined;

  const between = source.slice(candidate.endIndex, node.startIndex);
  if ((between.match(/\n/g) ?? []).length > 2) return undefined;

  return cleanComment(candidate.text);
}

export function cleanComment(raw: string): string | undefined {
  const cleaned = raw
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\*+|\/\/+|#)\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

/** Percorre a árvore em profundidade, permitindo ao visitante podar subárvores. */
export function walk(node: Node, visit: (node: Node) => boolean | void): void {
  const shouldDescend = visit(node);
  if (shouldDescend === false) return;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child) walk(child, visit);
  }
}
