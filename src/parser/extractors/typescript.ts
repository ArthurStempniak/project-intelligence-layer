/**
 * Extrator para TypeScript, JavaScript e TSX.
 *
 * A gramática do TS é um superconjunto da do JS, então um único extrator cobre
 * as três — a diferença fica em `tsx`, onde nomes PascalCase ganham tratamento
 * de componente.
 *
 * Entidades e relações saem da **mesma** travessia. Separá-las em duas passadas
 * exigiria refazer o trabalho caro (descer a árvore inteira) para reconstruir a
 * mesma informação de escopo que a primeira passada já tinha em mãos.
 */

import type { Node, Tree } from 'web-tree-sitter';

import type { EntityType } from '../../core/types/index.js';
import {
  documentationOf,
  ExtractionBuilder,
  signatureOf,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
} from '../extraction.js';

/**
 * Estado da travessia.
 *
 * `parentId` e `enclosingId` são distintos de propósito: o pai de um método é a
 * classe (contenção), mas a origem de uma chamada dentro desse método é o
 * próprio método (quem chama). Unificar os dois faria toda chamada dentro de uma
 * classe parecer partir da classe, e a análise de impacto perderia a resolução
 * de método.
 */
interface Scope {
  chain: readonly string[];
  parentId: string;
  enclosingId: string;
  exported: boolean;
  /**
   * O escopo atual e o corpo de uma classe (nao o corpo de uma funcao).
   *
   * Distingue `class A { campo = 1 }` — propriedade, que e entidade — de
   * `function f() { const x = 1 }` — local, que nao e. Sem esse bit, os dois
   * casos ficam indistinguiveis, porque em ambos `enclosingId` aponta para uma
   * entidade que nao e o arquivo.
   */
  inClassBody: boolean;
}

/** Nós que introduzem um novo escopo de nome sem serem entidades. */
const CALL_LIKE = new Set(['call_expression', 'new_expression']);

export class TypeScriptExtractor implements Extractor {
  extract(tree: Tree, input: ExtractionInput): ExtractionResult {
    const builder = new ExtractionBuilder(input);
    const isTsx = input.language === 'tsx';

    const visit = (node: Node, scope: Scope): void => {
      switch (node.type) {
        case 'export_statement': {
          // O `export` não é entidade — ele marca o que vem abaixo. Descer com
          // `exported: true` é o que faz `file_importance` distinguir API
          // pública de detalhe interno.
          this.#descend(node, { ...scope, exported: true }, visit);
          return;
        }

        case 'import_statement': {
          const source = node.childForFieldName('source');
          if (source) {
            // Os nomes importados são registrados junto porque são a **prova de
            // binding** que separa o tier EXACT do palpite por nome: sem eles,
            // `save()` casaria com qualquer `save` do projeto.
            const bound = importedNames(node);
            builder.addRelation({
              sourceId: builder.fileEntityId,
              type: 'IMPORTS',
              targetHint: stripQuotes(source.text),
              node,
              metadata: bound.length > 0 ? { names: bound } : undefined,
            });
          }
          return;
        }

        case 'class_declaration':
        case 'class': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return this.#descend(node, scope, visit);

          const id = builder.addEntity({
            type: 'CLASS',
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source),
            documentation: documentationOf(node, input.source),
            exported: scope.exported,
          });

          this.#extractHeritage(node, id, builder);

          this.#descend(
            node,
            {
              chain: [...scope.chain, name],
              parentId: id,
              enclosingId: id,
              exported: scope.exported,
              inClassBody: true,
            },
            visit,
          );
          return;
        }

        case 'function_declaration':
        case 'generator_function_declaration': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return this.#descend(node, scope, visit);

