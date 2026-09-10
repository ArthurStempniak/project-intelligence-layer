/**
 * Relevance Engine (spec §12, docs/RELEVANCE.md).
 *
 * Pipeline em duas fases com objetivos opostos:
 *
 *   RECUPERAÇÃO  recall alto, precisão baixa, barato  → sementes
 *   PONTUAÇÃO    precisão, sobre um conjunto pequeno  → ranking
 *
 * A separação é o que permite errar barato: a recuperação pode ser generosa
 * porque a pontuação corta depois. Se a recuperação fosse restritiva, nenhuma
 * pontuação recuperaria o que ela deixou de fora.
 *
 * Cada sinal é normalizado para [0,1] na origem e combinado por média
 * ponderada, renormalizada pela soma dos pesos ativos — ver RELEVANCE.md para
 * por que a soma crua da spec não produz uma escala comparável.
 */

import type {
  CodeEntity,
  RelevanceSignals,
  RelevanceWeights,
  ScoredEntity,
} from '../core/types/index.js';
import { DEFAULT_WEIGHTS } from '../core/types/index.js';
import { pathSearchTerms, toFtsQuery } from '../core/text.js';
import { buildLexicon, expandTerms, type Lexicon } from '../core/lexicon.js';
import { EMPTY_RECENCY, loadRecency, mostRecentFiles, recencyScore, type RecencyIndex } from '../core/git.js';
import type { NeighborResult, Storage } from '../storage/storage.js';
import { affinityFor, analyzeTask, type TaskAnalysis } from './task.js';

export interface RankOptions {
  task: string;
  maxHops: number;
  /** Raiz do projeto, para consultar o histórico do git. */
  root?: string | undefined;
  weights?: Partial<RelevanceWeights> | undefined;
  /** Caminhos forçados a entrar como sementes. */
  include?: readonly string[] | undefined;
  /** Teto de candidatos pontuados. Protege memória em projeto grande. */
  candidateLimit?: number | undefined;
  /** Grupos de sinônimos do projeto, somados ao léxico embutido. */
  dictionary?: string[][] | undefined;
}

export interface RankResult {
  analysis: TaskAnalysis;
  ranked: ScoredEntity[];
  seedIds: string[];
  consideredCount: number;
}

/** Quantos resultados do FTS viram sementes. */
const LEXICAL_SEED_LIMIT = 40;

/** Arquivos semeados por casamento de caminho. */
const PATH_SEED_LIMIT = 6;
const DEFAULT_CANDIDATE_LIMIT = 3000;

/** Arquivos recentes usados como semente quando a busca não acha nada. */
const RECENCY_FALLBACK_FILES = 8;

/** Entidades sem corpo próprio não competem por orçamento como código. */
const CONTAINER_TYPES = new Set(['FILE', 'DIRECTORY', 'PROJECT', 'MODULE']);

export class RelevanceEngine {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async rank(options: RankOptions): Promise<RankResult> {
    const analysis = analyzeTask(options.task);
    const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    const recency = options.root === undefined ? EMPTY_RECENCY : await loadRecency(options.root);
    const lexicon = buildLexicon(options.dictionary ?? []);

    const seeds = await this.#findSeeds(analysis, options.include ?? [], recency, lexicon);
    const seedIds = [...seeds.keys()];

    if (seedIds.length === 0) {
      return { analysis, ranked: [], seedIds: [], consideredCount: 0 };
    }

