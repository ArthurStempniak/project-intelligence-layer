import { beforeEach, describe, expect, it } from 'vitest';

import type { CodeEntity, CodeRelation, FileRecord } from '../../src/core/types/index.js';
import { confidenceForTier } from '../../src/core/types/index.js';
import { makeEntityId } from '../../src/core/ids.js';
import { toFtsQuery } from '../../src/core/text.js';
import { SqliteStorage } from '../../src/storage/sqlite/sqlite-storage.js';

function file(path: string, hash = 'h1'): FileRecord {
  return {
    path,
    language: 'typescript',
    sizeBytes: 100,
    lineCount: 10,
    contentHash: hash,
    parseState: 'OK',
    indexedAt: 1,
    mtimeMs: 1,
    tokenEstimate: 25,
  };
}

function fn(path: string, name: string, extra: Partial<CodeEntity> = {}): CodeEntity {
  return {
    id: makeEntityId({ filePath: path, type: 'FUNCTION', qualifiedName: name }),
    type: 'FUNCTION',
    name,
    qualifiedName: name,
    language: 'typescript',
    filePath: path,
    startLine: 1,
    endLine: 5,
    startByte: 0,
    endByte: 50,
    exported: true,
    fingerprint: `fp-${name}`,
    tokenEstimate: 20,
    ...extra,
  };
}

function calls(from: CodeEntity, to: CodeEntity): CodeRelation {
  return {
    sourceId: from.id,
    targetId: to.id,
    targetHint: to.qualifiedName,
    type: 'CALLS',
    resolution: 'EXACT',
    confidence: confidenceForTier('EXACT'),
    filePath: from.filePath,
    line: 3,
  };
}

let storage: SqliteStorage;

beforeEach(async () => {
  storage = new SqliteStorage(':memory:');
  await storage.migrate();
});

describe('round-trip', () => {
  it('preserva a entidade atraves da persistencia', async () => {
    const entity = fn('src/a.ts', 'createClient', {
      signature: 'createClient(name: string): Client',
      documentation: 'Cria um cliente.',
      metadata: { async: true },
    });
    await storage.replaceFileAnalysis(file('src/a.ts'), [entity], []);

    const loaded = await storage.getEntity(entity.id);
    expect(loaded).toEqual(entity);
  });

  it('conta estatisticas do indice', async () => {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, b)]);
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);

    const stats = await storage.stats();
    expect(stats.files).toBe(2);
    expect(stats.entities).toBe(2);
    expect(stats.relations).toBe(1);
    expect(stats.entitiesByType['FUNCTION']).toBe(2);
    expect(stats.totalTokens).toBe(50);
  });
});