          const id = builder.addEntity({
            type: componentOrFunction(name, isTsx),
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source),
            documentation: documentationOf(node, input.source),
            exported: scope.exported,
            metadata: asyncMetadata(node),
          });

          this.#descend(
            node,
            {
              chain: [...scope.chain, name],
              parentId: id,
              enclosingId: id,
              exported: scope.exported,
              inClassBody: false,
            },
            visit,
          );
          return;
        }

        case 'method_definition': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return this.#descend(node, scope, visit);

          const id = builder.addEntity({
            type: 'METHOD',
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source),
            documentation: documentationOf(node, input.source),
            // Método herda a visibilidade da classe: não existe `export` de
            // método, mas um método de classe exportada é alcançável de fora.
            exported: scope.exported,
            metadata: asyncMetadata(node),
          });

          this.#descend(
            node,
            {
              chain: [...scope.chain, name],
              parentId: id,
              enclosingId: id,
              exported: scope.exported,
              inClassBody: false,
            },
            visit,
          );
          return;
        }

        case 'interface_declaration':
        case 'type_alias_declaration': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return;

          const type: EntityType =
            node.type === 'interface_declaration' ? 'INTERFACE' : 'TYPE';

          const id = builder.addEntity({
            type,
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source, 'body'),
            documentation: documentationOf(node, input.source),
            exported: scope.exported,
          });

          if (node.type === 'interface_declaration') {
            this.#extractHeritage(node, id, builder);
          }
          return;
        }

        case 'variable_declarator': {
          this.#extractVariable(node, scope, builder, input, isTsx, visit);
          return;
        }

        default: {
          if (CALL_LIKE.has(node.type)) {
            /*
             * `require('./x')` é import, não chamada de função.
             *
             * Encontrado rodando o PIL num projeto CommonJS real de 246
             * arquivos JS: o resultado foi **zero** relação IMPORTS e zero
             * resolução EXACT em 29 mil relações. Sem reconhecer `require`, o
             * grafo de módulos não existe e nada tem prova de binding — tudo
             * cai para casamento por nome.
             *
             * Tratado antes de `#extractCall` porque as duas leituras são
             * exclusivas: registrar também um CALLS para `require` poluiria o
             * grafo com um alvo que nunca resolve.
             */
            if (this.#extractRequire(node, builder)) {
              this.#descend(node, scope, visit);
              return;
            }
            this.#extractCall(node, scope, builder);
          }
          this.#descend(node, scope, visit);
        }
      }
    };

    const rootScope: Scope = {
      chain: [],
      parentId: builder.fileEntityId,
      enclosingId: builder.fileEntityId,
      exported: false,
      inClassBody: false,
    };
    this.#descend(tree.rootNode, rootScope, visit);

    return builder.build();
  }

  #descend(node: Node, scope: Scope, visit: (node: Node, scope: Scope) => void): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child, scope);
    }
  }

  /**
   * `const x = () => {}` é função, `const RATE = 0.15` é constante.
   *
   * A distinção importa para o Context Engine: uma constante cabe inteira no
   * pacote por alguns tokens, enquanto uma função precisa da decisão
   * FULL/SIGNATURE. Tratar as duas como "variável" jogaria fora essa escolha.
   */
  #extractVariable(
    node: Node,
    scope: Scope,
    builder: ExtractionBuilder,
    input: ExtractionInput,
    isTsx: boolean,
    visit: (node: Node, scope: Scope) => void,
  ): void {
    const nameNode = node.childForFieldName('name');
    const value = node.childForFieldName('value');

    /*
     * Só declarador com nome de identificador simples vira entidade.
     *
     * Desestruturação (`const [a, b] = x`, `const { a } = y`) tem como nome um
     * `array_pattern`/`object_pattern`, e usar o texto do nó produzia entidades
     * chamadas `[aresta]` ou `{ a, b }` — encontrado rodando `pil context`
     * sobre o próprio PIL, onde esse lixo competia por orçamento com código de
     * verdade. Extrair cada nome ligado individualmente seria o certo, mas
     * variáveis desestruturadas quase nunca são alvo de tarefa; pular é a troca
     * correta por agora.
     */
    if (!nameNode || nameNode.type !== 'identifier') {
      this.#descend(node, scope, visit);
      return;
    }
    const name = nameNode.text;

    /*
     * `const axios = require('axios')` nao vira entidade.
     *
     * E alias de modulo, nao codigo: a relacao IMPORTS ja registra o vinculo, e
     * a variavel so competiria por orcamento. Encontrado rodando `pil context`
     * num projeto CommonJS real, onde o topo do ranking era `VARIABLE:axios`,
     * `VARIABLE:ixcPools` e `VARIABLE:json` — nenhum deles codigo que alguem
     * fosse editar.
     */
    if (isRequireCall(value)) {
      this.#descend(node, scope, visit);
      return;
    }

    const isFunction =
      value?.type === 'arrow_function' ||
      value?.type === 'function_expression' ||
      value?.type === 'function';

    /*
     * Variável local dentro de uma função não vira entidade — mesma decisão do
     * extrator de Python, mas aqui o motivo é mais forte que ruído de índice:
     * se `const sales = findSales()` criasse uma entidade, ela viraria o escopo
     * envolvente e a aresta CALLS nasceria da *variável*, não da função. A
     * análise de impacto deixaria de encontrar a função que de fato chama.
     *
     * Funções atribuídas a `const` são exceção: são chamáveis, e o corpo delas
     * precisa mesmo de um escopo próprio.
     */
    const atContainerScope = scope.enclosingId === builder.fileEntityId || scope.inClassBody;
    if (!isFunction && !atContainerScope) {
      this.#descend(node, scope, visit);
      return;
    }

    const type: EntityType = isFunction
      ? componentOrFunction(name, isTsx)
      : isConstantCase(name)
        ? 'CONSTANT'
        : 'VARIABLE';

    const id = builder.addEntity({
      type,
      name,
      scopeChain: scope.chain,
      node,
      parentId: scope.parentId,
      signature: isFunction && value ? signatureOf(value, input.source) : signatureOf(node, input.source, 'value'),
      documentation: documentationOf(node.parent ?? node, input.source),
      exported: scope.exported,
      metadata: value ? asyncMetadata(value) : undefined,
    });

    this.#descend(
      node,
      {
              chain: [...scope.chain, name],
              parentId: id,
              enclosingId: id,
              exported: scope.exported,
              inClassBody: false,
            },
      visit,
    );
  }

  /**
   * `require('especificador')` → relação IMPORTS.
   *
   * Devolve `true` quando reconheceu, para o chamador não registrar também um
   * CALLS. Os nomes ligados saem do declarador que envolve a chamada, e são a
   * prova de binding que habilita o tier EXACT:
   *
   *   const repo = require('./repo')          → names: ['repo']
   *   const { save, load } = require('./db')  → names: ['save', 'load']
   *   require('./efeito-colateral')           → sem nomes
   */
  #extractRequire(node: Node, builder: ExtractionBuilder): boolean {
    const callee = node.childForFieldName('function');
    if (callee?.text !== 'require') return false;

    const args = node.childForFieldName('arguments');
    const first = args?.namedChild(0);
    if (first?.type !== 'string') return false;

    const specifier = stripQuotes(first.text);
    if (specifier === '') return false;

    const bound = requireBindings(node);
    builder.addRelation({
      sourceId: builder.fileEntityId,
      type: 'IMPORTS',
      targetHint: specifier,
      node,
      metadata: bound.length > 0 ? { names: bound, cjs: true } : { cjs: true },
    });

    return true;
  }

  #extractHeritage(node: Node, sourceId: string, builder: ExtractionBuilder): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'class_heritage' || child.type === 'extends_type_clause') {
        this.#extractHeritage(child, sourceId, builder);
        continue;
      }

      if (child.type === 'extends_clause') {
        const value = child.childForFieldName('value') ?? child.namedChild(0);
        if (value) {
          builder.addRelation({
            sourceId,
            type: 'EXTENDS',
            targetHint: baseName(value.text),
            node: child,
          });
        }
        continue;
      }

      if (child.type === 'implements_clause') {
        for (let j = 0; j < child.namedChildCount; j += 1) {
          const iface = child.namedChild(j);
          if (iface) {
            builder.addRelation({
              sourceId,
              type: 'IMPLEMENTS',
              targetHint: baseName(iface.text),
              node: child,
            });
          }
        }
      }
    }
  }

  /**
   * Nome do alvo de uma chamada.
   *
   * Para `this.repo.save(x)` registra `save`, não `this.repo.save`: o nome
   * simples é o que tem chance de casar com uma entidade indexada. A expressão
   * completa vai em `metadata` — é ela que uma futura inferência de tipo usará
   * para promover a relação de SCOPED para EXACT.
   */
  #extractCall(node: Node, scope: Scope, builder: ExtractionBuilder): void {
    const callee =
      node.childForFieldName('function') ?? node.childForFieldName('constructor') ?? node.namedChild(0);
    if (!callee) return;

    const expression = callee.text;
    const target =
      callee.type === 'member_expression'
        ? (callee.childForFieldName('property')?.text ?? baseName(expression))
        : baseName(expression);

    if (target === '') return;

    builder.addRelation({
      sourceId: scope.enclosingId,
      type: 'CALLS',
      targetHint: target,
      node,
      metadata: expression === target ? undefined : { expression },
    });
  }
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/** Último segmento de uma expressão pontuada: `a.b.C` → `C`. */
function baseName(text: string): string {
  const clean = text.replace(/<.*$/s, '').trim();
  const lastDot = clean.lastIndexOf('.');
  return lastDot >= 0 ? clean.slice(lastDot + 1) : clean;
}

