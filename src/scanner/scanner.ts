/**
 * Varredura do projeto (spec §8).
 *
 * Produz `FileRecord`s a partir do disco. Não parseia e não escreve no índice —
 * essa separação é o que permite ao `Indexer` decidir, com o `ChangeSet` em
 * mãos, quais arquivos merecem parse.
 *
 * Custo por arquivo, em ordem crescente, com saída antecipada em cada etapa:
 *   caminho → ignore → deny de segredo → stat → tamanho → leitura → hash
 *
 * A ordem não é estética: `stat` é barato e `readFile` não é. Num projeto de
 * 100 mil arquivos, decidir pelo caminho antes de tocar no disco é a diferença
 * entre segundos e minutos.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { FileRecord, ParseState } from '../core/types/index.js';
import { sha256, toPosixPath } from '../core/ids.js';
import { estimateFileTokens } from '../core/tokens.js';
import { IgnoreSet, parseIgnoreFile } from './ignore.js';
import { detectLanguage, looksBinary, UNKNOWN_LANGUAGE } from './languages.js';
import { SecretGuard } from './secrets.js';

export interface ScanOptions {
  root: string;
  exclude: readonly string[];
  denyPaths: readonly string[];
  respectGitignore: boolean;
  excludeSecrets: boolean;
  maxFileSizeBytes: number;
}

/** Arquivo encontrado, com o conteúdo quando ele foi efetivamente lido. */
export interface ScannedFile {
  record: FileRecord;
  /** `null` para arquivos pulados — nunca foram lidos ou foram descartados. */
  content: string | null;
}

/** Assinatura suficiente para o diff incremental, sem ler o arquivo. */
export type FileSignature = Pick<FileRecord, 'path' | 'contentHash' | 'mtimeMs' | 'sizeBytes'>;

export interface ScanResult {
  files: ScannedFile[];
  /**
   * Arquivos cujo conteúdo não foi lido porque `mtime` e tamanho batem com o
   * índice. Entram no diff, nunca na reindexação.
   */
  unchanged: FileSignature[];
  /** Contagem por motivo de descarte, para o relatório do `pil status`. */
  skipped: Record<string, number>;
  elapsedMs: number;
}

/**
 * Diretórios podados sempre, mesmo sem `.gitignore`.
 *
 * `.git` é o caso crítico: além de inútil para o contexto, contém objetos
 * comprimidos que fariam a varredura desperdiçar tempo e o detector de binário
 * trabalhar à toa em milhares de arquivos.
 */
const ALWAYS_PRUNE: ReadonlySet<string> = new Set(['.git', '.pil', 'node_modules']);

export class Scanner {
  readonly #options: ScanOptions;
  readonly #guard: SecretGuard;
  /** Assinaturas do índice anterior, por caminho. */
  #known: ReadonlyMap<string, FileSignature> = new Map();
  #unchanged: FileSignature[] = [];

  constructor(options: ScanOptions) {
    this.#options = options;
    this.#guard = new SecretGuard(options.denyPaths, options.excludeSecrets);
  }

