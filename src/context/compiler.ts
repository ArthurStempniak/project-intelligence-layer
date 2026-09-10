/**
 * Context Compiler (spec §13, §14, §15).
 *
 * Recebe entidades pontuadas e produz o pacote que vai ao agente, respeitando o
 * orçamento de tokens.
 *
 * A decisão central: uma entidade não é "entra ou não entra". Ela entra num de
 * três níveis de detalhe, e isso transforma o corte binário em degradação
 * gradual. Com orçamento apertado, um vizinho cai de FULL para SIGNATURE em vez
 * de desaparecer — preservar a *existência* de uma dependência custa poucos
 * tokens e evita que o agente reescreva algo que já existe, que é o modo de
 * falha mais caro de um contexto reduzido.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ContextItem,
  ContextMetrics,
  ContextPackage,
  DetailLevel,
  ScoredEntity,
  TaskKind,
} from '../core/types/index.js';
import { estimateTokens } from '../core/tokens.js';
import type { IndexStats, Storage } from '../storage/storage.js';

export interface CompileOptions {
  task: string;
  taskKind: TaskKind;
  ranked: readonly ScoredEntity[];
  /** Orçamento já com a margem de segurança descontada. */
  budget: number;
  /** Raiz do projeto, para ler o código-fonte das entidades escolhidas. */
  root: string;
  startedAt: number;
  consideredCount: number;
}

/**
 * Acima deste score a entidade é candidata a FULL.
 *
 * Escolhido para separar "provavelmente é o alvo da tarefa" de "é vizinhança
 * relevante". É um limiar calibrável pelo benchmark, não uma constante sagrada.
 */
const FULL_DETAIL_THRESHOLD = 55;

/** Custo aproximado de uma linha de REFERENCE. Usado no planejamento. */
const REFERENCE_COST = 12;

/**
 * Fracao do melhor score abaixo da qual o candidato e descartado.
 *
 * Calibrado contra o benchmark, nao escolhido a priori. Em 0.45 a precisao
 * subiu de 3% para 21%, mas os pacotes ficaram com 2 arquivos onde 1 importava:
 * o piso cortava o alvo junto com o ruido. Como o recall e a metrica que falha
 * e a precisao ja melhorou 7x, trocar precisao por recall e a direcao certa.
 */
const RELATIVE_SCORE_FLOOR = 0.25;

/** Piso absoluto: abaixo disto nao ha sinal, so vizinhanca de grafo. */
const ABSOLUTE_SCORE_FLOOR = 12;

/**
 * Maximo de arquivos distintos no pacote.
 *
 * Uma tarefa de engenharia toca um punhado de arquivos. Quando o pacote cobre
 * dezenas, o motor nao esta sendo abrangente — esta admitindo que nao sabe, e
 * gastando o orcamento em fragmentos de 60 tokens que nao permitem entender
 * nada. Resultado real num projeto de 421 arquivos: 89 entidades espalhadas por
 * 40 arquivos, ~85 tokens cada.
 *
 * Concentrar tem duas vantagens sobre espalhar: cada arquivo incluido recebe
 * orcamento suficiente para ser compreensivel, e um pacote focado *errado* e
 * visivelmente errado — o usuario percebe e usa `--include`. Um pacote difuso
 * parece plausivel e desperdica a rodada.
 */
const MAX_FILES = 12;

export class ContextCompiler {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async compile(options: CompileOptions): Promise<ContextPackage> {
    const stats = await this.#storage.stats();
    const sourceCache = new Map<string, string>();

    /*
     * Ordenação por SCORE, com densidade só como desempate.
     *
     * A versão anterior ordenava por densidade (score/tokens), argumentando que
     * isso maximiza relevância por token gasto. O benchmark mostrou que o
     * argumento estava errado — não na matemática, no objetivo.
     *
     * Densidade é o ótimo do knapsack fracionário para maximizar *score total*.
     * Mas o objetivo do PIL não é somar score: é incluir as poucas entidades
     * que a tarefa realmente toca. Maximizar a soma premia encher o pacote de
     * itens medíocres e baratos — uma REFERENCE de 15 tokens com score 15 tem
     * densidade 1,0, enquanto a função-alvo de 300 tokens com score 60 tem
     * 0,2. O resultado medido: 22 arquivos selecionados onde 1 importava, e o
     * arquivo certo expulso do orçamento por dezenas de fragmentos irrelevantes.
     *
     * Ordenar por score coloca os alvos prováveis primeiro; a densidade decide
     * apenas entre candidatos de relevância equivalente.
     */
    const floor = scoreFloor(options.ranked);
    const byPriority = [...options.ranked]
      .filter((candidate) => candidate.score >= floor)
      .sort((a, b) => b.score - a.score || density(b) - density(a));

