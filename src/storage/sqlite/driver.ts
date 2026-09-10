/**
 * Ponto unico de carregamento do driver SQLite.
 *
 * Por que nao um `import` estatico de `node:sqlite`: o modulo e experimental no
 * Node 22 e, por isso, nao aparece em `module.builtinModules`. Ferramentas que
 * decidem o que e builtin consultando essa lista — Vite/Vitest, e bundlers em
 * geral — nao o reconhecem, removem o prefixo `node:` e tentam resolver um
 * pacote npm `sqlite` inexistente.
 *
 * Resolver em tempo de execucao via `createRequire` torna o import opaco para
 * analise estatica e faz o modulo chegar intacto ao Node. Os tipos continuam
 * vindo do `import type`, que e apagado na compilacao e portanto invisivel para
 * qualquer ferramenta.
 *
 * Quando `node:sqlite` sair de experimental e entrar em `builtinModules`, este
 * arquivo pode virar um reexport direto sem afetar nenhum chamador.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncClass, SQLOutputValue } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = DatabaseSyncClass;
export type { SQLOutputValue };
