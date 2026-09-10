/**
 * Harness de benchmark (spec §22, docs/BENCHMARK.md).
 *
 * Mede o par de métricas que dá sentido ao PIL:
 *
 *   redução de tokens   — o benefício alegado
 *   recall do gabarito  — a prova de que a redução não perdeu o essencial
 *
 * Uma sem a outra é trivial de fingir: enviar nada reduz 100%, enviar tudo dá
 * recall 1. É por isso que as duas são sempre reportadas juntas, e por que este
 * harness é entregável da Fase 1 e não da Fase 2 — sem ele, qualquer ajuste no
 * Relevance Engine é palpite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig } from '../core/config/schema.js';
import { ContextEngine } from '../context/engine.js';
import { Indexer } from '../indexer/indexer.js';
import { SqliteStorage } from '../storage/sqlite/sqlite-storage.js';
import { buildCorpus, checkoutParent, removeWorktree, type CorpusCase } from './corpus.js';

export interface CaseResult {
  sha: string;
  task: string;
  expectedFiles: string[];
  selectedFiles: string[];
  /** Fração do gabarito presente no contexto. */
  recall: number;
  /** Fração do contexto que estava no gabarito. */
  precision: number;
  reduction: number;
  projectTokens: number;
  selectedTokens: number;
  elapsedMs: number;
  error?: string;
}

export interface BenchmarkReport {
  repo: string;
  budget: number;
  cases: CaseResult[];
  rejected: Record<string, number>;
  commitsScanned: number;
  aggregate: {
    meanRecall: number;
    meanPrecision: number;
    meanReduction: number;
    medianElapsedMs: number;
    p95ElapsedMs: number;
    /** Casos com recall 0 — o motor não achou nada do gabarito. */
    misses: number;
  };
}

export interface BenchmarkOptions {
  repo: string;
  budget: number;
  limit: number;
  onCase?: ((result: CaseResult, index: number, total: number) => void) | undefined;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const { cases: corpus, rejected, scanned } = await buildCorpus(options.repo, options.limit);
  const results: CaseResult[] = [];

  for (const [index, entry] of corpus.entries()) {
    const result = await runCase(options.repo, entry, options.budget);
    results.push(result);
    options.onCase?.(result, index + 1, corpus.length);
  }

  return {
    repo: options.repo,
    budget: options.budget,
    cases: results,
    rejected,
    commitsScanned: scanned,
    aggregate: aggregate(results),
  };
}

async function runCase(repo: string, entry: CorpusCase, budget: number): Promise<CaseResult> {
  const worktree = await mkdtemp(join(tmpdir(), 'pil-bench-'));
  const base: CaseResult = {
    sha: entry.sha.slice(0, 7),
    task: entry.task,
    expectedFiles: entry.expectedFiles,
    selectedFiles: [],
    recall: 0,
    precision: 0,
    reduction: 0,
    projectTokens: 0,
    selectedTokens: 0,
    elapsedMs: 0,
  };

  try {
    // Estado ANTERIOR ao commit: indexar o posterior deixaria a solução visível.
    await checkoutParent(repo, entry.sha, worktree);

    const storage = new SqliteStorage(':memory:');
    try {
      await storage.migrate();

      const config = {
        ...defaultConfig('bench'),
        project: { name: 'bench', root: worktree },
      };

      await new Indexer(storage, config).run();

      const started = Date.now();
      const outcome = await new ContextEngine(storage, config).build({ task: entry.task, budget });
      const elapsedMs = Date.now() - started;

      const selectedFiles = [...new Set(outcome.package.items.map((item) => item.filePath))];
      const expected = new Set(entry.expectedFiles);
      const hits = selectedFiles.filter((file) => expected.has(file));

      return {
        ...base,
        selectedFiles,
        recall: expected.size === 0 ? 0 : hits.length / expected.size,
        precision: selectedFiles.length === 0 ? 0 : hits.length / selectedFiles.length,
        reduction: outcome.package.metrics.reduction,
        projectTokens: outcome.package.metrics.projectTokens,
        selectedTokens: outcome.package.metrics.selectedTokens,
        elapsedMs,
      };
    } finally {
      await storage.close();
    }
  } catch (error) {
    // Um commit que falha (worktree impossível, arquivo ilegível) não pode
    // derrubar a execução inteira — o caso entra no relatório com o erro, e a
    // média o ignora em vez de contá-lo como recall 0.
    return { ...base, error: (error as Error).message };
  } finally {
    await removeWorktree(repo, worktree);
    await rm(worktree, { recursive: true, force: true });
  }
}

function aggregate(results: readonly CaseResult[]): BenchmarkReport['aggregate'] {
  const valid = results.filter((result) => result.error === undefined);

  if (valid.length === 0) {
    return {
      meanRecall: 0,
      meanPrecision: 0,
      meanReduction: 0,
      medianElapsedMs: 0,
      p95ElapsedMs: 0,
      misses: 0,
    };
  }

  const mean = (pick: (r: CaseResult) => number): number =>
    valid.reduce((sum, r) => sum + pick(r), 0) / valid.length;

  const times = valid.map((r) => r.elapsedMs).sort((a, b) => a - b);

  return {
    meanRecall: mean((r) => r.recall),
    meanPrecision: mean((r) => r.precision),
    meanReduction: mean((r) => r.reduction),
    medianElapsedMs: percentileOf(times, 0.5),
    p95ElapsedMs: percentileOf(times, 0.95),
    misses: valid.filter((r) => r.recall === 0).length,
  };
}

function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}
