/**
 * Interpretação da tarefa em linguagem natural (spec §11, passo 1).
 *
 * Sem LLM: classificação por palavra-chave e extração de identificadores
 * citados. Isso é proposital para a Fase 1 — chamar um modelo para entender a
 * tarefa antes de montar o contexto adicionaria latência, custo e dependência
 * de rede à etapa que existe justamente para reduzir custo. Se o benchmark
 * mostrar que a classificação erra o suficiente para derrubar o recall, aí o
 * LLM entra com evidência.
 */

import type { EntityType, TaskKind } from '../core/types/index.js';
import { isIntentVerb, splitIdentifier, stripDiacritics } from '../core/text.js';

export interface TaskAnalysis {
  kind: TaskKind;
  /** Identificadores citados literalmente na tarefa. Sinal mais forte que há. */
  symbols: string[];
  /** Caminhos de arquivo citados na tarefa. */
  paths: string[];
  /** Termos úteis para a busca lexical. */
  terms: string[];
}

/**
 * Pistas por tipo de tarefa, em português e inglês.
 *
 * Bilíngue porque o usuário escreve em português sobre código em inglês — o
 * mesmo desencontro documentado em ARCHITECTURE.md §10. Aqui ele é tratável
 * porque o vocabulário de *intenção* é pequeno e fechado, ao contrário do
 * vocabulário de domínio.
 */
const KIND_HINTS: ReadonlyArray<{ kind: TaskKind; words: readonly string[] }> = [
  {
    kind: 'BUG_FIX',
    // `valida`, `verific`, `confer` e `revis` entram aqui porque descrevem a
    // mesma intencao: procurar onde o comportamento esta errado. Sem eles,
    // "validar se os valores estao corretos" caia em UNKNOWN.
    words: [
      'corrig', 'conserta', 'bug', 'erro', 'falha', 'quebrad', 'fix', 'broken',
      'crash', 'valida', 'verific', 'confer', 'revis', 'check', 'audit',
    ],
  },
  {
    kind: 'TEST',
    words: ['test', 'teste', 'cobertura', 'coverage', 'spec', 'mock'],
  },
  {
    kind: 'REFACTOR',
    words: ['refator', 'refactor', 'reorganiz', 'renomea', 'rename', 'extrai', 'extract', 'limpa', 'simplific'],
  },
  {
    kind: 'MIGRATION',
    words: ['migra', 'migrat', 'porta', 'converte', 'reescrev', 'rewrite'],
  },
  {
    kind: 'EXPLAIN',
    words: ['como funciona', 'explica', 'explain', 'entender', 'documenta', 'o que faz', 'onde está', 'onde fica'],
  },
  {
    kind: 'FEATURE',
    words: ['adiciona', 'implementa', 'cria', 'nov', 'add', 'implement', 'create', 'suporte a'],
  },
];

/**
 * Afinidade entre tipo de entidade e tipo de tarefa — o sinal `taskType`.
 *
 * Valores em [0,1]. O caso que justifica a tabela: numa tarefa de TEST, arquivos
 * de teste sobem; numa tarefa de BUG_FIX eles são contexto útil mas secundário,
 * e ocupar o orçamento com eles tira espaço do código que precisa ser corrigido.
 */
const TASK_AFFINITY: Readonly<Record<TaskKind, Partial<Record<EntityType, number>>>> = {
  // VARIABLE/CONSTANT recebem peso baixo explicito: raramente sao o alvo de uma
  // tarefa de codigo, e sem isso caiam na afinidade neutra e competiam de igual
  // para igual com funcoes — medido num projeto CommonJS, onde variaveis de
  // topo ocupavam as primeiras posicoes.
  BUG_FIX: { FUNCTION: 1, METHOD: 1, TEST: 0.6, CLASS: 0.7, FILE: 0.3, VARIABLE: 0.2, CONSTANT: 0.3 },
  FEATURE: {
    FUNCTION: 0.9, METHOD: 0.9, CLASS: 0.9, INTERFACE: 0.8, TYPE: 0.7, FILE: 0.4,
    VARIABLE: 0.2, CONSTANT: 0.4,
  },
  REFACTOR: { FUNCTION: 1, METHOD: 1, CLASS: 0.9, TEST: 0.7, FILE: 0.4, VARIABLE: 0.2, CONSTANT: 0.3 },
  TEST: { TEST: 1, FUNCTION: 0.8, METHOD: 0.8, FILE: 0.3 },
  EXPLAIN: { FILE: 0.8, CLASS: 0.9, FUNCTION: 0.8, INTERFACE: 0.8, ENDPOINT: 0.9 },
  MIGRATION: { FILE: 0.9, MODULE: 0.9, CLASS: 0.8, FUNCTION: 0.8 },
  UNKNOWN: {},
};

