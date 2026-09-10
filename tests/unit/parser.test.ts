import { describe, expect, it } from 'vitest';

import { CodeParser } from '../../src/parser/parser.js';
import type { CodeEntity, CodeRelation } from '../../src/core/types/index.js';

const parser = new CodeParser();

async function parse(filePath: string, language: string, source: string) {
  const result = await parser.parse({ filePath, language, source });
  const byName = new Map(result.entities.map((e) => [e.qualifiedName, e]));
  const find = (name: string): CodeEntity | undefined => byName.get(name);
  const relationsOf = (name: string): CodeRelation[] => {
    const id = find(name)?.id;
    return result.relations.filter((r) => r.sourceId === id);
  };
  return { ...result, find, relationsOf, names: [...byName.keys()] };
}

describe('TypeScript — entidades', () => {
  const source = `import { Repo } from './repo.js';

/** Serviço de clientes. */
export class ClientService extends BaseService implements IService {
  async create(name: string): Promise<Client> {
    return this.repo.save(name);
  }
}

export const helper = (a: number) => compute(a);
export interface IService { run(): void; }
export type ClientId = string;
export const TAX_RATE = 0.15;
let mutavel = 1;

function interna() {
  return helper(1);
}`;

  it('extrai cada tipo de declaração com o tipo certo', async () => {
    const r = await parse('src/client.ts', 'typescript', source);

    expect(r.find('ClientService')?.type).toBe('CLASS');
    expect(r.find('ClientService.create')?.type).toBe('METHOD');
    expect(r.find('helper')?.type).toBe('FUNCTION');
    expect(r.find('IService')?.type).toBe('INTERFACE');
    expect(r.find('ClientId')?.type).toBe('TYPE');
    expect(r.find('interna')?.type).toBe('FUNCTION');
  });

  it('separa constante de variável pelo caso do nome', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.find('TAX_RATE')?.type).toBe('CONSTANT');
    expect(r.find('mutavel')?.type).toBe('VARIABLE');
  });

  it('marca o que é exportado', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.find('ClientService')?.exported).toBe(true);
    expect(r.find('interna')?.exported).toBe(false);
  });

  it('sempre emite a entidade FILE como âncora', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    const file = r.entities.find((e) => e.type === 'FILE');
    expect(file?.qualifiedName).toBe('src/client.ts');
    expect(file?.tokenEstimate).toBeGreaterThan(0);
  });

  it('registra a assinatura sem o corpo', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    const signature = r.find('ClientService.create')?.signature ?? '';

    expect(signature).toContain('create(name: string)');
    // O ponto da compressão da spec §15: contrato sem implementação.
    expect(signature).not.toContain('this.repo.save');
  });

  it('associa o comentário imediatamente anterior', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.find('ClientService')?.documentation).toBe('Serviço de clientes.');
  });

  it('usa linhas 1-indexadas', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.find('ClientService')?.startLine).toBe(4);
  });

  it('aninha método dentro da classe via parentId', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.find('ClientService.create')?.parentId).toBe(r.find('ClientService')?.id);
  });

  it('desambigua homônimos no mesmo arquivo', async () => {
    const r = await parse('src/a.ts', 'typescript', 'function dup() {}\nfunction dup() {}');
    const ids = r.entities.filter((e) => e.name === 'dup').map((e) => e.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toContain('~1');
  });
});