describe('indexacao incremental', () => {
  it('classifica adicionados, modificados, removidos e inalterados', async () => {
    await storage.replaceFileAnalysis(file('src/a.ts', 'h1'), [], []);
    await storage.replaceFileAnalysis(file('src/b.ts', 'h2'), [], []);

    const changes = await storage.computeChangeSet([
      { path: 'src/a.ts', contentHash: 'h1', mtimeMs: 999, sizeBytes: 100 },
      { path: 'src/b.ts', contentHash: 'DIFERENTE', mtimeMs: 1, sizeBytes: 100 },
      { path: 'src/c.ts', contentHash: 'h3', mtimeMs: 1, sizeBytes: 100 },
    ]);

    expect(changes.added).toEqual(['src/c.ts']);
    expect(changes.modified).toEqual(['src/b.ts']);
    expect(changes.deleted).toEqual([]);
    expect(changes.unchangedCount).toBe(1);
  });

  it('trata mtime novo com hash igual como inalterado', async () => {
    // git checkout reescreve mtimes sem mudar conteudo. Se mtime decidisse,
    // todo checkout viraria reindexacao completa.
    await storage.replaceFileAnalysis(file('src/a.ts', 'h1'), [], []);
    const changes = await storage.computeChangeSet([
      { path: 'src/a.ts', contentHash: 'h1', mtimeMs: 999_999, sizeBytes: 100 },
    ]);
    expect(changes.modified).toEqual([]);
    expect(changes.unchangedCount).toBe(1);
  });

  it('reindexar um arquivo substitui suas entidades sem duplicar', async () => {
    await storage.replaceFileAnalysis(file('src/a.ts'), [fn('src/a.ts', 'antiga')], []);
    await storage.replaceFileAnalysis(file('src/a.ts', 'h2'), [fn('src/a.ts', 'nova')], []);

    const entities = await storage.getEntitiesByFile('src/a.ts');
    expect(entities.map((e) => e.name)).toEqual(['nova']);
  });

  it('rebaixa a aresta a UNRESOLVED quando o alvo some, em vez de apaga-la', async () => {
    // Invariante central: apagar a aresta perderia `targetHint` e ela nunca
    // mais voltaria a resolver. O indice degradaria a cada edicao, sem erro.
    const a = fn('src/a.ts', 'chamador');
    const b = fn('src/b.ts', 'alvo');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, b)]);

    await storage.replaceFileAnalysis(file('src/b.ts', 'h2'), [], []);

    const [relation] = await storage.relationsFrom(a.id);
    expect(relation).toBeDefined();
    expect(relation?.targetId).toBeNull();
    expect(relation?.resolution).toBe('UNRESOLVED');
    expect(relation?.targetHint).toBe('alvo');
  });

  it('mantem a pista disponivel para a passada de resolucao', async () => {
    // O storage guarda; quem resolve e o Resolver (ver resolver.test.ts). Esta
    // separacao existe para que a decisao de tier tenha um dono unico — o
    // storage nao tem como saber se houve import explicito ou homonimo.
    const a = fn('src/a.ts', 'chamador');
    const b = fn('src/b.ts', 'alvo');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, b)]);
    await storage.replaceFileAnalysis(file('src/b.ts', 'h2'), [], []);

    const pendentes = await storage.findUnresolvedByHint(['alvo']);
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0]?.sourceId).toBe(a.id);
    // A chave e o que torna a pendencia atualizavel pelo Resolver.
    expect(typeof pendentes[0]?.id).toBe('number');
  });

  it('resolveRelations aplica o resultado de uma resolucao', async () => {
    const a = fn('src/a.ts', 'chamador');
    const b = fn('src/b.ts', 'alvo');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [
      { ...calls(a, b), targetId: null, resolution: 'UNRESOLVED', confidence: 0 },
    ]);

    const [pendente] = await storage.listUnresolved();
    await storage.resolveRelations([
      { relationId: pendente!.id, targetId: b.id, resolution: 'EXACT', confidence: 1 },
    ]);

    const [relation] = await storage.relationsFrom(a.id);
    expect(relation?.targetId).toBe(b.id);
    expect(relation?.resolution).toBe('EXACT');
  });

  it('remove entidades em cascata ao deletar o arquivo', async () => {
    const a = fn('src/a.ts', 'x');
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], []);
    await storage.deleteFile('src/a.ts');

    expect(await storage.getEntity(a.id)).toBeNull();
    expect(await storage.getFile('src/a.ts')).toBeNull();
  });
});

