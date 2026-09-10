/**
 * Schema do indice.
 *
 * O DDL vive como string TypeScript, e nao como `.sql` externo, porque `tsc`
 * nao copia assets para `dist/` — um `.sql` solto quebraria o pacote publicado
 * sem quebrar os testes, que e o pior modo de falha possivel.
 *
 * O SQL e mantido dentro do subconjunto comum a SQLite e PostgreSQL sempre que
 * nao custa nada, para reduzir o delta do adapter futuro. Onde diverge (FTS5,
 * `INTEGER PRIMARY KEY`), fica isolado neste arquivo.
 */

/** Incrementar a cada mudanca incompativel. Indice de versao anterior e descartado. */
export const SCHEMA_VERSION = 2;

export const PRAGMAS = [
  // WAL: leitura concorrente com escrita — o `pil context` consulta enquanto um
  // scan pode estar rodando.
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  // Sem isto o ON DELETE CASCADE das entidades e silenciosamente ignorado.
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pil_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  language       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  line_count     INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  parse_state    TEXT NOT NULL,
  parse_error    TEXT,
  indexed_at     INTEGER NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

CREATE TABLE IF NOT EXISTS entities (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  language       TEXT NOT NULL,
  file_path      TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  parent_id      TEXT,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  start_byte     INTEGER NOT NULL,
  end_byte       INTEGER NOT NULL,
  signature      TEXT,
  documentation  TEXT,
  exported       INTEGER NOT NULL DEFAULT 0,
  fingerprint    TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  literals       TEXT,
  metadata       TEXT
);

CREATE INDEX IF NOT EXISTS idx_entities_file   ON entities(file_path);
CREATE INDEX IF NOT EXISTS idx_entities_name   ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities(parent_id);

CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT,
  target_hint TEXT NOT NULL,
  type        TEXT NOT NULL,
  resolution  TEXT NOT NULL,
  confidence  REAL NOT NULL,
  file_path   TEXT NOT NULL,
  line        INTEGER NOT NULL,
  metadata    TEXT
);

CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_file   ON relations(file_path);
-- Indice parcial: so as arestas pendentes sao consultadas por pista, e elas
-- sao minoria. Indexar a coluna inteira desperdicaria espaco e escrita.
CREATE INDEX IF NOT EXISTS idx_relations_hint
  ON relations(target_hint) WHERE target_id IS NULL;
-- Deduplicacao: a mesma aresta observada duas vezes na mesma linha e ruido.
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
  ON relations(source_id, type, target_hint, line, file_path);

/*
 * Tabela FTS gerenciada manualmente (nao external-content).
 *
 * Motivo: o texto indexado nao e a coluna crua. Identificadores sao quebrados
 * em palavras antes de entrar (createClient vira "create client"), senao a
 * tarefa "fix client creation" nao casaria com createClient. External-content
 * indexaria o valor original e perderia isso.
 *
 * Isto resolve a barreira de forma, nao a de idioma: uma tarefa em portugues
 * sobre codigo em ingles continua sem casar. Ver ARCHITECTURE.md secao 10.
 *
 * O rowid e mantido igual ao rowid da tabela entities, o que torna a remocao
 * por arquivo uma delecao indexada em vez de varredura da tabela FTS.
 */
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  entity_id UNINDEXED,
  terms,
  literals,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** Chaves de `pil_meta` com significado fixo. */
export const META_KEYS = {
  schemaVersion: 'schema_version',
  lastScanAt: 'last_scan_at',
  projectName: 'project_name',
} as const;
