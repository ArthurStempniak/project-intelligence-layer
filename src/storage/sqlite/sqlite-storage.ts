/**
 * Adapter SQLite sobre o `node:sqlite` embutido no Node 22.
 *
 * Escolha do driver: `node:sqlite` em vez de `better-sqlite3` elimina a unica
 * dependencia nativa do projeto — nada de node-gyp/MSVC, que e onde a
 * instalacao costuma falhar no Windows. A API e sincrona e praticamente
 * identica a do `better-sqlite3`, entao a troca, se necessaria, fica contida
 * neste arquivo.
 */

import { DatabaseSync } from './driver.js';
import type { SQLOutputValue } from './driver.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ChangeSet,
  CodeEntity,
  CodeRelation,
  EntityType,
  FileRecord,
  ParseState,
  RelationType,
  ResolutionTier,
} from '../../core/types/index.js';
import { PilError } from '../../core/errors.js';
import { buildSearchTerms } from '../../core/text.js';
import type {
  IndexStats,
  LexicalHit,
  NeighborQuery,
  NeighborResult,
  MigrateResult,
  Storage,
  StoredRelation,
} from '../storage.js';
import { META_KEYS, PRAGMAS, SCHEMA_SQL, SCHEMA_VERSION } from './migrations.js';

/**
 * As interfaces de linha estendem o `Record<string, SQLOutputValue>` que o
 * `node:sqlite` devolve. Sem isso, cada `.all()` precisaria de um duplo cast
 * `as unknown as`, que desliga a checagem em vez de descreve-la — assim o
 * compilador ainda verifica que os campos declarados sao tipos que o SQLite
 * realmente sabe produzir.
 */
interface EntityRow extends Record<string, SQLOutputValue> {
  id: string;
  type: string;
  name: string;
  qualified_name: string;
  language: string;
  file_path: string;
  parent_id: string | null;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  signature: string | null;
  documentation: string | null;
  exported: number;
  fingerprint: string;
  token_estimate: number;
  literals: string | null;
  metadata: string | null;
}

interface RelationRow extends Record<string, SQLOutputValue> {
  id: number;
  source_id: string;
  target_id: string | null;
  target_hint: string;
  type: string;
  resolution: string;
  confidence: number;
  file_path: string;
  line: number;
  metadata: string | null;
}

interface FileRow extends Record<string, SQLOutputValue> {
  path: string;
  language: string;
  size_bytes: number;
  line_count: number;
  content_hash: string;
  parse_state: string;
  parse_error: string | null;
  indexed_at: number;
  mtime_ms: number;
  token_estimate: number;
}

function toEntity(row: EntityRow): CodeEntity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    qualifiedName: row.qualified_name,
    language: row.language,
    filePath: row.file_path,
    parentId: row.parent_id ?? undefined,
    startLine: row.start_line,
    endLine: row.end_line,
    startByte: row.start_byte,
    endByte: row.end_byte,
    signature: row.signature ?? undefined,
    documentation: row.documentation ?? undefined,
    exported: row.exported === 1,
    fingerprint: row.fingerprint,
    tokenEstimate: row.token_estimate,
    literals: row.literals ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function toRelation(row: RelationRow): StoredRelation {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    targetHint: row.target_hint,
    type: row.type as RelationType,
    resolution: row.resolution as ResolutionTier,
    confidence: row.confidence,
    filePath: row.file_path,
    line: row.line,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function toFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    language: row.language,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    contentHash: row.content_hash,
    parseState: row.parse_state as ParseState,
    parseError: row.parse_error ?? undefined,
    indexedAt: row.indexed_at,
    mtimeMs: row.mtime_ms,
    tokenEstimate: row.token_estimate,
  };
}

/**
 * SQLite limita o numero de parametros por statement. Consultas por lista de
 * ids sao fatiadas para nunca esbarrar nisso — um projeto de 100k arquivos
 * passa listas grandes por aqui.
 */
const PARAM_CHUNK = 400;


function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

