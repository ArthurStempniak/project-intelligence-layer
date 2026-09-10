/**
 * Corpus de benchmark a partir de commits reais (docs/BENCHMARK.md).
 *
 * A ideia central: um commit já é um par (tarefa, resposta) rotulado por um
 * humano. A mensagem é a tarefa; os arquivos alterados são o conjunto que era
 * necessário.
 *
 * O ponto delicado é indexar o estado **anterior** ao commit. Indexar o estado
 * posterior deixaria o código da solução visível no índice, e a medição
 * passaria a avaliar um cenário que nunca ocorre na prática.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CorpusCase {
  sha: string;
  /** Mensagem do commit — a tarefa em linguagem natural. */
  task: string;
  /** Arquivos que o commit alterou — o gabarito. */
  expectedFiles: string[];
}

export interface CorpusFilters {
  /** Máximo de arquivos por commit. Acima disso não é uma tarefa. */
  maxFiles: number;
  /** Mínimo de palavras na mensagem. */
  minWords: number;
  /** Só arquivos destas extensões contam para o gabarito. */
  extensions: readonly string[];
}

export const DEFAULT_FILTERS: CorpusFilters = {
  maxFiles: 20,
  minWords: 3,
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'],
};

/**
 * Mensagens que não descrevem tarefa de engenharia.
 *
 * O filtro é explícito e versionado de propósito: escolher a dedo quais commits
 * entram no benchmark é a maneira mais fácil de produzir um número bonito e sem
 * significado.
 */
const GENERIC_MESSAGES = [
  /^wip\b/i,
  /^fix(es|ed)?$/i,
  /^ajustes?$/i,
  /^update$/i,
  /^atualiza(ndo|cao|ção)?$/i,
  /^merge\b/i,
  /^revert\b/i,
  /^bump\b/i,
  /^chore/i,
  /^lint/i,
  /^format/i,
  /^primeiro commit$/i,
  /^initial commit$/i,
];

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Monta o corpus, aplicando os filtros e reportando quantos commits foram
 * descartados por cada motivo — sem isso não há como saber se o corpus é
 * representativo ou se sobrou só o que era conveniente.
 */
export async function buildCorpus(
  repo: string,
  limit: number,
  filters: CorpusFilters = DEFAULT_FILTERS,
): Promise<{ cases: CorpusCase[]; rejected: Record<string, number>; scanned: number }> {
  // `--no-merges`: o diff de um merge não corresponde a uma tarefa.
  const log = await git(repo, [
    'log',
    '--no-merges',
    '--format=%H%x00%s',
    `-n${String(limit * 6)}`,
  ]);

  const rejected: Record<string, number> = {};
  const reject = (reason: string): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  const cases: CorpusCase[] = [];
  const entries = log.split('\n').filter((line) => line.trim() !== '');

  for (const entry of entries) {
    if (cases.length >= limit) break;

    const [sha, subject] = entry.split('\0');
    if (!sha || !subject) continue;

    if (GENERIC_MESSAGES.some((pattern) => pattern.test(subject.trim()))) {
      reject('mensagem genérica');
      continue;
    }
    if (subject.trim().split(/\s+/).length < filters.minWords) {
      reject('mensagem curta');
      continue;
    }

    const changed = (await git(repo, ['show', '--name-only', '--format=', sha]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    if (changed.length === 0) {
      reject('sem arquivos');
      continue;
    }
    if (changed.length > filters.maxFiles) {
      // Renomeação em massa ou formatação: a mensagem não descreve a mudança.
      reject('muitos arquivos');
      continue;
    }

    const relevant = changed.filter((file) =>
      filters.extensions.some((extension) => file.endsWith(extension)),
    );
    if (relevant.length === 0) {
      reject('só config/asset');
      continue;
    }

    cases.push({ sha, task: subject.trim(), expectedFiles: relevant });
  }

  return { cases, rejected, scanned: entries.length };
}

/** Cria um worktree no estado anterior ao commit. */
export async function checkoutParent(repo: string, sha: string, target: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', '--force', target, `${sha}~1`]);
}

export async function removeWorktree(repo: string, target: string): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', '--force', target]);
  } catch {
    // Worktree já removido ou nunca criado: limpeza não deve derrubar o bench.
  }
}