    // Expansão pelo grafo em ambas as direções: o que a semente usa (para
    // entender o contrato) e quem usa a semente (para não quebrar chamadores).
    const neighbors = await this.#storage.neighbors({
      seedIds,
      depth: options.maxHops,
      direction: 'BOTH',
      minConfidence: 0.2,
      limit: options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
    });

    const candidates = await this.#collectCandidates(seedIds, neighbors);
    const scored = await this.#score(candidates, seeds, neighbors, analysis, weights, recency, lexicon);

    scored.sort((a, b) => b.score - a.score);
    return { analysis, ranked: scored, seedIds, consideredCount: candidates.length };
  }

  /**
   * Sementes: onde a busca começa.
   *
   * Três fontes independentes, de propósito — cada uma cobre um modo de falha
   * das outras. O casamento de símbolo funciona quando o usuário sabe o nome; o
   * FTS funciona quando ele descreve; o `--include` funciona quando nenhum dos
   * dois acerta e ele aponta o dedo. A barreira de idioma (ARCHITECTURE.md §10)
   * derruba o FTS, e é justamente por isso que as outras duas existem.
   *
   * O valor guardado é a razão da inclusão, exibida por `--explain`.
   */
  async #findSeeds(
    analysis: TaskAnalysis,
    include: readonly string[],
    recency: RecencyIndex,
    lexicon: Lexicon,
  ): Promise<Map<string, string[]>> {
    const seeds = new Map<string, string[]>();
    const add = (id: string, reason: string): void => {
      const existing = seeds.get(id);
      if (existing) existing.push(reason);
      else seeds.set(id, [reason]);
    };

    for (const symbol of analysis.symbols) {
      for (const entity of await this.#storage.findEntitiesByName(symbol)) {
        add(entity.id, `símbolo "${symbol}" citado na tarefa`);
      }
    }

    for (const path of [...analysis.paths, ...include]) {
      for (const entity of await this.#storage.getEntitiesByFile(path)) {
        add(entity.id, `arquivo ${path} citado`);
      }
    }

    // Termos da tarefa mais seus sinonimos: e o que atravessa a barreira de
    // idioma quando nao ha cognato de raiz comum.
    const termos = expandTerms(analysis.terms, lexicon);

    /*
     * Caminho de arquivo como fonte de semente, separada do FTS.
     *
     * Medido: para "validar os valores da tela de indicação", os arquivos
     * o arquivo da tela e o seu controller apareciam nas posições 76
     * e 77 do FTS, com limite de 40 sementes — nunca entravam. O bm25 normaliza
     * por tamanho, então a entidade FILE (caminho + todas as assinaturas +
     * todos os literais) sempre perde para uma variável de três termos que por
     * acaso casa.
     *
     * O nome do arquivo é o indicador de assunto mais forte de um código, e
     * precisa de uma consulta própria para não ser afogado.
     */
    const formasDeCaminho = pathSearchTerms(termos);
    for (const path of await this.#storage.findFilesByPathTerms(formasDeCaminho, PATH_SEED_LIMIT)) {
      for (const entity of await this.#storage.getEntitiesByFile(path)) {
        add(entity.id, `caminho do arquivo casa com a tarefa (${path})`);
      }
    }

    const query = toFtsQuery(termos.join(' '));
    if (query !== '') {
      for (const hit of await this.#storage.searchLexical(query, LEXICAL_SEED_LIMIT)) {
        add(hit.entityId, 'casamento lexical com a tarefa');
      }
    }

    /*
     * Fallback: sem nenhuma semente, usa os arquivos alterados mais recentemente.
     *
     * Zero sementes significa contexto vazio — o pior desfecho possível, porque
     * o agente recebe nada e não tem como saber que houve falha de busca. O
     * benchmark encontrou esse caso ("Replace em-dashes with commas"): tarefa
     * sem nenhum termo que exista em identificador ou literal do projeto.
     *
     * Recência é um palpite fraco, e a razão registrada diz isso. Mas um palpite
     * fraco sobre onde o trabalho está acontecendo é estritamente melhor que
     * silêncio.
     */
    if (seeds.size === 0 && recency.available) {
      for (const path of mostRecentFiles(recency, RECENCY_FALLBACK_FILES)) {
        for (const entity of await this.#storage.getEntitiesByFile(path)) {
          add(entity.id, 'nenhuma semente encontrada; arquivo alterado recentemente');
        }
      }
    }

    return seeds;
  }

  async #collectCandidates(
    seedIds: readonly string[],
    neighbors: readonly NeighborResult[],
  ): Promise<CodeEntity[]> {
    const ids = new Set<string>(seedIds);
    for (const neighbor of neighbors) ids.add(neighbor.entityId);
    return this.#storage.getEntities([...ids]);
  }

  async #score(
    candidates: readonly CodeEntity[],
    seeds: ReadonlyMap<string, string[]>,
    neighbors: readonly NeighborResult[],
    analysis: TaskAnalysis,
    weights: RelevanceWeights,
    recency: RecencyIndex,
    lexicon: Lexicon,
  ): Promise<ScoredEntity[]> {
    const hops = new Map(neighbors.map((n) => [n.entityId, n.hopDistance]));
    const ids = candidates.map((c) => c.id);

    const lexical = await this.#lexicalScores(analysis, lexicon);
    const degrees = await this.#storage.inDegrees(ids);
    const maxDegree = Math.max(1, ...degrees.values());
    const directCalls = await this.#directCallPartners(seeds);
    const testLinked = await this.#testLinked(seeds);

    const symbolSet = new Set(analysis.symbols.map((s) => s.toLowerCase()));

    return candidates.map((entity) => {
      const hopDistance = seeds.has(entity.id) ? 0 : (hops.get(entity.id) ?? Infinity);

      const signals: RelevanceSignals = {
        // Embeddings entram na Fase 2; o peso 0 mantém o sinal declarado e
        // inerte, para que ligá-lo não exija mudar a estrutura do score.
        semantic: 0,
        lexical: lexical.get(entity.id) ?? 0,
        symbolMatch: symbolMatchScore(entity, symbolSet),
        graphProximity: Number.isFinite(hopDistance) ? 1 / (1 + hopDistance) : 0,
        callRelationship: directCalls.has(entity.id) ? 1 : 0,
        fileImportance: (degrees.get(entity.id) ?? 0) / maxDegree,
        taskType: affinityFor(analysis.kind, entity.type),
        recentChanges: recencyScore(recency, entity.filePath),
        testRelationship: testLinked.has(entity.id) ? 1 : 0,
      };

      const reasons = [...(seeds.get(entity.id) ?? [])];
      if (hopDistance > 0 && Number.isFinite(hopDistance)) {
        reasons.push(`${hopDistance} salto(s) no grafo a partir de uma semente`);
      }
      if (signals.callRelationship === 1) reasons.push('chamada direta de/para uma semente');
      if (signals.testRelationship === 1) reasons.push('ligado por teste');
      if (signals.recentChanges > 0.5) reasons.push('arquivo alterado recentemente');

      return {
        entity,
        signals,
        score: weightedScore(signals, weights),
        hopDistance: Number.isFinite(hopDistance) ? hopDistance : -1,
        reasons,
      };
    });
  }

  /**
   * BM25 normalizado pelo topo do resultado.
   *
   * A normalização é relativa ao melhor casamento *desta* consulta, e não a uma
   * constante: BM25 não tem teto, e seu valor absoluto varia com o tamanho do
   * corpus. Sem isso, o mesmo ranking produziria escalas diferentes em projetos
   * diferentes, e o benchmark não conseguiria comparar execuções.
   */
  async #lexicalScores(analysis: TaskAnalysis, lexicon: Lexicon): Promise<Map<string, number>> {
    const query = toFtsQuery(expandTerms(analysis.terms, lexicon).join(' '));
    if (query === '') return new Map();

    const hits = await this.#storage.searchLexical(query, 500);
    const top = hits[0]?.rawScore ?? 0;
    if (top <= 0) return new Map();

    return new Map(hits.map((hit) => [hit.entityId, Math.min(1, hit.rawScore / top)]));
  }

  /** Entidades em aresta CALLS direta com alguma semente, nos dois sentidos. */
  async #directCallPartners(seeds: ReadonlyMap<string, string[]>): Promise<Set<string>> {
    const partners = new Set<string>();

    for (const seedId of seeds.keys()) {
      for (const relation of await this.#storage.relationsFrom(seedId)) {
        if (relation.type === 'CALLS' && relation.targetId) partners.add(relation.targetId);
      }
      for (const relation of await this.#storage.relationsTo(seedId)) {
        if (relation.type === 'CALLS') partners.add(relation.sourceId);
      }
    }

    return partners;
  }

  async #testLinked(seeds: ReadonlyMap<string, string[]>): Promise<Set<string>> {
    const linked = new Set<string>();

    for (const seedId of seeds.keys()) {
      for (const relation of await this.#storage.relationsTo(seedId)) {
        if (relation.type === 'TESTS') linked.add(relation.sourceId);
      }
    }

    return linked;
  }
}