export class SqliteStorage implements Storage {
  readonly #db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    for (const pragma of PRAGMAS) this.#db.exec(pragma);
  }

  /**
   * Traduz a ausencia de FTS5 num erro que diz o que fazer.
   *
   * O `node:sqlite` embutido so passou a trazer FTS5 no Node 22.16. Em versoes
   * anteriores todo `pil scan` morria com `no such module: fts5`, mensagem que
   * nao aponta para nada acionavel. Descoberto pela CI numa matriz de versoes,
   * depois de o `engines` afirmar 22.13 sem nunca ter sido testado lah.
   */
  #exigirFts5(erro: unknown): never {
    const mensagem = (erro as Error).message ?? String(erro);
    if (mensagem.includes('fts5')) {
      throw new PilError(
        'STORAGE_ERROR',
        `Esta versao do Node (${process.version}) nao traz FTS5 no modulo node:sqlite.`,
        'O PIL precisa de Node 22.16 ou superior. Atualize o Node e rode `pil scan` de novo.',
      );
    }
    throw erro;
  }

  async migrate(options: { onVersionMismatch?: 'error' | 'recreate' } = {}): Promise<MigrateResult> {
    // Le a versao antes de aplicar o DDL: `CREATE TABLE IF NOT EXISTS` sobre um
    // schema antigo nao falha nem altera nada, e a incompatibilidade so
    // apareceria mais tarde, como coluna faltando no meio de uma consulta.
    const existing = this.#readSchemaVersion();

    if (existing !== null && existing !== SCHEMA_VERSION) {
      // Sem migracao incremental ate a v1.0: o schema ainda muda com
      // frequencia, e manter migrations de um formato instavel custa mais do
      // que um rescan.
      if (options.onVersionMismatch !== 'recreate') {
        throw new PilError(
          'SCHEMA_VERSION_MISMATCH',
          `Indice na versao ${existing}, esperado ${SCHEMA_VERSION}.`,
          'Rode `pil scan` para reconstruir o indice.',
        );
      }
      this.#dropSchema();
      try {
        this.#db.exec(SCHEMA_SQL);
      } catch (erro) {
        this.#exigirFts5(erro);
      }
      await this.setMeta(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
      return { recreated: true };
    }

    try {
      this.#db.exec(SCHEMA_SQL);
    } catch (erro) {
      this.#exigirFts5(erro);
    }
    if (existing === null) {
      await this.setMeta(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
    }
    return { recreated: false };
  }

  /** Le a versao tolerando a tabela de meta ainda nao existir. */
  #readSchemaVersion(): number | null {
    try {
      const row = this.#db
        .prepare('SELECT value FROM pil_meta WHERE key = ?')
        .get(META_KEYS.schemaVersion) as { value: string } | undefined;
      return row === undefined ? null : Number(row.value);
    } catch {
      return null;
    }
  }

  #dropSchema(): void {
    // Ordem: FTS e tabelas dependentes antes das referenciadas.
    for (const statement of [
      'DROP TABLE IF EXISTS entities_fts',
      'DROP TABLE IF EXISTS relations',
      'DROP TABLE IF EXISTS entities',
      'DROP TABLE IF EXISTS files',
      'DROP TABLE IF EXISTS pil_meta',
    ]) {
      this.#db.exec(statement);
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.#db.prepare('SELECT value FROM pil_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#db
      .prepare(
        'INSERT INTO pil_meta(key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  async getFile(path: string): Promise<FileRecord | null> {
    const row = this.#db.prepare('SELECT * FROM files WHERE path = ?').get(path) as
      | FileRow
      | undefined;
    return row ? toFileRecord(row) : null;
  }

  async listFiles(): Promise<FileRecord[]> {
    const rows = this.#db.prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
    return rows.map(toFileRecord);
  }

  async listFileSignatures(): Promise<
    Array<Pick<FileRecord, 'path' | 'contentHash' | 'mtimeMs' | 'sizeBytes'>>
  > {
    const rows = this.#db
      .prepare('SELECT path, content_hash, mtime_ms, size_bytes FROM files')
      .all() as Array<{
      path: string;
      content_hash: string;
      mtime_ms: number;
      size_bytes: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      contentHash: row.content_hash,
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes,
    }));
  }

  async replaceFileAnalysis(
    file: FileRecord,
    entities: CodeEntity[],
    relations: CodeRelation[],
  ): Promise<void> {
    this.#transaction(() => {
      this.#purgeFile(file.path);
      this.#insertFile(file);
      for (const entity of entities) this.#insertEntity(entity);
      for (const relation of relations) this.#insertRelation(relation);
    });
  }

  async deleteFile(path: string): Promise<void> {
    this.#transaction(() => {
      this.#purgeFile(path);
      this.#db.prepare('DELETE FROM files WHERE path = ?').run(path);
    });
  }

  async getEntity(id: string): Promise<CodeEntity | null> {
    const row = this.#db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  async getEntities(ids: string[]): Promise<CodeEntity[]> {
    const out: CodeEntity[] = [];
    for (const chunk of chunked(ids, PARAM_CHUNK)) {
      const rows = this.#db
        .prepare(`SELECT * FROM entities WHERE id IN (${placeholders(chunk.length)})`)
        .all(...chunk) as EntityRow[];
      for (const row of rows) out.push(toEntity(row));
    }
    return out;
  }

  async getEntitiesByFile(path: string): Promise<CodeEntity[]> {
    const rows = this.#db
      .prepare('SELECT * FROM entities WHERE file_path = ? ORDER BY start_line')
      .all(path) as EntityRow[];
    return rows.map(toEntity);
  }

  async findEntitiesByName(name: string, types?: EntityType[]): Promise<CodeEntity[]> {
    // Casa tanto pelo nome local quanto pelo qualificado: a tarefa pode citar
    // `create` ou `ClientService.create`, e ambos precisam encontrar o alvo.
    const typeFilter = types?.length ? ` AND type IN (${placeholders(types.length)})` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM entities WHERE (name = ? OR qualified_name = ?)${typeFilter}`)
      .all(name, name, ...(types ?? [])) as EntityRow[];
    return rows.map(toEntity);
  }

  async searchLexical(query: string, limit: number): Promise<LexicalHit[]> {
    if (query.trim() === '') return [];
    // bm25() devolve valores negativos, mais negativo = melhor. Invertido aqui
    // para que "maior e melhor" valha em toda a pipeline de scoring.
    /*
     * Pesos de coluna do bm25: identificador vale 4x um literal de texto.
     *
     * Sem o peso, um componente que menciona "cliente" numa string competiria de
     * igual para igual com a funcao `createClient`. Com ele, o literal continua
     * capaz de descobrir o arquivo certo quando nada mais casa — que e a razao
     * de indexa-lo — mas nao rouba o topo de um casamento estrutural.
     *
     * A ordem dos pesos segue a ordem das colunas na tabela FTS:
     * (entity_id, terms, literals).
     */
    const rows = this.#db
      .prepare(
        `SELECT entity_id, -bm25(entities_fts, 0.0, 4.0, 1.0) AS raw_score
         FROM entities_fts
         WHERE entities_fts MATCH ?
         ORDER BY raw_score DESC
         LIMIT ?`,
      )
      .all(query, limit) as Array<{ entity_id: string; raw_score: number }>;
    return rows.map((row) => ({ entityId: row.entity_id, rawScore: row.raw_score }));
  }

  async findFilesByPathTerms(terms: string[], limit: number): Promise<string[]> {
    // O filtro de tamanho e a derivacao de prefixo ficam em `pathSearchTerms`,
    // junto das outras regras de termo; aqui so se consulta o que chega.
    const usable = terms.filter((term) => term.length > 0);
    if (usable.length === 0) return [];

    // LIKE em vez de FTS: e o caminho literal que interessa, e o LIKE do SQLite
    // ja e case-insensitive para ASCII, que e o que um caminho contem.
    const clauses = usable.map(() => 'path LIKE ?').join(' OR ');
    const rows = this.#db
      .prepare(`SELECT path FROM files WHERE ${clauses} ORDER BY LENGTH(path) ASC LIMIT ?`)
      .all(...usable.map((term) => `%${term}%`), limit) as Array<{ path: string }>;

    return rows.map((row) => row.path);
  }

  async relationsFrom(entityId: string): Promise<StoredRelation[]> {
    const rows = this.#db
      .prepare('SELECT * FROM relations WHERE source_id = ?')
      .all(entityId) as RelationRow[];
    return rows.map(toRelation);
  }

  async relationsTo(entityId: string): Promise<StoredRelation[]> {
    const rows = this.#db
      .prepare('SELECT * FROM relations WHERE target_id = ?')
      .all(entityId) as RelationRow[];
    return rows.map(toRelation);
  }

  /**
   * Travessia em largura resolvida dentro do banco.
   *
   * Fica em SQL (CTE recursiva, portavel para PostgreSQL) em vez de um laco em
   * TypeScript porque a alternativa seria trazer as arestas de cada nivel para
   * a aplicacao — em um grafo de centenas de milhares de arestas o custo esta
   * no transporte, nao na travessia.
   *
   * `pathConfidence` multiplica as confiancas ao longo do caminho: dois saltos
   * heuristicos valem menos que um, e a analise de impacto precisa enxergar
   * essa diferenca em vez de tratar todo alcance como equivalente.
   */
  async neighbors(query: NeighborQuery): Promise<NeighborResult[]> {
    if (query.seedIds.length === 0 || query.depth < 1) return [];

    const minConfidence = query.minConfidence ?? 0;
    const typeFilter = query.types?.length
      ? `AND r.type IN (${placeholders(query.types.length)})`
      : '';

    // A direcao decide qual ponta da aresta e o proximo no. BOTH percorre as
    // duas pontas, o que exige projetar o no seguinte condicionalmente.
    const step =
      query.direction === 'OUT'
        ? 'r.source_id = w.entity_id AND r.target_id IS NOT NULL'
        : query.direction === 'IN'
          ? 'r.target_id = w.entity_id'
          : '(r.source_id = w.entity_id OR r.target_id = w.entity_id) AND r.target_id IS NOT NULL';

    const nextNode =
      query.direction === 'OUT'
        ? 'r.target_id'
        : query.direction === 'IN'
          ? 'r.source_id'
          : 'CASE WHEN r.source_id = w.entity_id THEN r.target_id ELSE r.source_id END';

    const results: NeighborResult[] = [];
    for (const seedChunk of chunked(query.seedIds, PARAM_CHUNK)) {
      const sql = `
        WITH RECURSIVE walk(entity_id, hop, path_confidence) AS (
          SELECT id, 0, 1.0 FROM entities WHERE id IN (${placeholders(seedChunk.length)})
          UNION
          SELECT ${nextNode}, w.hop + 1, w.path_confidence * r.confidence
          FROM walk w
          JOIN relations r ON ${step} ${typeFilter}
          WHERE w.hop < ? AND r.confidence >= ?
        )
        SELECT entity_id, MIN(hop) AS hop, MAX(path_confidence) AS path_confidence
        FROM walk
        GROUP BY entity_id
        ORDER BY hop ASC, path_confidence DESC
        LIMIT ?`;

      const rows = this.#db
        .prepare(sql)
        .all(
          ...seedChunk,
          ...(query.types ?? []),
          query.depth,
          minConfidence,
          query.limit ?? 5000,
        ) as Array<{ entity_id: string; hop: number; path_confidence: number }>;

      for (const row of rows) {
        results.push({
          entityId: row.entity_id,
          hopDistance: row.hop,
          pathConfidence: row.path_confidence,
        });
      }
    }
    return results;
  }

  async findUnresolvedByHint(hints: string[]): Promise<StoredRelation[]> {
    const out: StoredRelation[] = [];
    for (const chunk of chunked(hints, PARAM_CHUNK)) {
      const rows = this.#db
        .prepare(
          `SELECT * FROM relations
           WHERE target_id IS NULL AND target_hint IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as RelationRow[];
      for (const row of rows) out.push(toRelation(row));
    }
    return out;
  }

  async listUnresolved(limit = 100_000): Promise<StoredRelation[]> {
    const rows = this.#db
      .prepare('SELECT * FROM relations WHERE target_id IS NULL LIMIT ?')
      .all(limit) as RelationRow[];
    return rows.map(toRelation);
  }

  async relationsInFile(filePath: string): Promise<StoredRelation[]> {
    const rows = this.#db
      .prepare('SELECT * FROM relations WHERE file_path = ?')
      .all(filePath) as RelationRow[];
    return rows.map(toRelation);
  }

  async resolveRelations(
    updates: Array<{
      relationId: number;
      targetId: string;
      resolution: ResolutionTier;
      confidence: number;
    }>,
  ): Promise<void> {
    const stmt = this.#db.prepare(
      'UPDATE relations SET target_id = ?, resolution = ?, confidence = ? WHERE id = ?',
    );
    this.#transaction(() => {
      for (const u of updates) stmt.run(u.targetId, u.resolution, u.confidence, u.relationId);
    });
  }

  async inDegrees(entityIds: string[]): Promise<Map<string, number>> {
    const degrees = new Map<string, number>(entityIds.map((id) => [id, 0]));
    for (const chunk of chunked(entityIds, PARAM_CHUNK)) {
      const rows = this.#db
        .prepare(
          `SELECT target_id, COUNT(*) AS n FROM relations
           WHERE target_id IN (${placeholders(chunk.length)})
           GROUP BY target_id`,
        )
        .all(...chunk) as Array<{ target_id: string; n: number }>;
      for (const row of rows) degrees.set(row.target_id, row.n);
    }
    return degrees;
  }

  async stats(): Promise<IndexStats> {
    const one = <T>(sql: string): T => this.#db.prepare(sql).get() as T;

    const files = one<{ n: number }>('SELECT COUNT(*) AS n FROM files').n;
    const entities = one<{ n: number }>('SELECT COUNT(*) AS n FROM entities').n;
    const relations = one<{ n: number }>('SELECT COUNT(*) AS n FROM relations').n;
    const unresolved = one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relations WHERE target_id IS NULL',
    ).n;
    const totalTokens = one<{ n: number | null }>(
      'SELECT SUM(token_estimate) AS n FROM files',
    ).n;

    const byType = this.#db
      .prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type')
      .all() as Array<{ type: string; n: number }>;
    const byLanguage = this.#db
      .prepare('SELECT language, COUNT(*) AS n FROM files GROUP BY language')
      .all() as Array<{ language: string; n: number }>;

    const lastScan = await this.getMeta(META_KEYS.lastScanAt);

    return {
      files,
      entities,
      relations,
      unresolvedRelations: unresolved,
      entitiesByType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      filesByLanguage: Object.fromEntries(byLanguage.map((r) => [r.language, r.n])),
      totalTokens: totalTokens ?? 0,
      lastScanAt: lastScan === null ? null : Number(lastScan),
    };
  }

  async computeChangeSet(
    current: Array<Pick<FileRecord, 'path' | 'contentHash' | 'mtimeMs' | 'sizeBytes'>>,
  ): Promise<ChangeSet> {
    const indexed = new Map((await this.listFileSignatures()).map((f) => [f.path, f]));

    const added: string[] = [];
    const modified: string[] = [];
    let unchangedCount = 0;

    for (const file of current) {
      const known = indexed.get(file.path);
      if (!known) {
        added.push(file.path);
        continue;
      }
      indexed.delete(file.path);
      // O hash decide. mtime e tamanho ja filtraram candidatos antes daqui, no
      // scanner; usar mtime como prova de mudanca causaria reindexacao completa
      // a cada checkout do git, que reescreve mtimes sem alterar conteudo.
      if (known.contentHash === file.contentHash) unchangedCount += 1;
      else modified.push(file.path);
    }

    return { added, modified, deleted: [...indexed.keys()], unchangedCount };
  }

  // --- internos -----------------------------------------------------------

  #transaction(fn: () => void): void {
    this.#db.exec('BEGIN');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Remove a analise de um arquivo preservando as pistas de resolucao.
   *
   * O rebaixamento e o ponto delicado: arestas vindas de *outros* arquivos que
   * apontavam para entidades daqui voltam a UNRESOLVED mantendo `target_hint`,
   * em vez de serem apagadas. Se fossem apagadas, salvar um arquivo destruiria
   * permanentemente arestas que o proximo scan reconstruiria — o indice iria
   * perdendo conectividade a cada edicao, sem erro visivel.
   */
  #purgeFile(path: string): void {
    this.#db
      .prepare(
        `DELETE FROM entities_fts
         WHERE rowid IN (SELECT rowid FROM entities WHERE file_path = ?)`,
      )
      .run(path);

    this.#db
      .prepare(
        `UPDATE relations
         SET target_id = NULL, resolution = 'UNRESOLVED', confidence = 0.0
         WHERE target_id IN (SELECT id FROM entities WHERE file_path = ?)`,
      )
      .run(path);

    this.#db.prepare('DELETE FROM relations WHERE file_path = ?').run(path);
    this.#db.prepare('DELETE FROM entities WHERE file_path = ?').run(path);
  }

  #insertFile(file: FileRecord): void {
    this.#db
      .prepare(
        `INSERT INTO files
           (path, language, size_bytes, line_count, content_hash, parse_state,
            parse_error, indexed_at, mtime_ms, token_estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           language = excluded.language,
           size_bytes = excluded.size_bytes,
           line_count = excluded.line_count,
           content_hash = excluded.content_hash,
           parse_state = excluded.parse_state,
           parse_error = excluded.parse_error,
           indexed_at = excluded.indexed_at,
           mtime_ms = excluded.mtime_ms,
           token_estimate = excluded.token_estimate`,
      )
      .run(
        file.path,
        file.language,
        file.sizeBytes,
        file.lineCount,
        file.contentHash,
        file.parseState,
        file.parseError ?? null,
        file.indexedAt,
        file.mtimeMs,
        file.tokenEstimate,
      );
  }

  #insertEntity(entity: CodeEntity): void {
    const result = this.#db
      .prepare(
        `INSERT INTO entities
           (id, type, name, qualified_name, language, file_path, parent_id,
            start_line, end_line, start_byte, end_byte, signature, documentation,
            exported, fingerprint, token_estimate, literals, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.type,
        entity.name,
        entity.qualifiedName,
        entity.language,
        entity.filePath,
        entity.parentId ?? null,
        entity.startLine,
        entity.endLine,
        entity.startByte,
        entity.endByte,
        entity.signature ?? null,
        entity.documentation ?? null,
        entity.exported ? 1 : 0,
        entity.fingerprint,
        entity.tokenEstimate,
        entity.literals ?? null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
      );

    // O rowid do FTS espelha o da tabela de entidades: e o que torna a remocao
    // por arquivo uma delecao indexada em vez de varredura completa do indice.
    this.#db
      .prepare('INSERT INTO entities_fts(rowid, entity_id, terms, literals) VALUES (?, ?, ?, ?)')
      .run(
        result.lastInsertRowid,
        entity.id,
        buildSearchTerms({
          name: entity.name,
          qualifiedName: entity.qualifiedName,
          signature: entity.signature,
          documentation: entity.documentation,
        }),
        entity.literals ?? '',
      );
  }

  #insertRelation(relation: CodeRelation): void {
    this.#db
      .prepare(
        `INSERT INTO relations
           (source_id, target_id, target_hint, type, resolution, confidence,
            file_path, line, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        relation.sourceId,
        relation.targetId,
        relation.targetHint,
        relation.type,
        relation.resolution,
        relation.confidence,
        relation.filePath,
        relation.line,
        relation.metadata ? JSON.stringify(relation.metadata) : null,
      );
  }
}