    const items: ContextItem[] = [];
    const omitted: ContextPackage['omitted'] = [];
    const filesUsed = new Set<string>();
    let spent = 0;

    for (const candidate of byPriority) {
      const remaining = options.budget - spent;

      // Atingido o teto de arquivos, so entram entidades dos arquivos que ja
      // estao no pacote — aprofundar onde ja se olhou, em vez de espalhar.
      const filePath = candidate.entity.filePath;
      if (filesUsed.size >= MAX_FILES && !filesUsed.has(filePath)) {
        omitted.push({
          entityId: candidate.entity.id,
          score: candidate.score,
          tokens: candidate.entity.tokenEstimate,
        });
        continue;
      }

      if (remaining <= REFERENCE_COST) {
        omitted.push({
          entityId: candidate.entity.id,
          score: candidate.score,
          tokens: candidate.entity.tokenEstimate,
        });
        continue;
      }

      const item = await this.#renderBestFit(candidate, remaining, options.root, sourceCache);
      if (!item) {
        omitted.push({
          entityId: candidate.entity.id,
          score: candidate.score,
          tokens: candidate.entity.tokenEstimate,
        });
        continue;
      }

      items.push(item);
      filesUsed.add(filePath);
      spent += item.tokens;
    }

    // Reordena para leitura humana e do agente: agrupado por arquivo, na ordem
    // do código. O pacote é lido como código, não como ranking — e um arquivo
    // fatiado fora de ordem força o leitor a remontar mentalmente.
    items.sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || b.score - a.score,
    );

    return {
      task: options.task,
      taskKind: options.taskKind,
      projectSummary: this.#summarize(stats),
      items,
      omitted,
      metrics: this.#metrics(options, stats, items, spent),
    };
  }

  /**
   * Escolhe o nível de detalhe mais informativo que cabe no que resta.
   *
   * Degrada em cascata FULL → SIGNATURE → REFERENCE. Devolve `null` só quando
   * nem a referência de uma linha cabe.
   */
  async #renderBestFit(
    candidate: ScoredEntity,
    remaining: number,
    root: string,
    cache: Map<string, string>,
  ): Promise<ContextItem | null> {
    const wanted: DetailLevel =
      candidate.score >= FULL_DETAIL_THRESHOLD || candidate.hopDistance === 0
        ? 'FULL'
        : 'SIGNATURE';

    const ladder: DetailLevel[] =
      wanted === 'FULL' ? ['FULL', 'SIGNATURE', 'REFERENCE'] : ['SIGNATURE', 'REFERENCE'];

    for (const detail of ladder) {
      const content = await this.#render(candidate, detail, root, cache);
      if (content === null) continue;

      const tokens = estimateTokens(content);
      if (tokens <= remaining) {
        return {
          entityId: candidate.entity.id,
          filePath: candidate.entity.filePath,
          detail,
          score: Math.round(candidate.score),
          tokens,
          content,
        };
      }
    }

    return null;
  }

  async #render(
    candidate: ScoredEntity,
    detail: DetailLevel,
    root: string,
    cache: Map<string, string>,
  ): Promise<string | null> {
    const { entity } = candidate;
    const location = `${entity.filePath}:${entity.startLine}`;

    if (detail === 'REFERENCE') {
      return `${entity.type} ${entity.qualifiedName}  (${location})`;
    }

    if (detail === 'SIGNATURE') {
      return this.#renderSignature(candidate, location);
    }

    const source = await this.#readSource(entity.filePath, root, cache);
    if (source === null) return null;

    const code = source.slice(entity.startByte, entity.endByte);
    if (code.trim() === '') return null;

    return [
      `// ${location} — ${entity.type} ${entity.qualifiedName}`,
      entity.documentation ? `// ${entity.documentation.split('\n')[0]}` : null,
      code,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  /**
   * Representação compacta da spec §15: contrato sem implementação.
   *
   * Inclui as chamadas que a entidade faz porque é a informação que impede o
   * agente de reimplementar algo já existente — sem elas, a assinatura diz o
   * que a função recebe, mas não com o que ela conta.
   */
  async #renderSignature(candidate: ScoredEntity, location: string): Promise<string> {
    const { entity } = candidate;
    const lines = [`${entity.type} ${entity.qualifiedName}  (${location})`];

    if (entity.signature) lines.push(`  ${entity.signature}`);
    if (entity.documentation) lines.push(`  DOC: ${entity.documentation.split('\n')[0]}`);

    const outgoing = await this.#storage.relationsFrom(entity.id);
    const calls = [...new Set(outgoing.filter((r) => r.type === 'CALLS').map((r) => r.targetHint))];
    if (calls.length > 0) lines.push(`  CALLS: ${calls.slice(0, 12).join(', ')}`);

    const extend = outgoing.find((r) => r.type === 'EXTENDS');
    if (extend) lines.push(`  EXTENDS: ${extend.targetHint}`);

    return lines.join('\n');
  }

  async #readSource(
    filePath: string,
    root: string,
    cache: Map<string, string>,
  ): Promise<string | null> {
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;

    try {
      const content = await readFile(join(root, filePath), 'utf8');
      cache.set(filePath, content);
      return content;
    } catch {
      // Arquivo indexado que já não existe: o índice está adiante do disco.
      // Não é motivo para falhar o comando — a entidade só perde o nível FULL.
      return null;
    }
  }

  #summarize(stats: IndexStats): string {
    const languages = Object.entries(stats.filesByLanguage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([language, count]) => `${language} (${count})`)
      .join(', ');

    return [
      `${stats.files} arquivos, ${stats.entities} entidades, ${stats.relations} relações.`,
      `Linguagens: ${languages}.`,
    ].join(' ');
  }

  #metrics(
    options: CompileOptions,
    stats: IndexStats,
    items: readonly ContextItem[],
    spent: number,
  ): ContextMetrics {
    const filesSelected = new Set(items.map((item) => item.filePath)).size;

    return {
      projectTokens: stats.totalTokens,
      selectedTokens: spent,
      budget: options.budget,
      // Guardado contra divisão por zero em índice vazio: uma métrica NaN
      // contaminaria o relatório do benchmark sem sinalizar a causa.
      reduction: stats.totalTokens > 0 ? 1 - spent / stats.totalTokens : 0,
      filesInProject: stats.files,
      filesSelected,
      entitiesConsidered: options.consideredCount,
      entitiesSelected: items.length,
      elapsedMs: Date.now() - options.startedAt,
    };
  }
}

