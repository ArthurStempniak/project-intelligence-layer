/**
 * Recência de alteração a partir do histórico do git (sinal `recentChanges`).
 *
 * Por que este sinal importa: tarefa de engenharia quase sempre incide em código
 * tocado há pouco. Um arquivo alterado ontem é candidato muito mais provável que
 * um estável há dois anos.
 *
 * O que o torna valioso aqui em particular: **não depende de idioma**. É a única
 * fonte de sinal que continua funcionando quando a tarefa está em português e os
 * identificadores em inglês (ARCHITECTURE.md §10) — situação em que a busca
 * lexical fica cega.
 *
 * Falha em silêncio de propósito. Projeto sem git, ou git ausente do PATH, é
 * caso legítimo: o sinal vira 0 e o resto do motor continua.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Commits inspecionados. Além disso a informação já é antiga o bastante. */
const HISTORY_DEPTH = 400;

/** Meia-vida do decaimento, em dias. */
const HALF_LIFE_DAYS = 30;

const SECONDS_PER_DAY = 86_400;

export interface RecencyIndex {
  /** Caminho relativo → epoch em segundos do último commit que o tocou. */
  lastTouched: ReadonlyMap<string, number>;
  /** Instante do commit mais recente, base do decaimento. */
  newest: number;
  available: boolean;
}

export const EMPTY_RECENCY: RecencyIndex = {
  lastTouched: new Map(),
  newest: 0,
  available: false,
};

/**
 * Monta o índice de recência com **uma** chamada ao git.
 *
 * `--name-only` num único `git log` evita um processo por arquivo — num projeto
 * de milhares de arquivos, o custo seria dominado pelo spawn, não pelo git.
 */
export async function loadRecency(root: string): Promise<RecencyIndex> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      'git',
      ['-C', root, 'log', `-n${String(HISTORY_DEPTH)}`, '--no-merges', '--format=%x00%at', '--name-only'],
      { maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return EMPTY_RECENCY;
  }

  const lastTouched = new Map<string, number>();
  let currentTimestamp = 0;
  let newest = 0;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('\0')) {
      currentTimestamp = Number(line.slice(1)) || 0;
      if (currentTimestamp > newest) newest = currentTimestamp;
      continue;
    }

    const path = line.trim();
    if (path === '' || currentTimestamp === 0) continue;

    // O log vem do mais recente para o mais antigo, então a primeira ocorrência
    // de um caminho já é a mais recente — sobrescrever seria envelhecê-lo.
    if (!lastTouched.has(path)) lastTouched.set(path, currentTimestamp);
  }

  return { lastTouched, newest, available: lastTouched.size > 0 };
}

/**
 * Recência normalizada em [0,1] com decaimento exponencial.
 *
 * A idade é medida contra o commit mais novo do histórico, não contra o relógio
 * da máquina. Isso é o que faz o sinal se comportar igual num checkout de um
 * commit de 2023 e num do mês passado — condição para o benchmark comparar
 * casos entre si.
 */
export function recencyScore(index: RecencyIndex, filePath: string): number {
  if (!index.available) return 0;

  const touched = index.lastTouched.get(filePath);
  if (touched === undefined) return 0;

  const ageDays = Math.max(0, (index.newest - touched) / SECONDS_PER_DAY);
  return 2 ** (-ageDays / HALF_LIFE_DAYS);
}

/** Os `limit` arquivos alterados mais recentemente. */
export function mostRecentFiles(index: RecencyIndex, limit: number): string[] {
  return [...index.lastTouched.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path]) => path);
}
