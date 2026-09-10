import { describe, expect, it } from 'vitest';

import {
  makeEntityId,
  makeFingerprint,
  parseEntityId,
  qualifyName,
  toPosixPath,
} from '../../src/core/ids.js';

describe('makeEntityId / parseEntityId', () => {
  it('faz round-trip do caso comum', () => {
    const id = makeEntityId({
      filePath: 'src/services/client.ts',
      type: 'FUNCTION',
      qualifiedName: 'createClient',
    });
    expect(id).toBe('src/services/client.ts#FUNCTION:createClient');
    expect(parseEntityId(id)).toEqual({
      filePath: 'src/services/client.ts',
      type: 'FUNCTION',
      qualifiedName: 'createClient',
    });
  });

  it('faz round-trip com ordinal de desempate', () => {
    const id = makeEntityId({
      filePath: 'src/a.ts',
      type: 'FUNCTION',
      qualifiedName: 'handler',
      ordinal: 2,
    });
    expect(id).toBe('src/a.ts#FUNCTION:handler~2');
    expect(parseEntityId(id)?.ordinal).toBe(2);
  });

  it('omite o ordinal 0 para manter o id legivel no caso comum', () => {
    const id = makeEntityId({ filePath: 'a.ts', type: 'CLASS', qualifiedName: 'A', ordinal: 0 });
    expect(id).toBe('a.ts#CLASS:A');
  });

  it('nao confunde ~ do proprio identificador com ordinal', () => {
    // `~` e valido em identificador de varias linguagens; so digitos puros
    // apos o ultimo `~` contam como desempate.
    const id = 'src/a.ts#FUNCTION:weird~name';
    expect(parseEntityId(id)).toEqual({
      filePath: 'src/a.ts',
      type: 'FUNCTION',
      qualifiedName: 'weird~name',
    });
  });

  it('preserva nomes qualificados com ponto', () => {
    const id = makeEntityId({
      filePath: 'src/a.ts',
      type: 'METHOD',
      qualifiedName: 'ClientService.create',
    });
    expect(parseEntityId(id)?.qualifiedName).toBe('ClientService.create');
  });

  it('devolve null para id malformado', () => {
    expect(parseEntityId('sem-separadores')).toBeNull();
    expect(parseEntityId('#FUNCTION:x')).toBeNull();
  });
});

describe('makeFingerprint', () => {
  it('ignora diferenca de fim de linha', () => {
    // Sem isto, um checkout com CRLF no Windows marcaria o projeto inteiro como
    // alterado e anularia o ganho da indexacao incremental.
    expect(makeFingerprint('a\r\nb\r\n')).toBe(makeFingerprint('a\nb\n'));
  });

  it('muda quando o codigo muda', () => {
    expect(makeFingerprint('return 1;')).not.toBe(makeFingerprint('return 2;'));
  });
});

describe('qualifyName', () => {
  it('encadeia os contenedores lexicais', () => {
    expect(qualifyName([], 'create')).toBe('create');
    expect(qualifyName(['ClientService'], 'create')).toBe('ClientService.create');
    expect(qualifyName(['Outer', 'Inner'], 'run')).toBe('Outer.Inner.run');
  });
});

describe('toPosixPath', () => {
  it('e idempotente sobre caminhos ja normalizados', () => {
    expect(toPosixPath('src/core/ids.ts')).toBe('src/core/ids.ts');
  });
});
