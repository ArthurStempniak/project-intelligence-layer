/**
 * Resolução de alvos das relações (spec §7, ARCHITECTURE.md §4).
 *
 * Os extratores só sabem o que está escrito no arquivo: `save(x)` é um nome.
 * Descobrir *qual* `save` exige o índice do projeto inteiro, e é isso que
 * acontece aqui.
 *
 * A regra que governa o arquivo: **nunca prometer mais confiança do que a
 * evidência sustenta**. Um `pil impact` que aponta 27 funções afetadas com
 * autoridade, sendo 20 delas homônimos sem relação, é pior que um que aponta 7 e
 * admite incerteza no resto — porque o primeiro será acreditado.
 *
 * Tiers produzidos:
 *   EXACT      há import explícito ligando o nome ao módulo que o declara
 *   SCOPED     candidato único no projeto, sem prova de binding
 *   AMBIGUOUS  N homônimos; confiança 1/N, limitada a 0.5
 *   UNRESOLVED nenhum candidato — a pista fica guardada para a próxima passada
 */

import type { CodeEntity, ResolutionTier } from '../core/types/index.js';
import { ambiguousConfidence, confidenceForTier } from '../core/types/index.js';
import { makeFileEntityId } from '../core/ids.js';
import type { Storage, StoredRelation } from '../storage/storage.js';

export interface ResolutionUpdate {
  relationId: number;
  targetId: string;
  resolution: ResolutionTier;
  confidence: number;
}

export interface ResolveReport {
  considered: number;
  exact: number;
  scoped: number;
  ambiguous: number;
  stillUnresolved: number;
  /**
   * Pendencias explicadas: especificador externo, ou simbolo que nao existe
   * no indice (stdlib, biblioteca). Subconjunto de `stillUnresolved`.
   */
  external: number;
}

/** Extensões tentadas ao resolver um import relativo sem extensão explícita. */
const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = TS_EXTENSIONS.map((ext) => `/index${ext}`);

export class Resolver {
  readonly #storage: Storage;
  /** Caminhos indexados, para resolver especificadores de import. */
  #knownPaths: Set<string> = new Set();
  /**
   * Cache nome -> candidatos, valido durante uma passada de resolucao.
   *
   * Sem ele a resolucao faz uma consulta por relacao pendente. Medido num
   * projeto CommonJS de 421 arquivos: 29 mil relacoes, 29 mil consultas, e o
   * scan levou 138s. Nomes de alvo repetem muito (`res`, `next`, `query`,
   * `save`), entao o cache colapsa isso para o numero de nomes *distintos*.
   *
   * Vive por passada, e nao por instancia, porque o indice muda entre scans e
   * um cache persistente devolveria candidatos que ja nao existem.
   */
  readonly #nameCache = new Map<string, CodeEntity[]>();
  /** Mesma informacao de `#knownPaths`, para varredura por sufixo. */
  #knownPathList: string[] = [];
  readonly #sourceCache = new Map<string, CodeEntity | null>();

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /**
   * Resolve todas as arestas pendentes contra o estado atual do índice.
   *
   * Roda ao fim de um scan, e não por arquivo, porque a resolução depende de
   * arquivos que podem ter sido indexados depois: `a.ts` chama algo de `b.ts`,
   * mas nada garante que `b.ts` veio primeiro na varredura. Uma passada global
   * no fim também é o que faz a re-resolução incremental funcionar — uma aresta
   * rebaixada volta a resolver assim que seu alvo reaparece, sem que o arquivo
   * de origem precise ser reprocessado.
   */
  async resolveAll(): Promise<ResolveReport> {
    const pending = await this.#storage.listUnresolved();
    const report: ResolveReport = {
      considered: pending.length,
      exact: 0,
      scoped: 0,
      ambiguous: 0,
      stillUnresolved: 0,
      external: 0,
    };

    if (pending.length === 0) return report;

    this.#nameCache.clear();
    this.#sourceCache.clear();
    this.#knownPaths = new Set((await this.#storage.listFileSignatures()).map((f) => f.path));
    // Lista materializada uma vez: `#resolveDotted` varria o Set inteiro a cada
    // chamada, e com milhares de pendencias isso virava O(pendencias x arquivos).
    this.#knownPathList = [...this.#knownPaths];

    // Mapa de bindings por arquivo, construído uma vez: consultar as arestas de
    // import a cada chamada resolvida seria quadrático no número de relações.
    const bindings = await this.#buildBindings();
    const updates: ResolutionUpdate[] = [];

    for (const relation of pending) {
      const update =
        relation.type === 'IMPORTS'
          ? this.#resolveImport(relation)
          : await this.#resolveSymbol(relation, bindings);

      if (!update) {
        report.stillUnresolved += 1;
        /*
         * "Externo" cobre dois casos, e ambos sao legitimos:
         *
         *   - IMPORTS de especificador nu (`react`, `node:fs`);
         *   - CALLS cuja pista nao existe no indice — `push`, `map`, `then`,
         *     metodos de stdlib e de biblioteca.
         *
         * O segundo caso domina em volume. Contando so o primeiro, o `pil
         * status` reportava metade do grafo como "pendente" e sugeria uma falha
         * de resolucao onde havia apenas codigo chamando a biblioteca padrao.
         */
        report.external += 1;
        continue;
      }

      updates.push(update);
      if (update.resolution === 'EXACT') report.exact += 1;
      else if (update.resolution === 'SCOPED') report.scoped += 1;
      else report.ambiguous += 1;
    }

    await this.#storage.resolveRelations(updates);
    return report;
  }

