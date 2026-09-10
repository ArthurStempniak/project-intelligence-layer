import { describe, expect, it } from 'vitest';

import {
  buildSearchTerms,
  identifierTerms,
  pathSearchTerms,
  splitIdentifier,
  stripDiacritics,
  toFtsQuery,
} from '../../src/core/text.js';

describe('splitIdentifier', () => {
  it('quebra camelCase e PascalCase', () => {
    expect(splitIdentifier('createClient')).toEqual(['create', 'Client']);
    expect(splitIdentifier('ClientService')).toEqual(['Client', 'Service']);
  });

  it('quebra snake_case e kebab-case', () => {
    expect(splitIdentifier('commission_repository')).toEqual(['commission', 'repository']);
    expect(splitIdentifier('monthly-report')).toEqual(['monthly', 'report']);
  });

  it('separa sigla grudada na palavra seguinte, nao a cada maiuscula', () => {
    // O caso que um split ingenuo por mudanca de caixa erra: 'HTTPSConnection'
    // viraria ['H','T','T','P','S','Connection'].
    expect(splitIdentifier('HTTPSConnection')).toEqual(['HTTPS', 'Connection']);
    expect(splitIdentifier('parseJSONResponse')).toEqual(['parse', 'JSON', 'Response']);
  });

  it('lida com digitos e nomes de um termo so', () => {
    expect(splitIdentifier('calculateCommission2')).toEqual(['calculate', 'Commission2']);
    expect(splitIdentifier('client')).toEqual(['client']);
    expect(splitIdentifier('')).toEqual([]);
  });
});

describe('identifierTerms', () => {
  it('preserva o identificador original alem das partes', () => {
    const terms = identifierTerms('createClient');
    expect(terms).toContain('create');
    expect(terms).toContain('client');
    // Sem o original, buscar pelo nome exato dependeria de recompor as partes.
    expect(terms).toContain('createclient');
  });
});

describe('buildSearchTerms', () => {
  it('inclui nomes de parametro vindos da assinatura', () => {
    const terms = buildSearchTerms({
      name: 'createClient',
      qualifiedName: 'ClientService.createClient',
      signature: 'createClient(name: string, cpf: string, planId: number): Client',
    });
    expect(terms).toContain('plan');
    expect(terms).toContain('cpf');
    expect(terms).toContain('service');
  });
});

describe('toFtsQuery', () => {
  it('conecta os termos da tarefa por OR', () => {
    const query = toFtsQuery('calculo comissao');
    expect(query.split(' OR ')).toContain('"calculo"');
    expect(query.split(' OR ')).toContain('"comissao"');
  });

  it('descarta verbo de intenção, que casaria com todo updateX do projeto', () => {
    // A intenção não se perde: `classifyTask` a usa para o sinal `taskType`.
    // Como termo de busca ela só afogaria o termo que identifica o assunto.
    const clauses = toFtsQuery('corrigir o calculo de comissao').split(' OR ');
    expect(clauses).not.toContain('"corrigir"');
    expect(clauses).toContain('"calculo"');

    expect(toFtsQuery('update testimonial names').split(' OR ')).not.toContain('"update"');
  });

  it('adiciona busca por prefixo em termos longos, para cognatos PT/EN', () => {
    // integration/integracao, validation/validacao: vocabulario tecnico das
    // duas linguas compartilha raiz latina, e o prefixo casa os dois sem
    // precisar de dicionario.
    const clauses = toFtsQuery('integration').split(' OR ');
    expect(clauses).toContain('"integration"');
    expect(clauses).toContain('"integr"*');

    // Termo curto nao ganha prefixo: discriminaria pouco e traria ruido.
    expect(toFtsQuery('login')).toBe('"login"');
  });

  it('expande identificadores citados na tarefa', () => {
    const query = toFtsQuery('corrigir calculateCommission');
    expect(query).toContain('"calculate"');
    expect(query).toContain('"commission"');
    expect(query).toContain('"calculatecommission"');
  });

  it('neutraliza sintaxe FTS presente no texto do usuario', () => {
    // Sem escapar, aspas/asterisco/NOT sao lidos como operadores e o FTS5
    // lanca erro de parse em cima do texto do proprio usuario.
    const query = toFtsQuery('corrigir "login" NOT admin*');
    expect(query).not.toContain('NOT ');
    expect(query.startsWith('"')).toBe(true);
    // Toda cláusula é um termo entre aspas, no máximo com o `*` de prefixo que
    // o próprio PIL acrescenta — nunca sintaxe vinda do texto do usuário.
    for (const token of query.split(' OR ')) {
      expect(token).toMatch(/^"[^"]*"\*?$/);
    }
  });

  it('devolve string vazia quando nao sobra termo util', () => {
    expect(toFtsQuery('a e o')).toBe('');
    expect(toFtsQuery('   ')).toBe('');
  });
});

