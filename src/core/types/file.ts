/**
 * Unidade de indexacao incremental (spec 8, 9).
 *
 * O arquivo — nao a entidade — e a unidade de invalidacao. Um arquivo cujo
 * `contentHash` nao mudou nunca e reparseado; suas entidades e relacoes sao
 * reaproveitadas integralmente do indice.
 */

/**
 * Por que um arquivo esta (ou nao esta) no indice.
 *
 * Estados de skip sao *registrados*, nao silenciados: um arquivo ausente do
 * indice por ter sido pulado e indistinguivel de um bug se nao guardarmos o
 * motivo, e o `pil status` precisa reportar cobertura honesta.
 */
export const PARSE_STATES = [
  'OK',
  /** Parse falhou. Entidades podem estar parciais; ver `parseError`. */
  'PARSE_ERROR',
  /** Linguagem sem extrator registrado. Arquivo conhecido, conteudo opaco. */
  'UNSUPPORTED_LANGUAGE',
  'SKIPPED_BINARY',
  'SKIPPED_TOO_LARGE',
  /** Barrado pelo detector de segredos (spec 19). Nunca entra no indice. */
  'SKIPPED_SECRET',
  'SKIPPED_IGNORED',
] as const;

export type ParseState = (typeof PARSE_STATES)[number];

/** Estados em que o conteudo do arquivo foi efetivamente analisado. */
export const INDEXED_STATES: ReadonlySet<ParseState> = new Set<ParseState>([
  'OK',
  'PARSE_ERROR',
]);

export interface FileRecord {
  /** Caminho relativo a raiz do projeto, sempre com separador `/`. */
  path: string;
  /** Id da linguagem detectada (`typescript`, `python`, ...) ou `unknown`. */
  language: string;
  sizeBytes: number;
  lineCount: number;
  /** SHA-256 do conteudo bruto. Gatilho da reindexacao. */
  contentHash: string;
  parseState: ParseState;
  parseError?: string | undefined;
  /** Epoch ms da ultima indexacao bem-sucedida deste arquivo. */
  indexedAt: number;
  /**
   * mtime do arquivo em epoch ms. Usado como filtro *barato* antes do hash:
   * se mtime e tamanho nao mudaram, nem lemos o arquivo para hashear.
   * Nunca usado como prova de mudanca — apenas como prova de nao-mudanca.
   */
  mtimeMs: number;
  /** Soma dos tokens estimados do arquivo completo. Base do baseline do bench. */
  tokenEstimate: number;
}

/** Resultado da comparacao entre o disco e o indice. */
export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Inalterados: contam para o relatorio, nunca sao reparseados. */
  unchangedCount: number;
}

export function isChangeSetEmpty(changes: ChangeSet): boolean {
  return (
    changes.added.length === 0 &&
    changes.modified.length === 0 &&
    changes.deleted.length === 0
  );
}