  /**
   * Nome local → arquivo de onde ele foi importado.
   *
   * É a estrutura que sustenta o tier EXACT: sem ela não há como distinguir
   * "chamou o `save` que este arquivo importou" de "existe algum `save` no
   * projeto".
   */
  async #buildBindings(): Promise<Map<string, Map<string, string>>> {
    const bindings = new Map<string, Map<string, string>>();

    for (const file of await this.#storage.listFileSignatures()) {
      const relations = await this.#storage.relationsInFile(file.path);
      const perFile = new Map<string, string>();

      for (const relation of relations) {
        if (relation.type !== 'IMPORTS') continue;

        const targetPath = this.#resolveSpecifier(relation.targetHint, relation.filePath);
        if (!targetPath) continue;

        const names = relation.metadata?.['names'];
        if (!Array.isArray(names)) continue;

        for (const name of names) {
          if (typeof name === 'string') perFile.set(name, targetPath);
        }
      }

      if (perFile.size > 0) bindings.set(file.path, perFile);
    }

    return bindings;
  }

  #resolveImport(relation: StoredRelation): ResolutionUpdate | null {
    const targetPath = this.#resolveSpecifier(relation.targetHint, relation.filePath);
    if (!targetPath) return null;

    // Import resolvido a um arquivo do projeto é evidência direta, não palpite.
    return {
      relationId: relation.id,
      targetId: makeFileEntityId(targetPath),
      resolution: 'EXACT',
      confidence: confidenceForTier('EXACT'),
    };
  }

  /** Candidatos por nome, memoizados dentro da passada. */
  async #candidatesFor(name: string): Promise<CodeEntity[]> {
    const cached = this.#nameCache.get(name);
    if (cached) return cached;

    const found = await this.#storage.findEntitiesByName(name);
    this.#nameCache.set(name, found);
    return found;
  }

  async #resolveSymbol(
    relation: StoredRelation,
    bindings: Map<string, Map<string, string>>,
  ): Promise<ResolutionUpdate | null> {
    const candidates = await this.#candidatesFor(relation.targetHint);
    if (candidates.length === 0) return null;

    // 1. Binding explícito: o nome foi importado de um arquivo específico.
    const boundPath = bindings.get(relation.filePath)?.get(relation.targetHint);
    if (boundPath) {
      const bound = candidates.find((c) => c.filePath === boundPath);
      if (bound) {
        return {
          relationId: relation.id,
          targetId: bound.id,
          resolution: 'EXACT',
          confidence: confidenceForTier('EXACT'),
        };
      }
    }

    /*
     * Chamada em membro (`obj.metodo()`) precisa de tratamento próprio.
     *
     * O caso que expôs a falha, encontrado rodando `pil impact` sobre o próprio
     * PIL: `this.#db.prepare(...).run(...)` casava por nome com `Indexer.run`,
     * único `run` do índice, e recebia SCOPED/0.75. O relatório passava a
     * listar métodos do SqliteStorage como chamadores do indexador.
     *
     * Mas rebaixar *toda* chamada em membro também está errado: em TS e Python
     * quase toda chamada é em membro, e o grafo inteiro viraria AMBIGUOUS. A
     * distinção que importa é se o **receptor** é conhecido sintaticamente:
     * `this.x()`, `new Classe().x()` e `moduloImportado.x()` são rastreáveis;
     * `qualquerCoisa.x()` não é.
     */
    const expression = relation.metadata?.['expression'];
    const isMemberCall = typeof expression === 'string';

    if (isMemberCall) {
      const byReceiver = await this.#resolveByReceiver(relation, expression, candidates, bindings);
      if (byReceiver) return byReceiver;
    }

    // 2. Declarado no próprio arquivo. Não é binding provado por import, mas o
    //    escopo léxico torna o candidato local muito mais provável que um
    //    homônimo distante — daí SCOPED, e não AMBIGUOUS.
    const local = candidates.filter((c) => c.filePath === relation.filePath);
    if (local.length === 1 && !isMemberCall) {
      return {
        relationId: relation.id,
        targetId: (local[0] as CodeEntity).id,
        resolution: 'SCOPED',
        confidence: confidenceForTier('SCOPED'),
      };
    }

    // 3. Candidato único no projeto inteiro.
    if (candidates.length === 1 && !isMemberCall) {
      return {
        relationId: relation.id,
        targetId: (candidates[0] as CodeEntity).id,
        resolution: 'SCOPED',
        confidence: confidenceForTier('SCOPED'),
      };
    }

    if (isMemberCall) {
      // Prefere o candidato no mesmo arquivo: mesmo sem prova, proximidade
      // léxica é a única pista disponível aqui.
      const preferredLocal = local[0] ?? candidates.find((c) => c.exported) ?? (candidates[0] as CodeEntity);
      return {
        relationId: relation.id,
        targetId: preferredLocal.id,
        resolution: 'AMBIGUOUS',
        confidence: ambiguousConfidence(candidates.length),
      };
    }

    // 4. Homônimos. Escolhe um alvo para que o grafo não fique desconexo, mas a
    //    confiança declara honestamente que isto é um chute entre N.
    const preferred = candidates.find((c) => c.exported) ?? (candidates[0] as CodeEntity);
    return {
      relationId: relation.id,
      targetId: preferred.id,
      resolution: 'AMBIGUOUS',
      confidence: ambiguousConfidence(candidates.length),
    };
  }

  /**
   * Resolve uma chamada em membro quando o receptor é identificável.
   *
   * Três receptores rastreáveis, em ordem de força da evidência:
   *
   *   `this.x()` / `self.x()`  a classe é a que contém a origem da chamada
   *   `new Classe().x()`       o tipo está escrito ali
   *   `importado.x()`          o módulo é conhecido pelo binding do import
   *
   * Devolve `null` quando o receptor não é nenhum desses — aí o chamador cai no
   * tier AMBIGUOUS, que é o teto honesto para um receptor desconhecido.
   */
  async #resolveByReceiver(
    relation: StoredRelation,
    expression: string,
    candidates: readonly CodeEntity[],
    bindings: Map<string, Map<string, string>>,
  ): Promise<ResolutionUpdate | null> {
    const lastDot = expression.lastIndexOf('.');
    if (lastDot <= 0) return null;

    const receiver = expression.slice(0, lastDot);
    const member = relation.targetHint;

    // `this.x()` — a classe do receptor é a que contém a chamada.
    if (receiver === 'this' || receiver === 'self') {
      const source = await this.#sourceEntity(relation.sourceId);
      const enclosingClass = source?.qualifiedName.split('.')[0];
      if (enclosingClass !== undefined && source) {
        const sibling = candidates.find(
          (c) => c.filePath === source.filePath && c.qualifiedName === `${enclosingClass}.${member}`,
        );
        // Provável o suficiente para EXACT: mesma classe, mesmo arquivo. Herança
        // pode mover o alvo para a superclasse, e nesse caso não achamos nada
        // aqui e o fluxo segue para os tiers mais fracos.
        if (sibling) return exact(relation.id, sibling.id);
      }
    }

    // `new Classe().x()` — o tipo do receptor está escrito na própria expressão.
    const constructed = /^new\s+([A-Za-z_$][\w$]*)/.exec(receiver);
    if (constructed) {
      const target = candidates.find((c) => c.qualifiedName === `${constructed[1]}.${member}`);
      if (target) return exact(relation.id, target.id);
    }

    // `importado.x()` — o módulo é conhecido; o membro dentro dele, não.
    const base = receiver.split('.')[0];
    if (base !== undefined) {
      const boundPath = bindings.get(relation.filePath)?.get(base);
      if (boundPath) {
        const target = candidates.find((c) => c.filePath === boundPath);
        if (target) {
          return {
            relationId: relation.id,
            targetId: target.id,
            resolution: 'SCOPED',
            confidence: confidenceForTier('SCOPED'),
          };
        }
      }
    }

    return null;
  }

  /** Entidade de origem, memoizada: varias chamadas partem do mesmo metodo. */
  async #sourceEntity(id: string): Promise<CodeEntity | null> {
    if (this.#sourceCache.has(id)) return this.#sourceCache.get(id) ?? null;

    const entity = await this.#storage.getEntity(id);
    this.#sourceCache.set(id, entity);
    return entity;
  }

  /**
   * Especificador de módulo → caminho de arquivo indexado.
   *
   * Só resolve caminhos relativos. Especificadores nus (`react`, `os`,
   * `node:fs`) são dependências externas: não estão no índice, e forçar uma
   * resolução criaria arestas para entidades que por acaso tenham o mesmo nome.
   * Ficam UNRESOLVED de propósito — e contadas como `external` no relatório,
   * para não parecerem falha.
   */
  #resolveSpecifier(specifier: string, fromFile: string): string | null {
    if (specifier.startsWith('.')) return this.#resolveRelative(specifier, fromFile);
    // Python: `.repo` já é relativo; `pacote.modulo` pode ser interno.
    if (specifier.includes('.') && !specifier.includes('/')) {
      return this.#resolveDotted(specifier);
    }
    return null;
  }

  #resolveRelative(specifier: string, fromFile: string): string | null {
    const fromDir = fromFile.slice(0, fromFile.lastIndexOf('/'));
    const base = normalizePath(`${fromDir}/${specifier}`);
    if (base === null) return null;

    if (this.#knownPaths.has(base)) return base;

    /*
     * `./repo.js` costuma apontar para `repo.ts` no fonte: em ESM+TypeScript o
     * import declara a extensão de saída, não a do arquivo que existe em disco.
     * Sem esta troca, praticamente todo import de um projeto TS moderno ficaria
     * sem resolver.
     */
    const withoutExtension = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    for (const candidate of [
      base,
      withoutExtension,
      ...TS_EXTENSIONS.map((ext) => `${withoutExtension}${ext}`),
      ...INDEX_FILES.map((suffix) => `${withoutExtension}${suffix}`),
    ]) {
      if (this.#knownPaths.has(candidate)) return candidate;
    }

    return null;
  }

  /** `pacote.modulo` (Python) → `pacote/modulo.py`. */
  #resolveDotted(specifier: string): string | null {
    const asPath = specifier.replace(/^\.+/, '').split('.').join('/');
    for (const candidate of [`${asPath}.py`, `${asPath}/__init__.py`]) {
      if (this.#knownPaths.has(candidate)) return candidate;
      const match = this.#knownPathList.find((path) => path.endsWith(`/${candidate}`));
      if (match) return match;
    }
    return null;
  }
}

/** Normaliza `.` e `..` sem tocar no sistema de arquivos. */
function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Subir acima da raiz do projeto significa sair do índice.
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Atalho para o tier EXACT, usado onde a evidência é sintática. */
function exact(relationId: number, targetId: string): ResolutionUpdate {
  return {
    relationId,
    targetId,
    resolution: 'EXACT',
    confidence: confidenceForTier('EXACT'),
  };
}