  /**
   * `known` habilita o atalho de `mtime`: um arquivo cujo tempo de modificação
   * **e** tamanho batem com o índice não é lido nem hasheado.
   *
   * É o que sustenta a promessa de escala do projeto. Sem isso, todo `pil scan`
   * lê o conteúdo de cada arquivo só para descobrir que nada mudou — num
   * projeto de 421 arquivos custava 3,6s por scan, e cresce linearmente.
   *
   * Risco residual assumido: uma ferramenta que altere o conteúdo preservando
   * `mtime` e tamanho passa despercebida. `git checkout` reescreve `mtime`, e
   * `pil scan --rebuild` é a saída para os casos patológicos.
   */
  async scan(known: ReadonlyMap<string, FileSignature> = new Map()): Promise<ScanResult> {
    const startedAt = Date.now();
    const ignore = await this.#buildIgnoreSet();

    this.#known = known;
    this.#unchanged = [];

    const files: ScannedFile[] = [];
    const skipped: Record<string, number> = {};
    const note = (reason: string): void => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    await this.#walk(this.#options.root, ignore, files, note);

    return {
      files,
      unchanged: this.#unchanged,
      skipped,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async #buildIgnoreSet(): Promise<IgnoreSet> {
    let ignore = IgnoreSet.fromPatterns(this.#options.exclude);

    if (this.#options.respectGitignore) {
      try {
        const content = await readFile(join(this.#options.root, '.gitignore'), 'utf8');
        // O .gitignore vem depois dos excludes da config para que uma negação
        // no arquivo do projeto (`!dist/importante.js`) possa reverter um
        // exclude padrão — o projeto conhece seu caso melhor que o default.
        ignore = ignore.concat(IgnoreSet.fromPatterns(parseIgnoreFile(content).map((r) => r.source)));
      } catch {
        // Sem .gitignore é o caso normal de muitos projetos, não um erro.
      }
    }

    return ignore;
  }

  async #walk(
    directory: string,
    ignore: IgnoreSet,
    output: ScannedFile[],
    note: (reason: string) => void,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Diretório sem permissão de leitura: registra e segue. Abortar a
      // varredura inteira por causa de um diretório seria desproporcional.
      note('diretorio ilegivel');
      return;
    }

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = toPosixPath(relative(this.#options.root, absolute));

      if (entry.isDirectory()) {
        if (ALWAYS_PRUNE.has(entry.name) || ignore.canPrune(relativePath)) continue;
        await this.#walk(absolute, ignore, output, note);
        continue;
      }

      if (!entry.isFile()) continue;

      if (ignore.ignores(relativePath)) {
        note('ignorado');
        continue;
      }

      const scanned = await this.#scanFile(absolute, relativePath, note);
      if (scanned) output.push(scanned);
    }
  }

  async #scanFile(
    absolutePath: string,
    relativePath: string,
    note: (reason: string) => void,
  ): Promise<ScannedFile | null> {
    // Deny de caminho vem antes do stat: um `.env` não deve nem ter seus
    // metadados lidos, e o custo de decidir aqui é zero.
    const pathVerdict = this.#guard.checkPath(relativePath);
    if (pathVerdict.blocked) {
      note(`segredo: ${pathVerdict.reason}`);
      return this.#skippedRecord(relativePath, 'SKIPPED_SECRET', 0, 0);
    }

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      note('arquivo ilegivel');
      return null;
    }

    // Atalho antes da leitura: mtime e tamanho iguais significam "nao mudou".
    // Usado como prova de nao-mudanca, nunca de mudanca (ARCHITECTURE.md secao 5).
    const known = this.#known.get(relativePath);
    if (known && known.mtimeMs === stats.mtimeMs && known.sizeBytes === stats.size) {
      this.#unchanged.push(known);
      return null;
    }

    if (stats.size > this.#options.maxFileSizeBytes) {
      note('grande demais');
      return this.#skippedRecord(relativePath, 'SKIPPED_TOO_LARGE', stats.size, stats.mtimeMs);
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      note('arquivo ilegivel');
      return null;
    }

    if (looksBinary(buffer)) {
      note('binario');
      return this.#skippedRecord(relativePath, 'SKIPPED_BINARY', stats.size, stats.mtimeMs);
    }

    const content = buffer.toString('utf8');

    const contentVerdict = this.#guard.checkContent(content);
    if (contentVerdict.blocked) {
      note(`segredo: ${contentVerdict.reason}`);
      return this.#skippedRecord(relativePath, 'SKIPPED_SECRET', stats.size, stats.mtimeMs);
    }

    const language = detectLanguage(relativePath);

    return {
      record: {
        path: relativePath,
        language,
        sizeBytes: stats.size,
        lineCount: countLines(content),
        // Hash sobre o conteúdo normalizado, e não sobre os bytes: um checkout
        // que troca LF por CRLF não pode marcar o arquivo como modificado.
        contentHash: sha256(content.replace(/\r\n/g, '\n')),
        parseState: language === UNKNOWN_LANGUAGE ? 'UNSUPPORTED_LANGUAGE' : 'OK',
        indexedAt: Date.now(),
        mtimeMs: stats.mtimeMs,
        tokenEstimate: estimateFileTokens(content),
      },
      content,
    };
  }

  /**
   * Registro de um arquivo que existe mas não foi analisado.
   *
   * Guardar o descarte é obrigatório: um arquivo ausente do índice sem registro
   * é indistinguível de um bug do scanner, e o `pil status` não teria como
   * reportar cobertura honesta.
   */
  #skippedRecord(
    relativePath: string,
    parseState: ParseState,
    sizeBytes: number,
    mtimeMs: number,
  ): ScannedFile {
    return {
      record: {
        path: relativePath,
        language: detectLanguage(relativePath),
        sizeBytes,
        lineCount: 0,
        // Hash do estado, não do conteúdo: o conteúdo não foi lido (ou não deve
        // ser guardado). Isso mantém o arquivo estável no diff incremental sem
        // reabri-lo a cada scan.
        contentHash: `skipped:${parseState}:${sizeBytes}`,
        parseState,
        indexedAt: Date.now(),
        mtimeMs,
        tokenEstimate: 0,
      },
      content: null,
    };
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}
