/**
 * Modelo semantico universal (spec 6).
 *
 * A representacao e deliberadamente independente de linguagem: o extrator de
 * cada linguagem e responsavel por traduzir seus nos de AST para estes tipos.
 * Nenhum campo aqui pode assumir sintaxe de uma linguagem especifica.
 */

/**
 * Tipos de entidade reconhecidos. Mantido como tupla `const` (e nao `enum`)
 * para sobreviver ao round-trip JSON do indice sem mapeamento reverso.
 *
 * A lista e intencionalmente ampla (spec 6: "nao limitar o modelo
 * prematuramente"). Nem todo extrator produz todos os tipos.
 */
export const ENTITY_TYPES = [
  'PROJECT',
  'DIRECTORY',
  'FILE',
  'MODULE',
  'FUNCTION',
  'METHOD',
  'CLASS',
  'INTERFACE',
  'TYPE',
  'VARIABLE',
  'CONSTANT',
  'COMPONENT',
  'ENDPOINT',
  'SERVICE',
  'CONTROLLER',
  'REPOSITORY',
  'DATABASE_TABLE',
  'DATABASE_COLUMN',
  'QUERY',
  'TEST',
  'CONFIGURATION',
  'DEPENDENCY',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPE_SET.has(value);
}

/**
 * Subconjunto de tipos que representam codigo executavel — os candidatos
 * naturais a compressao estrutural (spec 15) e a analise de impacto (spec 16).
 */
export const CALLABLE_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'FUNCTION',
  'METHOD',
  'COMPONENT',
  'ENDPOINT',
]);

/**
 * Uma entidade nomeada extraida do codigo-fonte.
 *
 * Sobre `id`: e um identificador *logico*, nao um hash de conteudo. Precisa ser
 * estavel entre re-scans para que a indexacao incremental (spec 9) consiga
 * diferenciar "entidade alterada" de "entidade removida + entidade criada" —
 * um hash de conteudo invalidaria todas as relacoes a cada edicao trivial.
 * Ver `core/ids.ts` para a derivacao.
 */
export interface CodeEntity {
  /** Id logico estavel. Ex.: `src/services/client.ts#FUNCTION:createClient`. */
  id: string;
  type: EntityType;
  /** Nome local, como declarado. Ex.: `create`. */
  name: string;
  /** Nome incluindo os contenedores lexicais. Ex.: `ClientService.create`. */
  qualifiedName: string;
  language: string;
  /** Caminho relativo a raiz do projeto, sempre com separador `/`. */
  filePath: string;
  /** Entidade contenedora (classe de um metodo, arquivo de uma funcao). */
  parentId?: string | undefined;
  /** Linhas 1-indexadas, inclusivas em ambas as pontas. */
  startLine: number;
  endLine: number;
  /** Offsets em bytes, para recortar o codigo-fonte sem reparsear. */
  startByte: number;
  endByte: number;
  /** Assinatura normalizada, sem corpo. Base da compressao da spec 15. */
  signature?: string | undefined;
  /** Docstring / JSDoc associado, ja limpo dos delimitadores de comentario. */
  documentation?: string | undefined;
  /** Visivel fora do modulo. Peso relevante em `file_importance` (spec 12). */
  exported: boolean;
  /**
   * Hash do trecho de codigo da entidade. Diferente de `id`: muda a cada
   * alteracao, e e o que permite pular reprocessamento de entidades intactas
   * dentro de um arquivo que mudou.
   */
  fingerprint: string;
  /**
   * Custo estimado em tokens do codigo completo da entidade. Calculado na
   * indexacao para que o Context Engine faca o corte por orcamento (spec 14)
   * sem reabrir arquivos.
   */
  tokenEstimate: number;
  /**
   * Termos extraidos de literais de string e texto JSX dentro da entidade.
   *
   * Nao e conteudo: e auxilio de busca. Existe porque tarefas de interface
   * referenciam o texto que o usuario ve ("atualizar os depoimentos", "corrigir
   * a validacao de CNPJ"), e esse texto vive em literais, nao em
   * identificadores. Indexar so estrutura deixava o motor cego para toda uma
   * classe de tarefa — medido no benchmark: os quatro piores casos eram
   * exatamente esses.
   *
   * Pesa menos que o nome no ranking (ver os pesos de coluna do bm25 em
   * `migrations.ts`), para que um literal solto nao supere um casamento de
   * identificador.
   */
  literals?: string | undefined;
  /** Dados especificos de linguagem ou framework. Sem esquema fixo. */
  metadata?: Record<string, unknown> | undefined;
}