function isConstantCase(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

/**
 * Em TSX, função com nome PascalCase é componente.
 *
 * Heurística assumida: verificar de fato se o corpo devolve JSX exigiria
 * analisar todos os caminhos de retorno, e a convenção de nomes é obrigatória
 * no React — o próprio runtime trata minúscula como tag HTML. O custo de errar
 * é baixo (um COMPONENT classificado como FUNCTION continua indexado igual).
 */
function componentOrFunction(name: string, isTsx: boolean): EntityType {
  return isTsx && /^[A-Z]/.test(name) ? 'COMPONENT' : 'FUNCTION';
}

function asyncMetadata(node: Node): Record<string, unknown> | undefined {
  return node.text.startsWith('async ') ? { async: true } : undefined;
}

/**
 * Nomes que um `import` traz para o escopo do arquivo.
 *
 * Cobre as três formas: `import { a, b as c }`, `import padrao` e
 * `import * as ns`. O nome registrado é sempre o **local** (o alias, quando
 * houver), porque é ele que aparece nas chamadas do arquivo — resolver pelo
 * nome original faria `import { save as persist }` nunca casar com `persist()`.
 */
function importedNames(node: Node): string[] {
  const names: string[] = [];

  const collect = (current: Node): void => {
    switch (current.type) {
      case 'import_specifier': {
        const alias = current.childForFieldName('alias');
        const name = alias ?? current.childForFieldName('name') ?? current.namedChild(0);
        if (name) names.push(name.text);
        return;
      }
      case 'namespace_import': {
        const alias = current.namedChild(0);
        if (alias) names.push(alias.text);
        return;
      }
      case 'identifier': {
        // Filho direto do import_clause: é o import default.
        names.push(current.text);
        return;
      }
      default: {
        for (let i = 0; i < current.namedChildCount; i += 1) {
          const child = current.namedChild(i);
          if (child) collect(child);
        }
      }
    }
  };

  const clause = node.namedChild(0);
  if (clause?.type === 'import_clause') collect(clause);

  return names;
}

/**
 * Nomes que um `require` traz para o escopo, lidos do declarador que o envolve.
 *
 * Cobre as três formas reais em CommonJS: atribuição simples, desestruturação
 * de objeto e ausência de atribuição (require por efeito colateral). Uma
 * chamada aninhada em expressão — `foo(require('x'))` — não liga nome nenhum, e
 * devolver lista vazia é o resultado correto.
 */
function requireBindings(callNode: Node): string[] {
  const declarator = callNode.parent;
  if (declarator?.type !== 'variable_declarator') return [];

  const nameNode = declarator.childForFieldName('name');
  if (!nameNode) return [];

  if (nameNode.type === 'identifier') return [nameNode.text];

  if (nameNode.type === 'object_pattern') {
    const names: string[] = [];
    for (let i = 0; i < nameNode.namedChildCount; i += 1) {
      const property = nameNode.namedChild(i);
      if (!property) continue;

      // `{ save }` vem como shorthand_property_identifier_pattern;
      // `{ save: persist }` como pair_pattern, e aí o nome local é o valor.
      if (property.type === 'pair_pattern') {
        const local = property.childForFieldName('value');
        if (local) names.push(local.text);
        continue;
      }
      names.push(property.text);
    }
    return names;
  }

  return [];
}

/** A expressao e uma chamada a `require`? */
function isRequireCall(node: Node | null): boolean {
  if (node?.type !== 'call_expression') return false;
  return node.childForFieldName('function')?.text === 'require';
}