/**
 * Casamento de símbolo, com meio ponto para casamento parcial.
 *
 * O parcial existe porque a tarefa cita `ClientService` e o alvo real pode ser
 * `ClientService.create`: exigir igualdade exata perderia o método, que é
 * justamente o que precisa ser alterado.
 */
function symbolMatchScore(entity: CodeEntity, symbols: ReadonlySet<string>): number {
  if (symbols.size === 0) return 0;

  const name = entity.name.toLowerCase();
  const qualified = entity.qualifiedName.toLowerCase();

  if (symbols.has(name) || symbols.has(qualified)) return 1;
  for (const symbol of symbols) {
    if (qualified.includes(symbol) || symbol.includes(name)) return 0.5;
  }
  return 0;
}

/**
 * Média ponderada renormalizada, em [0,100].
 *
 * Dividir pela soma dos pesos *ativos* é o que mantém a escala estável quando
 * um sinal está desligado: sem isso, ligar embeddings na Fase 2 mudaria todos os
 * scores sem que a qualidade do ranking tivesse mudado, e qualquer corte por
 * limiar absoluto passaria a se comportar de outro jeito.
 */
export function weightedScore(signals: RelevanceSignals, weights: RelevanceWeights): number {
  let total = 0;
  let weightSum = 0;

  for (const key of Object.keys(weights) as Array<keyof RelevanceSignals>) {
    const weight = weights[key];
    if (weight <= 0) continue;
    total += weight * signals[key];
    weightSum += weight;
  }

  return weightSum === 0 ? 0 : (total / weightSum) * 100;
}

export function isContainer(type: string): boolean {
  return CONTAINER_TYPES.has(type);
}
