/**
 * Contrato de persistencia.
 *
 * Toda a persistencia passa por aqui para que a troca SQLite -> PostgreSQL
 * (Fase 2/5, quando entram pgvector e multiusuario) seja aditiva. Duas
 * consequencias de desenho:
 *
 * 1. A interface e assincrona ainda que o SQLite embutido no Node seja
 *    sincrono. Um adapter Postgres e obrigatoriamente assincrono; espremer isso
 *    depois obrigaria a reescrever todos os chamadores. O custo hoje e um
 *    `await` supersticioso; o custo de nao fazer e o retrabalho que a escolha
 *    do SQLite existia justamente para evitar.
 * 2. Nao ha metodo que devolva "a conexao". Vazar o handle do driver anularia
 *    a abstracao logo no primeiro uso conveniente.
 */

import type {
  ChangeSet,
  CodeEntity,
  CodeRelation,
  EntityType,
  FileRecord,
  RelationType,
  ResolutionTier,
} from '../core/types/index.js';

/**
 * Aresta como esta no banco, com sua chave.
 *
 * O `CodeRelation` puro nao carrega id porque, na extracao, a aresta ainda nao
 * existe. Depois de persistida ela precisa ser enderecavel: sem isso o resolver
 * consegue *encontrar* pendencias mas nao consegue atualiza-las.
 */
export type StoredRelation = CodeRelation & { id: number };

export interface LexicalHit {
  entityId: string;
  /** Score bruto do FTS. Normalizado pelo Relevance Engine, nao aqui. */
  rawScore: number;
}

export type TraversalDirection = 'OUT' | 'IN' | 'BOTH';

export interface NeighborQuery {
  /** Entidades de partida. */
  seedIds: string[];
  /** Profundidade maxima em arestas. */
  depth: number;
  direction: TraversalDirection;
  /** Filtra os tipos de aresta percorridos. Vazio = todos. */
  types?: RelationType[] | undefined;
  /** Descarta arestas abaixo desta confianca — evita propagar palpite fraco. */
  minConfidence?: number | undefined;
  limit?: number | undefined;
}

export interface NeighborResult {
  entityId: string;
  /** Numero de arestas ate a semente mais proxima. */
  hopDistance: number;
  /** Produto das confiancas ao longo do caminho: incerteza acumula. */
  pathConfidence: number;
}

export interface MigrateResult {
  /** O indice foi descartado e recriado por incompatibilidade de schema. */
  recreated: boolean;
}

export interface IndexStats {
  files: number;
  entities: number;
  relations: number;
  unresolvedRelations: number;
  entitiesByType: Record<string, number>;
  filesByLanguage: Record<string, number>;
  totalTokens: number;
  lastScanAt: number | null;
}

export interface Storage {
  /**
   * Cria ou migra o schema. Idempotente.
   *
   * `onVersionMismatch` decide o que fazer com um indice de versao anterior:
   * `'error'` recusa (default, para comandos de leitura, que nao devem apagar
   * dados por conta propria) e `'recreate'` reconstroi do zero. O indice e cache
   * derivado do codigo-fonte, entao recriar custa um rescan — nunca perda de
   * dado do usuario.
   */
  migrate(options?: { onVersionMismatch?: 'error' | 'recreate' }): Promise<MigrateResult>;
  close(): Promise<void>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  getFile(path: string): Promise<FileRecord | null>;
  listFiles(): Promise<FileRecord[]>;
  /** Apenas caminho + hash + mtime + tamanho: o suficiente para o diff incremental. */
  listFileSignatures(): Promise<Array<Pick<FileRecord, 'path' | 'contentHash' | 'mtimeMs' | 'sizeBytes'>>>;

  /**
   * Substitui atomicamente a analise de um arquivo.
   *
   * Escopo deliberado: remove entidades e as arestas que *nascem* no arquivo,
   * e rebaixa a UNRESOLVED as arestas que *apontavam* para entidades removidas
   * — em vez de apaga-las. Uma aresta apagada perde a pista `targetHint` e
   * jamais volta a resolver quando o simbolo reaparecer; e assim que um indice
   * incremental degrada silenciosamente ao longo das reindexacoes.
   */
  replaceFileAnalysis(
    file: FileRecord,
    entities: CodeEntity[],
    relations: CodeRelation[],
  ): Promise<void>;

  /** Remove o arquivo do indice, com o mesmo cuidado de rebaixamento. */
  deleteFile(path: string): Promise<void>;

  getEntity(id: string): Promise<CodeEntity | null>;
  getEntities(ids: string[]): Promise<CodeEntity[]>;
  getEntitiesByFile(path: string): Promise<CodeEntity[]>;
  findEntitiesByName(name: string, types?: EntityType[]): Promise<CodeEntity[]>;

  /** Busca lexical (FTS5). Substitui a busca semantica ate a Fase 2. */
  searchLexical(query: string, limit: number): Promise<LexicalHit[]>;

  /**
   * Arquivos cujo caminho contem algum dos termos.
   *
   * Fonte de sementes separada do FTS de proposito. O bm25 normaliza por
   * tamanho do documento, entao a entidade FILE — que carrega o caminho, todas
   * as assinaturas e todos os literais — sempre perde para uma variavel de tres
   * termos que por acaso casa. O nome do arquivo costuma ser o indicador de
   * assunto mais forte de um codigo, e sem esta consulta ele ficava inalcancavel.
   */
  findFilesByPathTerms(terms: string[], limit: number): Promise<string[]>;

  relationsFrom(entityId: string): Promise<StoredRelation[]>;
  relationsTo(entityId: string): Promise<StoredRelation[]>;
  /** Travessia em largura no grafo, resolvida no banco (CTE recursiva). */
  neighbors(query: NeighborQuery): Promise<NeighborResult[]>;

  /** Arestas pendentes cuja pista bate com um dos nomes — para re-resolucao. */
  findUnresolvedByHint(hints: string[]): Promise<StoredRelation[]>;
  /** Todas as arestas pendentes, para a passada global de resolucao. */
  listUnresolved(limit?: number): Promise<StoredRelation[]>;
  /** Arestas que nascem num arquivo, resolvidas ou nao. */
  relationsInFile(filePath: string): Promise<StoredRelation[]>;
  /** Aplica o resultado de uma passada de resolucao. */
  resolveRelations(
    updates: Array<{
      relationId: number;
      targetId: string;
      resolution: ResolutionTier;
      confidence: number;
    }>,
  ): Promise<void>;

  /** Grau de entrada por entidade — insumo do sinal `fileImportance`. */
  inDegrees(entityIds: string[]): Promise<Map<string, number>>;

  stats(): Promise<IndexStats>;

  /** Diff entre o estado em disco e o indice (spec 9). */
  computeChangeSet(
    current: Array<Pick<FileRecord, 'path' | 'contentHash' | 'mtimeMs' | 'sizeBytes'>>,
  ): Promise<ChangeSet>;
}