function density(candidate: ScoredEntity): number {
  return candidate.score / Math.max(1, candidate.entity.tokenEstimate);
}

/**
 * Piso de score: fracao do topo, com minimo absoluto.
 *
 * Um candidato muito abaixo do melhor nao e contexto, e ruido — e ruido gasta
 * orcamento que o alvo precisa. O piso e *relativo* porque a escala do score
 * varia com a tarefa: uma tarefa que cita um simbolo produz topo perto de 100,
 * uma tarefa vaga produz topo perto de 30, e um limiar fixo trataria as duas
 * como se fossem a mesma coisa.
 *
 * O minimo absoluto evita o caso degenerado: quando o topo e baixissimo, todo
 * o conjunto e fraco e nao vale gastar orcamento com ele.
 */
function scoreFloor(ranked: readonly ScoredEntity[]): number {
  const top = ranked.reduce((max, candidate) => Math.max(max, candidate.score), 0);
  return Math.max(top * RELATIVE_SCORE_FLOOR, ABSOLUTE_SCORE_FLOOR);
}

/** Serializa o pacote no formato que vai ao agente. */
export function renderPackage(pkg: ContextPackage): string {
  const sections = [
    '# TAREFA',
    pkg.task,
    '',
    `# TIPO DE TAREFA`,
    pkg.taskKind,
    '',
    '# PROJETO',
    pkg.projectSummary,
    '',
    '# CONTEXTO RELEVANTE',
  ];

  let currentFile = '';
  for (const item of pkg.items) {
    if (item.filePath !== currentFile) {
      currentFile = item.filePath;
      sections.push('', `## ${currentFile}`);
    }
    sections.push('', item.content);
  }

  if (pkg.omitted.length > 0) {
    /*
     * O agente é avisado do que ficou de fora.
     *
     * Sem isso ele não tem como saber se o contexto está completo, e a falha
     * silenciosa — assumir que o que não veio não existe — é exatamente o risco
     * que um contexto reduzido introduz.
     */
    sections.push(
      '',
      '# OMITIDO POR ORÇAMENTO',
      `${pkg.omitted.length} entidade(s) relevante(s) não couberam. Peça explicitamente se precisar:`,
      ...pkg.omitted.slice(0, 15).map((o) => `- ${o.entityId} (score ${Math.round(o.score)})`),
    );
  }

  return sections.join('\n');
}