/**
 * Afinidade base por tipo de entidade, independente da tarefa.
 *
 * Existe porque a tabela por tarefa nao cobre tudo, e `UNKNOWN` nao cobre nada.
 * Antes disso, uma tarefa nao classificada caia num valor neutro unico (0,5) e
 * variavel de modulo competia de igual para igual com funcao — resultado real
 * num projeto de 421 arquivos: variáveis locais de controladores sem relação
 * com a tarefa ocupavam o topo do ranking.
 *
 * A ordem aqui e uma afirmacao sobre o que costuma ser alvo de tarefa de
 * engenharia: codigo executavel primeiro, declaracao de tipo depois,
 * armazenamento de valor por ultimo.
 */
const BASE_AFFINITY: Partial<Record<EntityType, number>> = {
  FUNCTION: 1,
  METHOD: 1,
  COMPONENT: 1,
  ENDPOINT: 0.95,
  CLASS: 0.85,
  SERVICE: 0.85,
  CONTROLLER: 0.85,
  REPOSITORY: 0.85,
  INTERFACE: 0.7,
  TYPE: 0.65,
  TEST: 0.6,
  QUERY: 0.6,
  FILE: 0.45,
  MODULE: 0.45,
  CONSTANT: 0.3,
  VARIABLE: 0.2,
};

/** Usado quando o tipo nao consta em nenhuma das duas tabelas. */
const NEUTRAL_AFFINITY = 0.5;

export function affinityFor(kind: TaskKind, type: EntityType): number {
  return TASK_AFFINITY[kind][type] ?? BASE_AFFINITY[type] ?? NEUTRAL_AFFINITY;
}

/**
 * Identificadores citados na tarefa.
 *
 * Reconhece o que *parece* nome de código e não palavra comum: camelCase,
 * PascalCase, snake_case, ou algo entre acentos graves. Uma palavra minúscula
 * solta ("comissão") não conta — ela vira termo de busca, não símbolo, porque
 * tratá-la como símbolo daria peso de casamento exato a uma coincidência.
 */
export function extractSymbols(task: string): string[] {
  const symbols = new Set<string>();

  for (const match of task.matchAll(/`([^`]+)`/g)) {
    const inner = match[1]?.trim();
    if (inner && /^[A-Za-z_$][\w$.]*$/.test(inner)) symbols.add(inner);
  }

  for (const word of task.split(/[^\w$.]+/)) {
    if (word.length < 3) continue;

    /*
     * `PascalCase` de palavra única entra como candidato.
     *
     * Encontrado rodando `pil context` sobre o próprio PIL: a tarefa
     * "corrigir a resolução de imports no Resolver" não detectava `Resolver`,
     * porque a regra exigia transição de caixa interna. O alvo óbvio da tarefa
     * ficava sem virar semente.
     *
     * O custo de um falso candidato é zero: quem confirma é o índice —
     * `findEntitiesByName` não devolve nada para "Corrigir", e a palavra
     * simplesmente não gera semente. Já o custo de *não* detectar é perder o
     * sinal mais forte que existe.
     */
    const looksLikeCode =
      /[a-z][A-Z]/.test(word) ||
      /^[A-Z][a-z]+[A-Z]/.test(word) ||
      /_/.test(word) ||
      /^[A-Z][a-z]{2,}$/.test(word);

    /*
     * Verbo de intencao capitalizado nao e simbolo.
     *
     * "Validar se os valores estao corretos" comeca a frase com maiuscula, e a
     * regra de PascalCase de uma palavra aceitava `Validar` como identificador
     * citado — o que deu casamento de simbolo perfeito com `FUNCTION:validar`
     * de um arquivo sem relacao com a tarefa, no topo do ranking com score 67.
     *
     * O mesmo filtro do lado da busca vale aqui, porque a causa e a mesma: a
     * palavra descreve a intencao, nao o assunto.
     */
    if (looksLikeCode && !isIntentVerb(stripDiacritics(word))) symbols.add(word);
  }

  return [...symbols];
}

export function extractPaths(task: string): string[] {
  const paths = new Set<string>();
  for (const match of task.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sql|css|html)\b/g)) {
    paths.add(match[0]);
  }
  return [...paths];
}

export function classifyTask(task: string): TaskKind {
  const lower = task.toLowerCase();
  for (const { kind, words } of KIND_HINTS) {
    if (words.some((word) => lower.includes(word))) return kind;
  }
  return 'UNKNOWN';
}

export function analyzeTask(task: string): TaskAnalysis {
  const symbols = extractSymbols(task);
  const terms = new Set<string>();

  // Normaliza acento antes de quebrar: ver stripDiacritics em text.ts.
  for (const word of stripDiacritics(task).split(/[^\w$]+/)) {
    if (word.length >= 3) {
      for (const part of splitIdentifier(word)) terms.add(part.toLowerCase());
    }
  }

  return {
    kind: classifyTask(task),
    symbols,
    paths: extractPaths(task),
    terms: [...terms],
  };
}