describe('limite conhecido: barreira de idioma', () => {
  // Estes testes documentam uma deficiencia, nao um comportamento desejado.
  // Quando o dicionario de dominio ou os embeddings forem implementados, eles
  // vao falhar — e devem ser reescritos deliberadamente, nao removidos. Ver
  // ARCHITECTURE.md secao 10.

  it('resolve a barreira de forma: palavras separadas casam com identificador colado', () => {
    const query = toFtsQuery('fix commission calculation');
    // O termo indexado de `calculateCommission` inclui 'commission'.
    expect(query).toContain('"commission"');
  });

  it('NAO resolve a barreira de idioma: portugues nao alcanca identificador em ingles', () => {
    const query = toFtsQuery('corrigir o calculo de comissao');
    // 'comissao' e 'commission' sao termos distintos para o FTS; nenhum stemmer
    // ou remocao de acento aproxima os dois.
    expect(query).not.toContain('"commission"');
    expect(query).toContain('"comissao"');
  });
});

describe('acentuação', () => {
  // O defeito mais grave que apareceu no uso real: `\w` em JavaScript é
  // [A-Za-z0-9_], então a quebra por não-palavra cortava a palavra no primeiro
  // acento. Escrever a tarefa com a acentuação correta dava resultado PIOR que
  // escrever errado.
  it('normaliza acento em vez de quebrar a palavra nele', () => {
    expect(stripDiacritics('indicação')).toBe('indicacao');
    expect(stripDiacritics('conexão')).toBe('conexao');
    expect(stripDiacritics('validação de função')).toBe('validacao de funcao');
    expect(stripDiacritics('ASCII intacto')).toBe('ASCII intacto');
  });

  it('a consulta com acento produz o mesmo termo que a sem acento', () => {
    const comAcento = toFtsQuery('tela de indicação').split(' OR ').sort();
    const semAcento = toFtsQuery('tela de indicacao').split(' OR ').sort();
    expect(comAcento).toEqual(semAcento);
    expect(comAcento).toContain('"indicacao"');
    expect(comAcento).toContain('"indica"*');
  });

  it('descarta preposição e quantificador, que casam com meio projeto', () => {
    const clauses = toFtsQuery('validar se todos os valores da tela estao corretos');
    for (const ruido of ['"de"', '"da"', '"os"', '"todos"', '"estao"', '"corretos"']) {
      expect(clauses.split(' OR ')).not.toContain(ruido);
    }
    expect(clauses.split(' OR ')).toContain('"valores"');
  });
});

describe('pathSearchTerms', () => {
  it('inclui o prefixo, para singular casar com plural no caminho', () => {
    // A busca pelo singular não casa com o plural no caminho: divergem no fim.
    const formas = pathSearchTerms(['indicação']);
    expect(formas).toContain('indicacao');
    expect(formas).toContain('indica');
  });

  it('descarta termo curto, que casaria com metade do projeto', () => {
    expect(pathSearchTerms(['js', 'crm', 'api'])).toEqual([]);
  });
});