describe('TypeScript — relações', () => {
  const source = `import { Repo } from './repo.js';
import fs from 'node:fs';

export class ClientService extends BaseService implements IService {
  async create(name: string) {
    validateName(name);
    return this.repo.save(name);
  }
}`;

  it('registra imports a partir da entidade FILE', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    const imports = r.relations.filter((rel) => rel.type === 'IMPORTS');

    expect(imports.map((i) => i.targetHint).sort()).toEqual(['./repo.js', 'node:fs']);
  });

  it('registra extends e implements', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    const fromClass = r.relationsOf('ClientService');

    expect(fromClass.find((rel) => rel.type === 'EXTENDS')?.targetHint).toBe('BaseService');
    expect(fromClass.find((rel) => rel.type === 'IMPLEMENTS')?.targetHint).toBe('IService');
  });

  it('atribui a chamada ao método que a contém, não à classe', async () => {
    // Se a origem fosse a classe, a análise de impacto perderia a resolução de
    // método e apontaria a classe inteira como afetada.
    const r = await parse('src/client.ts', 'typescript', source);
    const calls = r.relationsOf('ClientService.create').filter((rel) => rel.type === 'CALLS');

    expect(calls.map((c) => c.targetHint).sort()).toEqual(['save', 'validateName']);
    expect(r.relationsOf('ClientService').some((rel) => rel.type === 'CALLS')).toBe(false);
  });

  it('guarda a expressão completa da chamada encadeada', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    const save = r.relationsOf('ClientService.create').find((c) => c.targetHint === 'save');

    // `save` é o que tem chance de casar; a expressão fica para a inferência
    // de tipo promover a relação depois.
    expect(save?.metadata?.['expression']).toBe('this.repo.save');
  });

  it('nasce tudo UNRESOLVED — resolver é trabalho de outra etapa', async () => {
    const r = await parse('src/client.ts', 'typescript', source);
    expect(r.relations.every((rel) => rel.resolution === 'UNRESOLVED')).toBe(true);
    expect(r.relations.every((rel) => rel.targetId === null)).toBe(true);
  });

  it('registra construção via new como chamada', async () => {
    const r = await parse('src/a.ts', 'typescript', 'function f() { return new ClientService(); }');
    const calls = r.relationsOf('f').filter((rel) => rel.type === 'CALLS');
    expect(calls.map((c) => c.targetHint)).toContain('ClientService');
  });
});

describe('TSX — componentes', () => {
  it('classifica função PascalCase como COMPONENT', async () => {
    const source = 'export function ClientCard() { return <div />; }\nfunction util() { return 1; }';
    const r = await parse('src/Card.tsx', 'tsx', source);

    expect(r.find('ClientCard')?.type).toBe('COMPONENT');
    expect(r.find('util')?.type).toBe('FUNCTION');
  });

  it('não aplica a heurística fora de TSX', async () => {
    const r = await parse('src/a.ts', 'typescript', 'export function ClientCard() { return 1; }');
    expect(r.find('ClientCard')?.type).toBe('FUNCTION');
  });
});

describe('Python', () => {
  const source = `import os
from .repo import Repo

RATE = 0.15

class ClientService(Base):
    """Serviço de clientes."""

    def create(self, name):
        return self.repo.save(name)

    def _interno(self):
        pass

@app.route("/clients")
def handle_clients():
    return compute(1)
`;

  it('extrai classes, métodos e funções', async () => {
    const r = await parse('src/service.py', 'python', source);

    expect(r.find('ClientService')?.type).toBe('CLASS');
    expect(r.find('ClientService.create')?.type).toBe('METHOD');
    expect(r.find('handle_clients')?.type).toBe('FUNCTION');
    expect(r.find('RATE')?.type).toBe('CONSTANT');
  });

  it('lê a docstring como documentação', async () => {
    const r = await parse('src/service.py', 'python', source);
    expect(r.find('ClientService')?.documentation).toBe('Serviço de clientes.');
  });

  it('traduz a convenção de underscore para visibilidade', async () => {
    const r = await parse('src/service.py', 'python', source);
    expect(r.find('ClientService.create')?.exported).toBe(true);
    expect(r.find('ClientService._interno')?.exported).toBe(false);
  });

  it('indexa função decorada — senão todo endpoint sumiria', async () => {
    const r = await parse('src/service.py', 'python', source);
    expect(r.find('handle_clients')).toBeDefined();
    expect(r.relationsOf('handle_clients').map((rel) => rel.targetHint)).toContain('compute');
  });

  it('registra imports e herança', async () => {
    const r = await parse('src/service.py', 'python', source);

    const imports = r.relations.filter((rel) => rel.type === 'IMPORTS').map((i) => i.targetHint);
    expect(imports).toContain('os');
    expect(imports).toContain('.repo');

    expect(r.relationsOf('ClientService').find((rel) => rel.type === 'EXTENDS')?.targetHint).toBe('Base');
  });

  it('ignora variável local dentro de função', async () => {
    const r = await parse('src/a.py', 'python', 'def f():\n    local = 1\n    return local\n');
    expect(r.find('f.local')).toBeUndefined();
  });
});

