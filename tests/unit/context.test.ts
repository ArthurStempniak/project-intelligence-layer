import { describe, expect, it } from 'vitest';

import { extractLiteralTerms } from '../../src/core/text.js';
import { buildLexicon, expandTerms, SUGGESTED_GROUPS } from '../../src/core/lexicon.js';
import { recencyScore, mostRecentFiles, EMPTY_RECENCY, type RecencyIndex } from '../../src/core/git.js';
import { affinityFor, analyzeTask, classifyTask, extractSymbols } from '../../src/context/task.js';
import { weightedScore } from '../../src/context/relevance.js';
import { DEFAULT_WEIGHTS, type RelevanceSignals } from '../../src/core/types/index.js';

describe('extractLiteralTerms', () => {
  it('captura texto JSX visível ao usuário', () => {
    const source = '<section><h2>Depoimentos de clientes</h2></section>';
    const terms = extractLiteralTerms(source) ?? '';
    expect(terms).toContain('depoimentos');
    expect(terms).toContain('clientes');
  });

  it('ignora className, que domina o volume de string num componente React', () => {
    // O bug que motivou isto: o orçamento de literais se esgotava em nomes de
    // classe Tailwind antes de alcançar qualquer texto visível.
    const source = '<div className="flex items-center justify-between gap-4"><p>Cobrança mensal</p></div>';
    const terms = extractLiteralTerms(source) ?? '';

    expect(terms).toContain('cobrança');
    expect(terms).not.toContain('items');
    expect(terms).not.toContain('justify');
  });

  it('descarta vocabulário de framework e utilitário de CSS', () => {
    const terms = extractLiteralTerms("'use client'; import x from 'react';") ?? '';
    expect(terms).not.toContain('react');
    expect(terms).not.toContain('client');
  });

  it('respeita o orçamento em arquivo com muito texto', () => {
    const source = `<p>${'palavra'.repeat(1) } ${Array.from({ length: 400 }, (_, i) => `termo${i}`).join(' ')}</p>`;
    const terms = extractLiteralTerms(source) ?? '';
    expect(terms.length).toBeLessThan(900);
  });

  it('devolve undefined quando não há literal nenhum', () => {
    expect(extractLiteralTerms('const a = 1 + 2;')).toBeUndefined();
  });
});

describe('léxico de domínio', () => {
  it('é vazio por padrão — expansão ampla piorou o contexto na medição', () => {
    const lexicon = buildLexicon();
    expect(expandTerms(['assinatura'], lexicon)).toEqual(['assinatura']);
  });

  it('expande nos dois sentidos quando o projeto declara o grupo', () => {
    const lexicon = buildLexicon([['ocorrencia', 'ticket', 'chamado']]);

    expect(expandTerms(['ticket'], lexicon).sort()).toEqual(['chamado', 'ocorrencia', 'ticket']);
    expect(expandTerms(['ocorrencia'], lexicon)).toContain('ticket');
  });

  it('mantém os grupos sugeridos disponíveis para copiar', () => {
    expect(SUGGESTED_GROUPS.length).toBeGreaterThan(10);
    expect(SUGGESTED_GROUPS.some((group) => group.includes('comissao'))).toBe(true);
  });
});

describe('recência do git', () => {
  const index: RecencyIndex = {
    lastTouched: new Map([
      ['src/hoje.ts', 1_000_000],
      ['src/mes-passado.ts', 1_000_000 - 30 * 86_400],
      ['src/antigo.ts', 1_000_000 - 365 * 86_400],
    ]),
    newest: 1_000_000,
    available: true,
  };

  it('dá 1 ao arquivo mais recente e decai com a idade', () => {
    expect(recencyScore(index, 'src/hoje.ts')).toBeCloseTo(1);
    // Meia-vida de 30 dias.
    expect(recencyScore(index, 'src/mes-passado.ts')).toBeCloseTo(0.5, 2);
    expect(recencyScore(index, 'src/antigo.ts')).toBeLessThan(0.01);
  });

  it('dá 0 para arquivo fora do histórico e para projeto sem git', () => {
    expect(recencyScore(index, 'src/desconhecido.ts')).toBe(0);
    expect(recencyScore(EMPTY_RECENCY, 'src/hoje.ts')).toBe(0);
  });

  it('lista os mais recentes em ordem', () => {
    expect(mostRecentFiles(index, 2)).toEqual(['src/hoje.ts', 'src/mes-passado.ts']);
  });
});

