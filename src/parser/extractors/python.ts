/**
 * Extrator para Python.
 *
 * Duas diferenças estruturais em relação ao extrator de TS moldam este arquivo:
 *
 * 1. **Não existe `export`.** A visibilidade é por convenção: nome iniciado com
 *    `_` é privado. Traduzir isso para `exported` mantém o sinal
 *    `file_importance` funcionando sem inventar um conceito que a linguagem não
 *    tem.
 * 2. **A documentação fica dentro do corpo**, não antes da declaração — a
 *    docstring é a primeira expressão do bloco. `documentationOf` (que olha para
 *    o irmão anterior) não serve aqui.
 */

import type { Node, Tree } from 'web-tree-sitter';

import type { EntityType } from '../../core/types/index.js';
import {
  cleanComment,
  ExtractionBuilder,
  signatureOf,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
} from '../extraction.js';

interface Scope {
  chain: readonly string[];
  parentId: string;
  enclosingId: string;
  /** Dentro de uma classe, um `function_definition` é método, não função. */
  inClass: boolean;
}

export class PythonExtractor implements Extractor {
  extract(tree: Tree, input: ExtractionInput): ExtractionResult {
    const builder = new ExtractionBuilder(input);

    const visit = (node: Node, scope: Scope): void => {
      switch (node.type) {
        case 'decorated_definition': {
          // O decorador embrulha a definição. Descer preservando o escopo faz a
          // função decorada ser indexada normalmente; sem isso, todo endpoint de
          // Flask/FastAPI — que são sempre decorados — sumiria do índice.
          this.#descend(node, scope, visit);
          return;
        }

        case 'import_statement':
        case 'import_from_statement': {
          const moduleNode = node.childForFieldName('module_name');
          const module = moduleNode?.text ?? node.childForFieldName('name')?.text;
          if (module) {
            // Como no extrator de TS, os nomes ligados sao a prova de binding
            // que separa EXACT de palpite. Em `import os` o proprio modulo e o
            // nome ligado; em `from .repo import Repo` sao os nomes importados.
            const bound = moduleNode ? importedNames(node, moduleNode) : [module];
            builder.addRelation({
              sourceId: builder.fileEntityId,
              type: 'IMPORTS',
              targetHint: module,
              node,
              metadata: bound.length > 0 ? { names: bound } : undefined,
            });
          }
          return;
        }

        case 'class_definition': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return;

          const id = builder.addEntity({
            type: 'CLASS',
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source),
            documentation: docstringOf(node),
            exported: isPublic(name),
          });

          this.#extractSuperclasses(node, id, builder);

          this.#descend(
            node,
            { chain: [...scope.chain, name], parentId: id, enclosingId: id, inClass: true },
            visit,
          );
          return;
        }

