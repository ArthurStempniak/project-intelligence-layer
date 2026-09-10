/**
 * Derivacao de identidade de entidades.
 *
 * Requisito que dita o desenho: o id precisa sobreviver a uma edicao do corpo da
 * funcao. Se o id fosse hash do conteudo, trocar uma linha dentro de
 * `createClient` criaria uma entidade nova e destruiria todas as arestas que
 * apontavam para ela — a indexacao incremental (spec 9) viraria reindexacao
 * total disfarcada. Por isso o id e *logico* (caminho + tipo + nome
 * qualificado) e a deteccao de mudanca fica a cargo do `fingerprint`, separado.
 */

import { createHash } from 'node:crypto';
import { sep as platformSep } from 'node:path';

/** Normaliza para separador POSIX: o indice precisa ser portavel entre SOs. */
export function toPosixPath(filePath: string): string {
  return platformSep === '/' ? filePath : filePath.split(platformSep).join('/');
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash curto — colisao irrelevante no escopo de um unico arquivo. */
export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}

export interface EntityIdParts {
  filePath: string;
  type: string;
  qualifiedName: string;
  /**
   * Desempate para homonimos no mesmo arquivo (sobrecargas, closures anonimas,
   * declaracoes condicionais). Omitido na primeira ocorrencia para manter o id
   * legivel no caso comum.
   */
  ordinal?: number | undefined;
}

/**
 * Monta o id logico. Formato: `caminho#TIPO:nomeQualificado[~ordinal]`.
 *
 * Legivel de proposito — ids aparecem em log, em saida de CLI e no pacote
 * enviado ao agente, e um hash opaco ali custa tempo de depuracao sem devolver
 * nada em troca.
 */
export function makeEntityId(parts: EntityIdParts): string {
  const base = `${toPosixPath(parts.filePath)}#${parts.type}:${parts.qualifiedName}`;
  return parts.ordinal !== undefined && parts.ordinal > 0
    ? `${base}~${parts.ordinal}`
    : base;
}

/** Id da entidade FILE, que ancora tudo que o arquivo contem. */
export function makeFileEntityId(filePath: string): string {
  return `${toPosixPath(filePath)}#FILE:${toPosixPath(filePath)}`;
}

export function parseEntityId(id: string): EntityIdParts | null {
  const hashAt = id.indexOf('#');
  if (hashAt <= 0) return null;
  const colonAt = id.indexOf(':', hashAt);
  if (colonAt < 0) return null;

  const filePath = id.slice(0, hashAt);
  const type = id.slice(hashAt + 1, colonAt);
  let qualifiedName = id.slice(colonAt + 1);
  let ordinal: number | undefined;

  const tildeAt = qualifiedName.lastIndexOf('~');
  if (tildeAt > 0) {
    const suffix = qualifiedName.slice(tildeAt + 1);
    // So e ordinal se for inteiro puro: `~` e caractere valido em identificador
    // de varias linguagens e nao pode ser confundido com desempate.
    if (/^\d+$/.test(suffix)) {
      ordinal = Number(suffix);
      qualifiedName = qualifiedName.slice(0, tildeAt);
    }
  }

  return ordinal === undefined
    ? { filePath, type, qualifiedName }
    : { filePath, type, qualifiedName, ordinal };
}

/**
 * Fingerprint do trecho de codigo da entidade.
 *
 * Normaliza fim de linha antes de hashear para que checkout com CRLF no Windows
 * nao marque o projeto inteiro como alterado — falso positivo que anularia o
 * ganho da indexacao incremental exatamente na plataforma deste projeto.
 */
export function makeFingerprint(sourceSlice: string): string {
  return sha256(sourceSlice.replace(/\r\n/g, '\n'));
}

/**
 * Nome qualificado a partir da cadeia de contenedores lexicais.
 * Ex.: `['ClientService', 'create']` -> `ClientService.create`.
 */
export function qualifyName(scopeChain: readonly string[], name: string): string {
  return scopeChain.length === 0 ? name : `${scopeChain.join('.')}.${name}`;
}
