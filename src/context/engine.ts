/**
 * Context Engine — fachada da spec §11.
 *
 * Amarra as etapas: interpretar a tarefa → achar sementes → expandir no grafo →
 * pontuar → compilar sob orçamento.
 */

import type { ContextPackage, ContextRequest } from '../core/types/index.js';
import { effectiveBudget } from '../core/tokens.js';
import type { PilConfig } from '../core/config/schema.js';
import { PilError } from '../core/errors.js';
import type { Storage } from '../storage/storage.js';
import { ContextCompiler } from './compiler.js';
import { RelevanceEngine, type RankResult } from './relevance.js';

/** Abaixo disto nem o cabeçalho do pacote caberia. */
const MIN_BUDGET = 500;

export interface ContextOutcome {
  package: ContextPackage;
  ranking: RankResult;
}

export class ContextEngine {
  readonly #storage: Storage;
  readonly #config: PilConfig;

  constructor(storage: Storage, config: PilConfig) {
    this.#storage = storage;
    this.#config = config;
  }

  async build(request: ContextRequest): Promise<ContextOutcome> {
    const startedAt = Date.now();

    if (request.budget < MIN_BUDGET) {
      throw new PilError(
        'BUDGET_TOO_SMALL',
        `Orçamento de ${request.budget} tokens é insuficiente.`,
        `Use pelo menos ${MIN_BUDGET}.`,
      );
    }

    const root = this.#config.project.root;
    if (!root) throw new Error('config sem project.root resolvido');

    const ranking = await new RelevanceEngine(this.#storage).rank({
      task: request.task,
      root,
      maxHops: request.maxHops ?? this.#config.context.maxHops,
      dictionary: this.#config.context.dictionary,
      weights: request.weights,
      include: request.include,
    });

    const budget = effectiveBudget(request.budget, this.#config.context.budgetSafetyMargin);

    const pkg = await new ContextCompiler(this.#storage).compile({
      task: request.task,
      taskKind: ranking.analysis.kind,
      ranked: ranking.ranked,
      budget,
      root,
      startedAt,
      consideredCount: ranking.consideredCount,
    });

    return { package: pkg, ranking };
  }
}
