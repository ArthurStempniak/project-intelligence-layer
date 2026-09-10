/**
 * Grafo de dependencias (spec 7).
 *
 * Decisao central deste arquivo: `confidence` nao e um numero arbitrario. Ele e
 * *derivado* da forma como o alvo foi resolvido. Analise estatica sem inferencia
 * de tipos nao resolve despacho dinamico (`obj.metodo()` com `obj` de tipo
 * desconhecido), reflexao, ou binding por string. Se o grafo tratar um palpite
 * por nome com a mesma confianca de um import explicito, `pil impact` produz
 * resultados errados com aparencia de certeza — que e pior do que nao responder.
 */

export const RELATION_TYPES = [
  'IMPORTS',
  'EXPORTS',
  'CALLS',
  'REFERENCES',
  'EXTENDS',
  'IMPLEMENTS',
  'USES',
  'CONTAINS',
  'DEPENDS_ON',
  'READS',
  'WRITES',
  'QUERIES',
  'RENDERS',
  'TESTS',
  'CONFIGURES',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

const RELATION_TYPE_SET: ReadonlySet<string> = new Set(RELATION_TYPES);

export function isRelationType(value: string): value is RelationType {
  return RELATION_TYPE_SET.has(value);
}

/**
 * Como o alvo da relacao foi determinado. Ordenado da maior para a menor
 * garantia.
 */
export const RESOLUTION_TIERS = ['EXACT', 'SCOPED', 'AMBIGUOUS', 'UNRESOLVED'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

/** Confianca fixa dos tiers deterministicos. AMBIGUOUS e calculado. */
const TIER_CONFIDENCE = {
  /** Ligado por um import/declaracao explicita na cadeia de escopo. */
  EXACT: 1.0,
  /** Simbolo unico com esse nome no modulo ou projeto, sem prova de binding. */
  SCOPED: 0.75,
  /** Nenhum candidato encontrado. Guardado como pista para re-resolucao. */
  UNRESOLVED: 0.0,
} as const;

/** Teto de confianca para um alvo escolhido entre multiplos candidatos. */
const AMBIGUOUS_CEILING = 0.5;

/**
 * Confianca de uma relacao resolvida por nome entre `candidateCount`
 * candidatos homonimos.
 *
 * Modelada como probabilidade uniforme (`1/N`) limitada por
 * {@link AMBIGUOUS_CEILING}: mesmo com um unico candidato, a ausencia de
 * binding explicito nao justifica confianca de tier EXACT.
 */
export function ambiguousConfidence(candidateCount: number): number {
  if (candidateCount <= 0) return TIER_CONFIDENCE.UNRESOLVED;
  return Math.min(AMBIGUOUS_CEILING, 1 / candidateCount);
}

/** Confianca canonica de um tier. `AMBIGUOUS` exige `candidateCount`. */
export function confidenceForTier(tier: ResolutionTier, candidateCount = 0): number {
  if (tier === 'AMBIGUOUS') return ambiguousConfidence(candidateCount);
  return TIER_CONFIDENCE[tier];
}

/**
 * Aresta do grafo.
 *
 * `targetId` e nulo enquanto a relacao estiver `UNRESOLVED`. Guardar a aresta
 * mesmo sem alvo e proposital: quando um arquivo novo entra no indice, a
 * re-resolucao consulta as pistas pendentes por `targetHint` em vez de
 * reparsear o projeto inteiro (spec 9).
 */
export interface CodeRelation {
  sourceId: string;
  targetId: string | null;
  /** Nome ou especificador cru, como escrito no codigo. Ex.: `./client.js`. */
  targetHint: string;
  type: RelationType;
  resolution: ResolutionTier;
  /** Derivado de `resolution` via {@link confidenceForTier}. Faixa 0.0–1.0. */
  confidence: number;
  /**
   * Arquivo onde a aresta foi observada. Necessario para o delete incremental:
   * ao reindexar um arquivo, apagamos as arestas que *nascem* nele.
   */
  filePath: string;
  line: number;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Relacoes cujo sentido semantico se inverte na analise de impacto.
 *
 * `pil impact X` pergunta "quem quebra se X mudar?" — logo percorre as arestas
 * ao contrario: os *chamadores* de X, nao o que X chama.
 */
export const IMPACT_TRAVERSAL_TYPES: ReadonlySet<RelationType> = new Set<RelationType>([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'REFERENCES',
  'USES',
  'RENDERS',
  'QUERIES',
  'TESTS',
]);
