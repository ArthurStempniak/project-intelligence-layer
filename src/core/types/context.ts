/**
 * Context Engine / Relevance Engine / Context Compiler (spec 11–15).
 *
 * A formula da spec 12 e uma soma de termos heterogeneos e nao normalizados —
 * do jeito escrito ela nao produz uma escala 0–100 estavel, porque cada parcela
 * tem faixa propria (BM25 e ilimitado, distancia de grafo e inteira, "arquivo
 * exportado" e booleano). Aqui cada sinal e normalizado para [0,1] *na origem*
 * e combinado por media ponderada, de modo que o score final seja comparavel
 * entre projetos e entre execucoes — condicao para o benchmark da spec 22
 * conseguir medir regressao do ranking.
 */

import type { CodeEntity } from './entity.js';

/**
 * Unidade de selecao: a *entidade*, nao o arquivo.
 *
 * A spec 12 exemplifica pontuando arquivos, mas a spec 15 comprime simbolos.
 * Orcar por arquivo desperdicaria o orcamento: um `service.ts` de 800 linhas
 * entra inteiro por causa de uma funcao relevante. Arquivos permanecem como
 * contenedores e recebem score derivado do maximo de suas entidades.
 */
export interface RelevanceSignals {
  /**
   * Similaridade semantica por embeddings (spec 12). Fase 2 — no MVP e sempre
   * 0 e o peso e redistribuido para `lexical`.
   */
  semantic: number;
  /** BM25 do FTS sobre nome/assinatura/doc, normalizado pelo topo do resultado. */
  lexical: number;
  /** Simbolo citado literalmente na tarefa. Sinal forte e barato. */
  symbolMatch: number;
  /** Proximidade no grafo a partir das sementes: `1 / (1 + distancia)`. */
  graphProximity: number;
  /** Participa de uma aresta CALLS direta com alguma semente. */
  callRelationship: number;
  /** Centralidade da entidade no grafo (grau de entrada normalizado). */
  fileImportance: number;
  /** Afinidade entre o tipo da entidade e o tipo da tarefa inferido. */
  taskType: number;
  /** Recencia de alteracao segundo o git. Codigo tocado ha pouco tende a ser o alvo. */
  recentChanges: number;
  /** Ligado por uma aresta TESTS a alguma semente. */
  testRelationship: number;
}

export type RelevanceWeights = Record<keyof RelevanceSignals, number>;

/**
 * Pesos iniciais. Nao sao verdade revelada: sao um ponto de partida a ser
 * calibrado contra o corpus de commits reais do benchmark (spec 22), que e
 * justamente o mecanismo que torna esses numeros falsificaveis.
 *
 * `semantic` fica em 0 no MVP (sem embeddings); os pesos sao renormalizados
 * pela soma efetiva, entao desligar um sinal nao deprime o score dos demais.
 */
export const DEFAULT_WEIGHTS: RelevanceWeights = {
  semantic: 0.0,
  lexical: 0.25,
  symbolMatch: 0.2,
  graphProximity: 0.2,
  callRelationship: 0.1,
  fileImportance: 0.05,
  taskType: 0.08,
  recentChanges: 0.05,
  testRelationship: 0.07,
};

export interface ScoredEntity {
  entity: CodeEntity;
  signals: RelevanceSignals;
  /** Media ponderada dos sinais, em [0,100]. */
  score: number;
  /** Distancia em arestas ate a semente mais proxima. 0 = e uma semente. */
  hopDistance: number;
  /** Por que esta entidade entrou. Exibido por `pil context --explain`. */
  reasons: string[];
}

/** Nivel de detalhe com que uma entidade entra no pacote (spec 15). */
export const DETAIL_LEVELS = [
  /** Apenas nome e tipo. Custo minimo, usado para dar mapa do entorno. */
  'REFERENCE',
  /** Assinatura, entradas/saidas, chamadas e erros. A compressao da spec 15. */
  'SIGNATURE',
  /** Codigo-fonte integral. */
  'FULL',
] as const;

export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Como a tarefa em linguagem natural foi classificada (spec 11, passo 1). */
export const TASK_KINDS = [
  'BUG_FIX',
  'FEATURE',
  'REFACTOR',
  'TEST',
  'EXPLAIN',
  'MIGRATION',
  'UNKNOWN',
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export interface ContextRequest {
  /** A tarefa, em linguagem natural. */
  task: string;
  /** Teto de tokens do pacote final (spec 14). */
  budget: number;
  /** Profundidade maxima de expansao no grafo a partir das sementes. */
  maxHops?: number | undefined;
  weights?: Partial<RelevanceWeights> | undefined;
  /** Forca inclusao destes caminhos, independentemente do score. */
  include?: string[] | undefined;
}

/** Item ja selecionado e renderizado, com custo conhecido. */
export interface ContextItem {
  entityId: string;
  filePath: string;
  detail: DetailLevel;
  score: number;
  tokens: number;
  content: string;
}

/**
 * Saida do Context Compiler (spec 13) — o que efetivamente vai ao agente.
 * As metricas viajam junto porque sao o produto observavel do PIL (spec 22):
 * sem elas nao ha como afirmar reducao sem perda.
 */
export interface ContextPackage {
  task: string;
  taskKind: TaskKind;
  projectSummary: string;
  items: ContextItem[];
  /** Entidades consideradas e descartadas por orcamento. Diagnostica recall. */
  omitted: Array<{ entityId: string; score: number; tokens: number }>;
  metrics: ContextMetrics;
}

export interface ContextMetrics {
  /** Custo de mandar o projeto inteiro — o baseline que o PIL diz superar. */
  projectTokens: number;
  selectedTokens: number;
  budget: number;
  /** `1 - selectedTokens / projectTokens`, em [0,1]. */
  reduction: number;
  filesInProject: number;
  filesSelected: number;
  entitiesConsidered: number;
  entitiesSelected: number;
  /** Tempo ate montar o pacote, em ms (metrica "Time to Context" da spec 22). */
  elapsedMs: number;
}