        case 'function_definition': {
          const name = node.childForFieldName('name')?.text;
          if (!name) return;

          const type: EntityType = scope.inClass ? 'METHOD' : 'FUNCTION';

          const id = builder.addEntity({
            type,
            name,
            scopeChain: scope.chain,
            node,
            parentId: scope.parentId,
            signature: signatureOf(node, input.source),
            documentation: docstringOf(node),
            exported: isPublic(name),
            metadata: node.text.startsWith('async ') ? { async: true } : undefined,
          });

          this.#descend(
            node,
            // `inClass: false` ao descer: uma função aninhada dentro de um
            // método é função, não outro método.
            { chain: [...scope.chain, name], parentId: id, enclosingId: id, inClass: false },
            visit,
          );
          return;
        }

        case 'assignment': {
          this.#extractAssignment(node, scope, builder, input);
          return;
        }

        case 'call': {
          this.#extractCall(node, scope, builder);
          this.#descend(node, scope, visit);
          return;
        }

        default:
          this.#descend(node, scope, visit);
      }
    };

    this.#descend(
      tree.rootNode,
      {
        chain: [],
        parentId: builder.fileEntityId,
        enclosingId: builder.fileEntityId,
        inClass: false,
      },
      visit,
    );

    return builder.build();
  }

  #descend(node: Node, scope: Scope, visit: (node: Node, scope: Scope) => void): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child, scope);
    }
  }

  /**
   * Só atribuições de módulo ou de classe viram entidade.
   *
   * Variável local dentro de função é ruído para o Context Engine: ela não é
   * alcançável de fora, ninguém a referencia por nome em outro arquivo, e
   * indexá-la inflaria o índice sem acrescentar nada ao grafo.
   */
  #extractAssignment(
    node: Node,
    scope: Scope,
    builder: ExtractionBuilder,
    input: ExtractionInput,
  ): void {
    if (scope.enclosingId !== builder.fileEntityId && !scope.inClass) return;

    const left = node.childForFieldName('left');
    if (!left || left.type !== 'identifier') return;

    const name = left.text;
    builder.addEntity({
      type: /^[A-Z][A-Z0-9_]*$/.test(name) ? 'CONSTANT' : 'VARIABLE',
      name,
      scopeChain: scope.chain,
      node,
      parentId: scope.parentId,
      signature: signatureOf(node, input.source, 'right'),
      exported: isPublic(name),
    });
  }

  #extractSuperclasses(node: Node, sourceId: string, builder: ExtractionBuilder): void {
    const superclasses = node.childForFieldName('superclasses');
    if (!superclasses) return;

    for (let i = 0; i < superclasses.namedChildCount; i += 1) {
      const base = superclasses.namedChild(i);
      if (!base) continue;
      // `metaclass=Meta` e afins aparecem como keyword_argument; não são herança.
      if (base.type !== 'identifier' && base.type !== 'attribute') continue;

      builder.addRelation({
        sourceId,
        type: 'EXTENDS',
        targetHint: baseName(base.text),
        node: base,
      });
    }
  }

  #extractCall(node: Node, scope: Scope, builder: ExtractionBuilder): void {
    const callee = node.childForFieldName('function');
    if (!callee) return;

    const expression = callee.text;
    const target =
      callee.type === 'attribute'
        ? (callee.childForFieldName('attribute')?.text ?? baseName(expression))
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

/**
 * Docstring: primeira expressão-string do corpo.
 *
 * É a convenção da linguagem (PEP 257) e a única fonte confiável de
 * documentação em Python — comentários `#` antes da declaração costumam ser
 * anotações de trabalho, não descrição da função.
 */
function docstringOf(node: Node): string | undefined {
  const body = node.childForFieldName('body');
  const first = body?.namedChild(0);
  if (first?.type !== 'expression_statement') return undefined;

  const literal = first.namedChild(0);
  if (literal?.type !== 'string') return undefined;

  return cleanComment(literal.text.replace(/^[rbuf]*('''|"""|'|")/i, '').replace(/('''|"""|'|")$/, ''));
}

/** Convenção do Python: `_nome` é interno. */
function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

function baseName(text: string): string {
  const lastDot = text.lastIndexOf('.');
  return lastDot >= 0 ? text.slice(lastDot + 1) : text;
}

/**
 * Nomes trazidos por um `from X import a, b as c`.
 *
 * O no do modulo e excluido explicitamente: na gramatica do Python ele e um
 * `dotted_name` irmao dos nomes importados, e sem filtra-lo o proprio modulo
 * entraria como simbolo ligado.
 */
function importedNames(node: Node, moduleNode: Node): string[] {
  const names: string[] = [];

  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child || child.id === moduleNode.id) continue;

    if (child.type === 'aliased_import') {
      const alias = child.childForFieldName('alias');
      if (alias) names.push(alias.text);
      continue;
    }
    if (child.type === 'dotted_name' || child.type === 'identifier') {
      names.push(baseName(child.text));
    }
  }

  return names;
}
