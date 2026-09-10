/**
 * Análise de impacto (spec §16).
 *
 * Responde "o que quebra se eu mudar X?" percorrendo o grafo **ao contrário**:
 * quem chama X, não o que X chama.
 *
 * O risco declarado aqui deriva de números medidos, não de julgamento: um
 * `Risk: MEDIUM` inventado seria pior que nenhum, porque parece informação. E a
 * confiança de cada caminho é exibida junto — sem ela, um alcance construído a
 * partir de dois palpites por nome pareceria igual a um provado por imports.
 */

import type { CodeEntity, RelationType } from '../core/types/index.js';
import { IMPACT_TRAVERSAL_TYPES } from '../core/types/index.js';
import { PilError } from '../core/errors.js';
import type { Storage } from '../storage/storage.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ImpactedEntity {
  entity: CodeEntity;
  hopDistance: number;
  pathConfidence: number;
}

export interface ImpactReport {
  target: CodeEntity;
  /** Outros candidatos com o mesmo nome — a ambiguidade fica visível. */
  alternatives: CodeEntity[];
  direct: ImpactedEntity[];
  indirect: ImpactedEntity[];
  affectedFiles: string[];
  affectedTests: ImpactedEntity[];
  /** Entidades que o alvo depende — quebrar pode vir de fora também. */
  criticalDependencies: string[];
  risk: RiskLevel;
  riskRationale: string;
  /**
   * Arestas que apontam para o alvo mas não foram resolvidas com certeza.
   * Reportado porque é o limite conhecido da análise, não um detalhe.
   */
  lowConfidenceEdges: number;
}

export interface ImpactOptions {
  /** Nome ou id da entidade alvo. */
  target: string;
  maxHops?: number;
  /** Descarta caminhos abaixo desta confiança. */
  minConfidence?: number;
}

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_MIN_CONFIDENCE = 0.3;

export class ImpactAnalyzer {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async analyze(options: ImpactOptions): Promise<ImpactReport> {
    const { target, alternatives } = await this.#resolveTarget(options.target);

    const impacted = await this.#storage.neighbors({
      seedIds: [target.id],
      depth: options.maxHops ?? DEFAULT_MAX_HOPS,
      direction: 'IN',
      types: [...IMPACT_TRAVERSAL_TYPES] as RelationType[],
      minConfidence: options.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    });

    const entities = new Map(
      (await this.#storage.getEntities(impacted.map((i) => i.entityId))).map((e) => [e.id, e]),
    );

    const direct: ImpactedEntity[] = [];
    const indirect: ImpactedEntity[] = [];

    for (const hit of impacted) {
      if (hit.hopDistance === 0) continue;
      const entity = entities.get(hit.entityId);
      if (!entity) continue;

      const record = {
        entity,
        hopDistance: hit.hopDistance,
        pathConfidence: hit.pathConfidence,
      };
      if (hit.hopDistance === 1) direct.push(record);
      else indirect.push(record);
    }

    const all = [...direct, ...indirect];
    const affectedFiles = [...new Set(all.map((i) => i.entity.filePath))];
    const affectedTests = all.filter((i) => isTest(i.entity));

    const incoming = await this.#storage.relationsTo(target.id);
    const lowConfidenceEdges = incoming.filter((r) => r.confidence < 0.75).length;

    const outgoing = await this.#storage.relationsFrom(target.id);
    const criticalDependencies = [
      ...new Set(
        outgoing
          .filter((r) => r.targetId !== null && r.type === 'CALLS')
          .map((r) => r.targetHint),
      ),
    ].slice(0, 10);

    const { risk, riskRationale } = assessRisk({
      direct: direct.length,
      indirect: indirect.length,
      files: affectedFiles.length,
      tests: affectedTests.length,
      exported: target.exported,
    });

    return {
      target,
      alternatives,
      direct: direct.sort(byConfidenceThenName),
      indirect: indirect.sort(byConfidenceThenName),
      affectedFiles: affectedFiles.sort(),
      affectedTests,
      criticalDependencies,
      risk,
      riskRationale,
      lowConfidenceEdges,
    };
  }

  /**
   * Encontra o alvo por id exato ou por nome.
   *
   * Quando há homônimos, escolhe o exportado e **devolve os outros** em
   * `alternatives`. Escolher em silêncio produziria um relatório de impacto
   * sobre a função errada, com a mesma aparência de autoridade do relatório
   * certo — o modo de falha mais perigoso deste comando.
   */
  async #resolveTarget(
    query: string,
  ): Promise<{ target: CodeEntity; alternatives: CodeEntity[] }> {
    const byId = await this.#storage.getEntity(query);
    if (byId) return { target: byId, alternatives: [] };

    const candidates = await this.#storage.findEntitiesByName(query);
    if (candidates.length === 0) {
      throw new PilError(
        'STORAGE_ERROR',
        `Nenhuma entidade chamada "${query}" no índice.`,
        'Rode `pil scan` ou confira o nome.',
      );
    }

    const preferred = candidates.find((c) => c.exported) ?? (candidates[0] as CodeEntity);
    return {
      target: preferred,
      alternatives: candidates.filter((c) => c.id !== preferred.id),
    };
  }
}

function isTest(entity: CodeEntity): boolean {
  return (
    entity.type === 'TEST' ||
    /\.(test|spec)\.[jt]sx?$/.test(entity.filePath) ||
    /(^|\/)test_|_test\.py$/.test(entity.filePath)
  );
}

function byConfidenceThenName(a: ImpactedEntity, b: ImpactedEntity): number {
  return b.pathConfidence - a.pathConfidence || a.entity.qualifiedName.localeCompare(b.entity.qualifiedName);
}

/**
 * Risco derivado de contagens, com o critério explícito.
 *
 * A spec §16 mostra `Risk: MEDIUM` sem dizer de onde vem. Aqui o limiar é
 * declarado e a justificativa acompanha o rótulo, para que o usuário possa
 * discordar do critério em vez de ter de confiar nele.
 */
function assessRisk(input: {
  direct: number;
  indirect: number;
  files: number;
  tests: number;
  exported: boolean;
}): { risk: RiskLevel; riskRationale: string } {
  const reach = input.direct + input.indirect;

  if (reach === 0) {
    return {
      risk: 'LOW',
      riskRationale: 'nenhum chamador encontrado no índice',
    };
  }

  if (reach > 20 || input.files > 10) {
    return {
      risk: 'HIGH',
      riskRationale: `${reach} chamadores em ${input.files} arquivos`,
    };
  }

  if (reach > 5 || input.files > 3 || (input.exported && input.tests === 0)) {
    const semTeste = input.exported && input.tests === 0;
    return {
      risk: 'MEDIUM',
      riskRationale: semTeste
        ? `${reach} chamadores e nenhum teste cobrindo símbolo exportado`
        : `${reach} chamadores em ${input.files} arquivos`,
    };
  }

  return {
    risk: 'LOW',
    riskRationale: `${reach} chamador(es), ${input.tests} teste(s) cobrindo`,
  };
}
