import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type PilConfig } from '../../src/core/config/schema.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { SqliteStorage } from '../../src/storage/sqlite/sqlite-storage.js';

let root: string;
let storage: SqliteStorage;
let config: PilConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pil-idx-'));
  storage = new SqliteStorage(':memory:');
  await storage.migrate();
  config = { ...defaultConfig('fixture'), project: { name: 'fixture', root } };
});

afterEach(async () => {
  await storage.close();
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

const index = (rebuild = false) => new Indexer(storage, config).run({ rebuild });

/** Projeto mínimo com uma cadeia controller → service → repository. */
async function writeProject(): Promise<void> {
  await write(
    'src/repository.ts',
    `export function findSalesBySeller(sellerId: number) {
  return db.query(sellerId);
}`,
  );
  await write(
    'src/service.ts',
    `import { findSalesBySeller } from './repository.js';

export function calculateCommission(sellerId: number) {
  const sales = findSalesBySeller(sellerId);
  return sales.length * 0.15;
}`,
  );
  await write(
    'src/controller.ts',
    `import { calculateCommission } from './service.js';

export function handleCommission(sellerId: number) {
  return calculateCommission(sellerId);
}`,
  );
}

describe('indexação completa', () => {
  it('indexa arquivos, entidades e relações', async () => {
    await writeProject();
    const report = await index();

    expect(report.changes.added).toHaveLength(3);
    expect(report.parseErrors).toBe(0);

    const stats = await storage.stats();
    expect(stats.files).toBe(3);
    expect(stats.entitiesByType['FUNCTION']).toBe(3);
  });

  it('resolve import relativo mesmo com extensão .js apontando para .ts', async () => {
    // Em ESM+TypeScript o import declara a extensão de saída. Sem essa troca,
    // praticamente todo import de projeto TS moderno ficaria pendente.
    await writeProject();
    await index();

    const service = await storage.getEntity('src/service.ts#FILE:src/service.ts');
    const imports = (await storage.relationsFrom(service!.id)).filter((r) => r.type === 'IMPORTS');

    expect(imports[0]?.targetId).toBe('src/repository.ts#FILE:src/repository.ts');
    expect(imports[0]?.resolution).toBe('EXACT');
  });

  it('resolve chamada com import explícito como EXACT', async () => {
    await writeProject();
    await index();

    const caller = 'src/service.ts#FUNCTION:calculateCommission';
    const call = (await storage.relationsFrom(caller)).find(
      (r) => r.type === 'CALLS' && r.targetHint === 'findSalesBySeller',
    );

    expect(call?.resolution).toBe('EXACT');
    expect(call?.confidence).toBe(1);
    expect(call?.targetId).toBe('src/repository.ts#FUNCTION:findSalesBySeller');
  });

  it('rebaixa a confiança quando há homônimos', async () => {
    await write('src/a.ts', 'export function save() { return 1; }');
    await write('src/b.ts', 'export function save() { return 2; }');
    await write('src/c.ts', 'export function usa() { return save(); }');
    await index();

    const call = (await storage.relationsFrom('src/c.ts#FUNCTION:usa')).find(
      (r) => r.type === 'CALLS',
    );

    // Dois candidatos sem prova de binding: confiança 1/2, e o tier declara
    // que a escolha foi um chute.
    expect(call?.resolution).toBe('AMBIGUOUS');
    expect(call?.confidence).toBeCloseTo(0.5);
  });

  it('marca SCOPED quando há candidato único sem import', async () => {
    await write('src/unico.ts', 'export function soUmDesses() { return 1; }');
    await write('src/usa.ts', 'export function usa() { return soUmDesses(); }');
    await index();

    const call = (await storage.relationsFrom('src/usa.ts#FUNCTION:usa')).find(
      (r) => r.type === 'CALLS',
    );
    expect(call?.resolution).toBe('SCOPED');
    expect(call?.confidence).toBeCloseTo(0.75);
  });

  it('deixa dependência externa como não resolvida, contada à parte', async () => {
    await write('src/a.ts', "import fs from 'node:fs';\nexport function f() { return fs; }");
    const report = await index();

    // Não é falha: `node:fs` não está no índice, e forçar resolução criaria
    // aresta para qualquer entidade homônima.
    expect(report.resolution.external).toBeGreaterThan(0);
  });

  it('resolve chamada Python entre módulos', async () => {
    await write('src/repo.py', 'def find_sales(seller_id):\n    return []\n');
    await write(
      'src/service.py',
      'from src.repo import find_sales\n\ndef calculate(seller_id):\n    return find_sales(seller_id)\n',
    );
    await index();

    const call = (await storage.relationsFrom('src/service.py#FUNCTION:calculate')).find(
      (r) => r.type === 'CALLS',
    );
    expect(call?.targetId).toBe('src/repo.py#FUNCTION:find_sales');
    expect(call?.resolution).toBe('EXACT');
  });
});

describe('indexação incremental', () => {
  it('reprocessa só o arquivo alterado', async () => {
    await writeProject();
    await index();

    await write('src/service.ts', "import { findSalesBySeller } from './repository.js';\n\nexport function calculateCommission(id: number) {\n  return findSalesBySeller(id).length * 0.20;\n}");
    const second = await index();

    expect(second.changes.modified).toEqual(['src/service.ts']);
    expect(second.changes.unchangedCount).toBe(2);
    expect(second.parsed).toBe(1);
  });

  it('não reprocessa nada quando nada mudou', async () => {
    await writeProject();
    await index();
    const second = await index();

    expect(second.parsed).toBe(0);
    expect(second.changes.unchangedCount).toBe(3);
  });

  it('remove do índice arquivo apagado do disco', async () => {
    await writeProject();
    await index();

    await rm(join(root, 'src/controller.ts'));
    const second = await index();

    expect(second.changes.deleted).toEqual(['src/controller.ts']);
    expect(await storage.getFile('src/controller.ts')).toBeNull();
  });

  it('religa a aresta quando o alvo volta a existir', async () => {
    // O invariante completo, ponta a ponta: rebaixar ao sumir (storage) e
    // religar na passada de resolução (resolver), sem reprocessar a origem.
    await writeProject();
    await index();

    const callerId = 'src/service.ts#FUNCTION:calculateCommission';
    const original = await storage.getEntity(callerId);
    expect(original).not.toBeNull();

    await write('src/repository.ts', 'export function outraCoisa() { return 1; }');
    await index();

    let call = (await storage.relationsFrom(callerId)).find((r) => r.targetHint === 'findSalesBySeller');
    expect(call?.targetId).toBeNull();
    expect(call?.resolution).toBe('UNRESOLVED');

    await write('src/repository.ts', 'export function findSalesBySeller(id: number) { return []; }');
    await index();

    call = (await storage.relationsFrom(callerId)).find((r) => r.targetHint === 'findSalesBySeller');
    expect(call?.targetId).toBe('src/repository.ts#FUNCTION:findSalesBySeller');
    expect(call?.resolution).toBe('EXACT');
  });

  it('--rebuild reprocessa tudo', async () => {
    await writeProject();
    await index();
    const rebuilt = await index(true);

    expect(rebuilt.parsed).toBe(3);
  });
});

describe('segurança e cobertura', () => {
  it('registra o .env sem indexar seu conteúdo', async () => {
    await write('.env', 'SECRET=abc123\n');
    await write('src/a.ts', 'export const a = 1;');
    await index();

    const env = await storage.getFile('.env');
    expect(env?.parseState).toBe('SKIPPED_SECRET');
    expect(await storage.getEntitiesByFile('.env')).toEqual([]);
  });

  it('mantém arquivo de linguagem sem extrator no índice, marcado', async () => {
    await write('estilo.css', 'a { color: red; }');
    await index();

    const css = await storage.getFile('estilo.css');
    expect(css?.parseState).toBe('UNSUPPORTED_LANGUAGE');
    expect(css?.tokenEstimate).toBeGreaterThan(0);
  });
});