describe('robustez', () => {
  it('extrai o que dá de arquivo com sintaxe inválida', async () => {
    // Arquivo em edição é o caso comum, não a exceção: descartar tudo deixaria
    // o índice cego justamente no arquivo em que o usuário está trabalhando.
    const r = await parse('src/quebrado.ts', 'typescript', 'export function ok() { return 1; }\nfunction quebrada( {');

    expect(r.parseState).toBe('PARSE_ERROR');
    expect(r.find('ok')).toBeDefined();
  });

  it('reporta linguagem sem extrator sem lançar erro', async () => {
    const r = await parser.parse({ filePath: 'a.css', language: 'css', source: 'a { color: red; }' });
    expect(r.parseState).toBe('UNSUPPORTED_LANGUAGE');
    expect(r.entities).toEqual([]);
  });

  it('lida com arquivo vazio', async () => {
    const r = await parse('src/vazio.ts', 'typescript', '');
    expect(r.parseState).toBe('OK');
    expect(r.entities).toHaveLength(1);
  });
});

describe('CommonJS', () => {
  // Encontrado rodando o PIL num projeto real de 246 arquivos JS: o resultado
  // era ZERO relação IMPORTS e zero resolução EXACT em 29 mil relações, porque
  // o extrator só reconhecia `import ... from`.
  const source = `const repo = require('./repo');
const { save, load: carregar } = require('./db');
require('./efeito-colateral');

function usa() {
  return save(repo);
}`;

  it('trata require como IMPORTS, não como chamada de função', async () => {
    const r = await parse('src/a.js', 'javascript', source);
    const imports = r.relations.filter((rel) => rel.type === 'IMPORTS');

    expect(imports.map((i) => i.targetHint).sort()).toEqual([
      './db',
      './efeito-colateral',
      './repo',
    ]);
    // Sem isto o grafo ganharia arestas CALLS para um alvo `require` que nunca
    // resolve, e nenhuma prova de binding.
    expect(r.relations.some((rel) => rel.targetHint === 'require')).toBe(false);
  });

  it('registra os nomes ligados, inclusive com renomeação', async () => {
    const r = await parse('src/a.js', 'javascript', source);
    const imports = r.relations.filter((rel) => rel.type === 'IMPORTS');

    const repo = imports.find((i) => i.targetHint === './repo');
    expect(repo?.metadata?.['names']).toEqual(['repo']);

    const db = imports.find((i) => i.targetHint === './db');
    // `load: carregar` liga o nome LOCAL, que é o que aparece nas chamadas.
    expect(db?.metadata?.['names']).toEqual(['save', 'carregar']);

    const efeito = imports.find((i) => i.targetHint === './efeito-colateral');
    expect(efeito?.metadata?.['names']).toBeUndefined();
  });

  it('não cria entidade para alias de módulo', async () => {
    // `const axios = require('axios')` é alias, não código que alguém edita.
    // No projeto real, esses aliases ocupavam o topo do ranking de contexto.
    const r = await parse('src/a.js', 'javascript', source);
    expect(r.find('repo')).toBeUndefined();
    expect(r.find('usa')).toBeDefined();
  });
});