describe('interpretação da tarefa', () => {
  it('classifica a intenção em português e inglês', () => {
    expect(classifyTask('corrigir o cálculo de comissão')).toBe('BUG_FIX');
    expect(classifyTask('fix the broken login')).toBe('BUG_FIX');
    expect(classifyTask('adicionar desconto progressivo')).toBe('FEATURE');
    expect(classifyTask('escrever testes para o serviço')).toBe('TEST');
    expect(classifyTask('como funciona o login?')).toBe('EXPLAIN');
    expect(classifyTask('blargh')).toBe('UNKNOWN');
  });

  it('extrai identificador citado, inclusive PascalCase de uma palavra', () => {
    // O caso encontrado rodando `pil context` no próprio PIL: `Resolver` não era
    // detectado porque a regra exigia transição de caixa interna.
    expect(extractSymbols('corrigir imports no Resolver')).toContain('Resolver');
    expect(extractSymbols('ajustar calculateCommission')).toContain('calculateCommission');
    expect(extractSymbols('mexer em client_repository')).toContain('client_repository');
  });

  it('lê identificador entre crases', () => {
    expect(extractSymbols('mexer em `ClientService.create`')).toContain('ClientService.create');
  });

  it('extrai caminhos de arquivo citados', () => {
    expect(analyzeTask('corrigir src/services/client.ts').paths).toEqual(['src/services/client.ts']);
  });

  it('pesa tipo de entidade conforme o tipo da tarefa', () => {
    // Numa tarefa de teste, arquivo de teste sobe; num bug fix ele é secundário.
    expect(affinityFor('TEST', 'TEST')).toBeGreaterThan(affinityFor('BUG_FIX', 'TEST'));
    expect(affinityFor('BUG_FIX', 'FUNCTION')).toBeGreaterThan(affinityFor('BUG_FIX', 'FILE'));
  });
});

describe('weightedScore', () => {
  const zero: RelevanceSignals = {
    semantic: 0,
    lexical: 0,
    symbolMatch: 0,
    graphProximity: 0,
    callRelationship: 0,
    fileImportance: 0,
    taskType: 0,
    recentChanges: 0,
    testRelationship: 0,
  };

  it('produz 0 e 100 nos extremos', () => {
    expect(weightedScore(zero, DEFAULT_WEIGHTS)).toBe(0);

    const todos: RelevanceSignals = {
      semantic: 1,
      lexical: 1,
      symbolMatch: 1,
      graphProximity: 1,
      callRelationship: 1,
      fileImportance: 1,
      taskType: 1,
      recentChanges: 1,
      testRelationship: 1,
    };
    expect(weightedScore(todos, DEFAULT_WEIGHTS)).toBeCloseTo(100);
  });

  it('renormaliza pelos pesos ativos, não pela soma nominal', () => {
    // O ponto da renormalização: ligar `semantic` na Fase 2 não pode mudar o
    // score de quem já pontuava, senão um corte por limiar absoluto passaria a
    // se comportar de outro jeito sem que o ranking tivesse melhorado.
    const semLexical = { ...DEFAULT_WEIGHTS, lexical: 0 };
    const soSymbol: RelevanceSignals = { ...zero, symbolMatch: 1 };

    const comTodos = weightedScore(soSymbol, DEFAULT_WEIGHTS);
    const comMenos = weightedScore(soSymbol, semLexical);

    // Desligar um sinal irrelevante para este candidato aumenta seu score
    // relativo — e o resultado continua dentro da escala.
    expect(comMenos).toBeGreaterThan(comTodos);
    expect(comMenos).toBeLessThanOrEqual(100);
  });

  it('ignora sinal com peso zero em vez de deprimir a escala', () => {
    const soSemantic: RelevanceSignals = { ...zero, semantic: 1 };
    // `semantic` tem peso 0 no MVP: um candidato que só pontua nele fica em 0.
    expect(weightedScore(soSemantic, DEFAULT_WEIGHTS)).toBe(0);
  });
});

describe('afinidade base por tipo de entidade', () => {
  it('penaliza variável mesmo quando a tarefa não foi classificada', () => {
    // O bug: a tabela de UNKNOWN é vazia, então tudo caía num neutro único de
    // 0,5 e variável de módulo competia de igual para igual com função. No
    // resultado real, variáveis locais de controladores sem relação com a
    // tarefa ficavam no topo do ranking.
    expect(affinityFor('UNKNOWN', 'FUNCTION')).toBeGreaterThan(
      affinityFor('UNKNOWN', 'VARIABLE'),
    );
    expect(affinityFor('UNKNOWN', 'METHOD')).toBeGreaterThan(affinityFor('UNKNOWN', 'FILE'));
  });

  it('a tabela específica da tarefa tem precedência sobre a base', () => {
    expect(affinityFor('TEST', 'TEST')).toBeGreaterThan(affinityFor('UNKNOWN', 'TEST'));
  });
});

describe('intenção vs assunto', () => {
  it('classifica pedido de validação como busca por defeito', () => {
    expect(classifyTask('Validar se todos os valores estão corretos')).toBe('BUG_FIX');
    expect(classifyTask('verificar o cálculo da comissão')).toBe('BUG_FIX');
    expect(classifyTask('revisar a tela de indicação')).toBe('BUG_FIX');
  });

  it('não trata verbo capitalizado como símbolo citado', () => {
    /*
     * "Validar se os valores..." começa a frase com maiúscula, e a regra de
     * PascalCase de uma palavra aceitava `Validar` como identificador. Isso dava
     * casamento de símbolo perfeito com um `FUNCTION:validar` de arquivo sem
     * relação, no topo do ranking com score 67.
     */
    expect(extractSymbols('Validar se todos os valores estão corretos')).toEqual([]);
    expect(extractSymbols('Corrigir o cálculo')).toEqual([]);

    // Um identificador de verdade continua sendo detectado.
    expect(extractSymbols('Corrigir o Resolver')).toContain('Resolver');
  });
});