describe('busca lexical', () => {
  it('casa a tarefa em linguagem natural com identificador colado', async () => {
    // O caso de uso principal do Context Engine: a tarefa fala portugues/ingles
    // separado, o codigo usa camelCase.
    const target = fn('src/commission.ts', 'calculateCommission', {
      signature: 'calculateCommission(sales: Sale[]): number',
    });
    const other = fn('src/homepage.ts', 'renderBanner');
    await storage.replaceFileAnalysis(file('src/commission.ts'), [target], []);
    await storage.replaceFileAnalysis(file('src/homepage.ts'), [other], []);

    const hits = await storage.searchLexical(toFtsQuery('corrigir calculate commission'), 10);
    expect(hits[0]?.entityId).toBe(target.id);
  });

  it('retira a entidade do indice de busca ao reindexar o arquivo', async () => {
    const old = fn('src/a.ts', 'funcaoAntiga');
    const novo = fn('src/a.ts', 'funcaoNova');
    await storage.replaceFileAnalysis(file('src/a.ts'), [old], []);

    const antes = await storage.searchLexical(toFtsQuery('funcaoAntiga'), 10);
    expect(antes.map((h) => h.entityId)).toContain(old.id);

    await storage.replaceFileAnalysis(file('src/a.ts', 'h2'), [novo], []);

    // A assercao e sobre a entidade removida, nao sobre a contagem: a consulta
    // liga os termos por OR, entao "funcao" continua casando com `funcaoNova`.
    // Contar resultados testaria a semantica do FTS, nao a limpeza do indice.
    const depois = await storage.searchLexical(toFtsQuery('funcaoAntiga'), 10);
    expect(depois.map((h) => h.entityId)).not.toContain(old.id);
    expect(depois.map((h) => h.entityId)).toContain(novo.id);
  });

  it('nao quebra com pontuacao de linguagem natural', async () => {
    await storage.replaceFileAnalysis(file('src/a.ts'), [fn('src/a.ts', 'login')], []);
    const hits = await storage.searchLexical(toFtsQuery('como funciona o "login"? NOT admin*'), 10);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('travessia do grafo', () => {
  // a -> b -> c, e d -> a
  // Tipo explicito em vez de Record: com noUncheckedIndexedAccess, indexar um
  // Record devolveria `CodeEntity | undefined` em cada uso.
  async function buildChain(): Promise<{
    a: CodeEntity;
    b: CodeEntity;
    c: CodeEntity;
    d: CodeEntity;
  }> {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    const c = fn('src/c.ts', 'c');
    const d = fn('src/d.ts', 'd');
    await storage.replaceFileAnalysis(file('src/c.ts'), [c], []);
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], [calls(b, c)]);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, b)]);
    await storage.replaceFileAnalysis(file('src/d.ts'), [d], [calls(d, a)]);
    return { a, b, c, d };
  }

  it('percorre para frente registrando a distancia', async () => {
    const { a, b, c } = await buildChain();
    const result = await storage.neighbors({ seedIds: [a.id], depth: 2, direction: 'OUT' });
    const byId = new Map(result.map((r) => [r.entityId, r.hopDistance]));

    expect(byId.get(a.id)).toBe(0);
    expect(byId.get(b.id)).toBe(1);
    expect(byId.get(c.id)).toBe(2);
  });

  it('respeita o limite de profundidade', async () => {
    const { a, b, c } = await buildChain();
    const result = await storage.neighbors({ seedIds: [a.id], depth: 1, direction: 'OUT' });
    const ids = result.map((r) => r.entityId);

    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  it('percorre ao contrario para encontrar chamadores (analise de impacto)', async () => {
    const { a, b, d } = await buildChain();
    const result = await storage.neighbors({ seedIds: [b.id], depth: 2, direction: 'IN' });
    const ids = result.map((r) => r.entityId);

    // Quem quebra se `b` mudar: a (direto) e d (indireto).
    expect(ids).toContain(a.id);
    expect(ids).toContain(d.id);
  });

  it('acumula incerteza ao longo do caminho', async () => {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    const c = fn('src/c.ts', 'c');
    const weak = (from: CodeEntity, to: CodeEntity): CodeRelation => ({
      ...calls(from, to),
      resolution: 'SCOPED',
      confidence: 0.5,
    });
    await storage.replaceFileAnalysis(file('src/c.ts'), [c], []);
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], [weak(b, c)]);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [weak(a, b)]);

    const result = await storage.neighbors({ seedIds: [a.id], depth: 2, direction: 'OUT' });
    const toC = result.find((r) => r.entityId === c.id);

    // Dois saltos a 0.5 valem 0.25 — um alcance de dois palpites nao pode
    // pesar o mesmo que uma aresta provada.
    expect(toC?.pathConfidence).toBeCloseTo(0.25);
  });

  it('descarta arestas abaixo da confianca minima', async () => {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [
      { ...calls(a, b), resolution: 'AMBIGUOUS', confidence: 0.2 },
    ]);

    const strict = await storage.neighbors({
      seedIds: [a.id],
      depth: 2,
      direction: 'OUT',
      minConfidence: 0.5,
    });
    expect(strict.map((r) => r.entityId)).not.toContain(b.id);
  });

  it('termina em grafo ciclico', async () => {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], [calls(b, a)]);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, b)]);

    const result = await storage.neighbors({ seedIds: [a.id], depth: 5, direction: 'OUT' });
    expect(result.map((r) => r.entityId).sort()).toEqual([a.id, b.id].sort());
  });

  it('filtra por tipo de aresta', async () => {
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [
      { ...calls(a, b), type: 'IMPORTS' },
    ]);

    const onlyCalls = await storage.neighbors({
      seedIds: [a.id],
      depth: 2,
      direction: 'OUT',
      types: ['CALLS'],
    });
    expect(onlyCalls.map((r) => r.entityId)).not.toContain(b.id);

    const onlyImports = await storage.neighbors({
      seedIds: [a.id],
      depth: 2,
      direction: 'OUT',
      types: ['IMPORTS'],
    });
    expect(onlyImports.map((r) => r.entityId)).toContain(b.id);
  });
});

describe('inDegrees', () => {
  it('conta quantas arestas apontam para cada entidade', async () => {
    const alvo = fn('src/alvo.ts', 'alvo');
    const a = fn('src/a.ts', 'a');
    const b = fn('src/b.ts', 'b');
    await storage.replaceFileAnalysis(file('src/alvo.ts'), [alvo], []);
    await storage.replaceFileAnalysis(file('src/a.ts'), [a], [calls(a, alvo)]);
    await storage.replaceFileAnalysis(file('src/b.ts'), [b], [calls(b, alvo)]);

    const degrees = await storage.inDegrees([alvo.id, a.id]);
    expect(degrees.get(alvo.id)).toBe(2);
    expect(degrees.get(a.id)).toBe(0);
  });
});
