/**
 * Orquestração da indexação: disco → índice.
 *
 * Sequência e a razão de cada etapa estar onde está:
 *
 *   1. Scanner varre e hasheia          — decide o que existe
 *   2. ChangeSet compara com o índice   — decide o que mudou
 *   3. Parse só dos alterados           — o ganho incremental inteiro está aqui
 *   4. Resolver roda uma vez, no fim    — precisa do índice completo
 *
 * A etapa 4 depois da 3 não é detalhe de implementação: `a.ts` pode chamar algo
 * de `b.ts` sem que `b.ts` já tenha sido processado. Resolver por arquivo
 * produziria arestas pendentes que nunca voltariam a ser avaliadas.
 */

import type { PilConfig } from '../core/config/schema.js';
import { isChangeSetEmpty, type ChangeSet } from '../core/types/index.js';
import { CodeParser } from '../parser/parser.js';
import { Resolver, type ResolveReport } from '../parser/resolver.js';
import { Scanner, type FileSignature, type ScannedFile } from '../scanner/scanner.js';
import { META_KEYS } from '../storage/sqlite/migrations.js';
import type { Storage } from '../storage/storage.js';

export interface IndexReport {
  changes: ChangeSet;
  parsed: number;
  parseErrors: number;
  entities: number;
  relations: number;
  skipped: Record<string, number>;
  resolution: ResolveReport;
  /** A passada de resolução foi pulada por nada ter mudado. */
  resolutionSkipped: boolean;
  elapsedMs: number;
}

export interface IndexOptions {
  /** Ignora o índice existente e reprocessa tudo. */
  rebuild?: boolean;
  /**
   * Chamado a cada arquivo processado, para barra de progresso na CLI.
   *
   * `| undefined` explicito para que o chamador possa passar `undefined` sem
   * precisar montar o objeto condicionalmente (`exactOptionalPropertyTypes`).
   */
  onProgress?: ((done: number, total: number, path: string) => void) | undefined;
}

export class Indexer {
  readonly #storage: Storage;
  readonly #config: PilConfig;

  constructor(storage: Storage, config: PilConfig) {
    this.#storage = storage;
    this.#config = config;
  }

  async run(options: IndexOptions = {}): Promise<IndexReport> {
    const startedAt = Date.now();
    const root = this.#config.project.root;
    if (!root) throw new Error('config sem project.root resolvido');

    const scanner = new Scanner({
      root,
      exclude: this.#config.indexing.exclude,
      denyPaths: this.#config.security.denyPaths,
      respectGitignore: this.#config.indexing.respectGitignore,
      excludeSecrets: this.#config.security.excludeSecrets,
      maxFileSizeBytes: this.#config.indexing.maxFileSizeBytes,
    });

    const incremental = this.#config.indexing.incremental && options.rebuild !== true;

    // Com `--rebuild` o atalho de mtime é desligado passando um mapa vazio:
    // reconstruir significa reler tudo, senão o comando não cumpriria o nome.
    const known = incremental ? await this.#knownSignatures() : new Map<string, FileSignature>();

    const scan = await scanner.scan(known);
    const byPath = new Map(scan.files.map((file) => [file.record.path, file]));

    const changes = incremental
      ? await this.#storage.computeChangeSet([
          ...scan.files.map((f) => f.record),
          ...scan.unchanged,
        ])
      : allAsAdded(scan.files);

    for (const path of changes.deleted) {
      await this.#storage.deleteFile(path);
    }

    const targets = [...changes.added, ...changes.modified];
    const parser = new CodeParser();

    let parsed = 0;
    let parseErrors = 0;
    let entities = 0;
    let relations = 0;

    try {
      for (const [position, path] of targets.entries()) {
        const file = byPath.get(path);
        if (!file) continue;

        const result = await this.#indexFile(parser, file);
        parsed += 1;
        entities += result.entities;
        relations += result.relations;
        if (result.failed) parseErrors += 1;

        options.onProgress?.(position + 1, targets.length, path);
      }
    } finally {
      parser.dispose();
    }

    /*
     * A resolução é pulada quando nenhum arquivo mudou.
     *
     * Uma aresta pendente só pode passar a resolver se alguma entidade nova
     * apareceu — e entidade nova exige arquivo alterado. Sem arquivo alterado, a
     * passada reprocessaria todas as pendências para chegar exatamente ao mesmo
     * resultado.
     *
     * Medido num projeto de 421 arquivos com 16,5 mil pendências: o `pil scan`
     * sem nenhuma alteração levava 8,7s, praticamente tudo nessa passada inútil.
     * O caminho incremental é o que se usa dezenas de vezes por dia, e é onde a
     * lentidão mais incomoda.
     */
    const nothingChanged = isChangeSetEmpty(changes);
    const resolution = nothingChanged
      ? EMPTY_RESOLVE_REPORT
      : await new Resolver(this.#storage).resolveAll();

    await this.#storage.setMeta(META_KEYS.lastScanAt, String(Date.now()));
    await this.#storage.setMeta(META_KEYS.projectName, this.#config.project.name);

    return {
      changes,
      parsed,
      parseErrors,
      entities,
      relations,
      skipped: scan.skipped,
      resolution,
      resolutionSkipped: nothingChanged,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async #knownSignatures(): Promise<Map<string, FileSignature>> {
    const signatures = await this.#storage.listFileSignatures();
    return new Map(signatures.map((signature) => [signature.path, signature]));
  }

  async #indexFile(
    parser: CodeParser,
    file: ScannedFile,
  ): Promise<{ entities: number; relations: number; failed: boolean }> {
    const { record, content } = file;

    // Arquivo pulado (segredo, binário, grande demais) entra no índice como
    // registro sem conteúdo: o `pil status` precisa poder explicar a ausência.
    if (content === null) {
      await this.#storage.replaceFileAnalysis(record, [], []);
      return { entities: 0, relations: 0, failed: false };
    }

    /*
     * Linguagem reconhecida mas sem extrator (CSS, SQL, Markdown) é diferente
     * de linguagem desconhecida: o scanner marcou OK porque soube dizer o que
     * é o arquivo. Quem sabe que falta extrator é esta camada, e o estado tem
     * de refletir isso — senão o `pil status` reportaria cobertura inflada,
     * contando como analisado o que só foi listado.
     */
    if (!CodeParser.supports(record.language)) {
      await this.#storage.replaceFileAnalysis(
        { ...record, parseState: 'UNSUPPORTED_LANGUAGE' },
        [],
        [],
      );
      return { entities: 0, relations: 0, failed: false };
    }

    const outcome = await parser.parse({
      filePath: record.path,
      language: record.language,
      source: content,
    });

    await this.#storage.replaceFileAnalysis(
      {
        ...record,
        parseState: outcome.parseState,
        parseError: outcome.parseError,
      },
      outcome.entities,
      outcome.relations,
    );

    return {
      entities: outcome.entities.length,
      relations: outcome.relations.length,
      failed: outcome.parseState === 'PARSE_ERROR',
    };
  }
}

/** Relatório neutro usado quando a resolução não roda. */
const EMPTY_RESOLVE_REPORT: ResolveReport = {
  considered: 0,
  exact: 0,
  scoped: 0,
  ambiguous: 0,
  stillUnresolved: 0,
  external: 0,
};

function allAsAdded(files: readonly ScannedFile[]): ChangeSet {
  return {
    added: files.map((file) => file.record.path),
    modified: [],
    deleted: [],
    unchangedCount: 0,
  };
}
