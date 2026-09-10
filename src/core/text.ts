/**
 * Normalização de texto para busca.
 *
 * O problema que isto resolve: a tarefa chega em linguagem natural
 * ("corrigir o cálculo de comissão") e o código usa identificadores colados
 * (`calculateCommission`, `COMMISSION_RATE`, `commission_repository`). Um
 * tokenizador comum trata `calculateCommission` como um único termo e não casa
 * com nenhuma palavra da tarefa — o Context Engine ficaria cego justamente no
 * caminho principal.
 */

/**
 * Remove acentos preservando a letra: `indicação` → `indicacao`.
 *
 * Sem isto, toda palavra acentuada do português é destruída antes de virar
 * termo de busca. `\w` em JavaScript é `[A-Za-z0-9_]` — `ç` e `ã` não entram —
 * então a quebra por não-palavra cortava a palavra no primeiro acento:
 *
 *   "tela de indicação"  →  "indica"      (não casa com `indicacoes`)
 *   "conexão com o banco" →  "conex"
 *   "validação de CNPJ"  →  "valida"
 *
 * O efeito perverso: escrever a tarefa com a acentuação correta dava resultado
 * *pior* do que escrever errado. E o índice FTS já é construído com
 * `remove_diacritics`, então o lado da consulta era o único fora de sintonia.
 */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Quebra um identificador em palavras, cobrindo camelCase, PascalCase,
 * snake_case, kebab-case e siglas grudadas.
 *
 * `HTTPSConnection` -> `['HTTPS', 'Connection']`: a fronteira correta é antes
 * da última maiúscula de uma sequência de maiúsculas seguida de minúscula, e
 * não no primeiro caractere que muda de caixa.
 */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
}

/**
 * Termos indexáveis de um identificador: as partes quebradas mais o original.
 * O original permanece para que uma busca pelo nome exato tenha casamento
 * direto, sem depender da recomposição das partes.
 */
export function identifierTerms(identifier: string): string[] {
  const parts = splitIdentifier(identifier);
  const terms = new Set<string>(parts.map((p) => p.toLowerCase()));
  terms.add(identifier.toLowerCase());
  return [...terms];
}

/** Monta o texto que vai para o índice FTS de uma entidade. */
export function buildSearchTerms(fields: {
  name: string;
  qualifiedName: string;
  signature?: string | undefined;
  documentation?: string | undefined;
}): string {
  const terms = new Set<string>();

  for (const term of identifierTerms(fields.name)) terms.add(term);
  for (const term of identifierTerms(fields.qualifiedName)) terms.add(term);

  // Assinatura e documentação entram quebradas também: nomes de parâmetro
  // (`planId`) são pista tão boa quanto o nome da função.
  for (const source of [fields.signature, fields.documentation]) {
    if (!source) continue;
    for (const word of source.split(/[^A-Za-z0-9_$]+/)) {
      if (word.length > 1) for (const term of identifierTerms(word)) terms.add(term);
    }
  }

  return [...terms].join(' ');
}

/**
 * Verbos de intenção, excluídos dos termos de busca.
 *
 * São exatamente as palavras que `classifyTask` usa para inferir o tipo da
 * tarefa — a informação não se perde, só deixa de poluir a busca por tópico.
 *
 * Medido: para "Update testimonial company names", o primeiro colocado era
 * `UsuarioService.updatePerfil` — casamento perfeito com a palavra menos
 * informativa da frase. Verbos de ação casam com todo `updateX`/`addY` do
 * projeto e afogam o termo que de fato identifica o assunto.
 */
const INTENT_VERBS: ReadonlySet<string> = new Set([
  'add', 'added', 'adds', 'adiciona', 'adicionar', 'incluir', 'inclui',
  'fix', 'fixes', 'fixed', 'corrige', 'corrigir', 'conserta', 'consertar',
  'update', 'updates', 'updated', 'atualiza', 'atualizar', 'altera', 'alterar',
  'create', 'creates', 'cria', 'criar', 'novo', 'nova', 'new',
  'remove', 'removes', 'remover', 'delete', 'deletar', 'apaga', 'apagar',
  'change', 'changes', 'muda', 'mudar', 'troca', 'trocar',
  'improve', 'melhora', 'melhorar', 'refactor', 'refatora', 'refatorar',
  'implement', 'implementa', 'implementar', 'show', 'mostra', 'mostrar',
  'replace', 'substitui', 'substituir', 'adjust', 'ajusta', 'ajustar',
  'make', 'faz', 'fazer', 'permite', 'permitir', 'allow', 'support', 'suporte',
  'valida', 'validar', 'validados', 'validadas', 'verifica', 'verificar',
  'confere', 'conferir', 'revisa', 'revisar', 'checar', 'check', 'validate',
  'corretos', 'corretas', 'correto', 'correta',
  'and', 'the', 'for', 'with', 'que', 'com', 'para', 'dos', 'das', 'nos', 'nas',
  // Preposicoes, artigos e quantificadores: casam com meio projeto e nao
  // dizem nada sobre o assunto da tarefa.
  'de', 'do', 'da', 'em', 'no', 'na', 'os', 'as', 'um', 'uma', 'ao', 'aos',
  'todos', 'todas', 'todo', 'toda', 'esta', 'estao', 'sao', 'ser', 'sem',
  'of', 'to', 'in', 'on', 'at', 'is', 'are', 'all', 'any', 'from',
]);

/**
 * Formas de um termo para busca em caminho de arquivo: o termo e seu prefixo.
 *
 * Mesma razao do prefixo no FTS, mas aqui o caso que aparece primeiro nem e
 * cognato entre linguas — e singular contra plural. a busca pelo singular nao
 * casa com o plural no caminho, porque as palavras divergem no fim. O prefixo
 * de {@link COGNATE_PREFIX} caracteres casa os dois.
 */
export function pathSearchTerms(terms: readonly string[]): string[] {
  const formas = new Set<string>();

  for (const term of terms) {
    const limpo = stripDiacritics(term).toLowerCase();
    if (limpo.length >= PATH_TERM_MIN_LENGTH) formas.add(limpo);
    if (limpo.length >= COGNATE_MIN_LENGTH) formas.add(limpo.slice(0, COGNATE_PREFIX));
  }

  return [...formas];
}

/** Abaixo disto o termo casa com metade do projeto e o resultado e ruido. */
const PATH_TERM_MIN_LENGTH = 6;

/** A palavra descreve a intencao da tarefa, e nao o seu assunto? */
export function isIntentVerb(word: string): boolean {
  return INTENT_VERBS.has(word.toLowerCase());
}

/** Tamanho mínimo do termo para valer uma busca por prefixo. */
const COGNATE_MIN_LENGTH = 8;

/** Caracteres mantidos ao truncar para casar cognatos. */
const COGNATE_PREFIX = 6;

/**
 * Prepara a tarefa do usuário como consulta FTS5.
 *
 * Escapa cada termo entre aspas duplas: sem isso, pontuação comum em linguagem
 * natural (`"`, `*`, `:`, `-`, `NOT`) é interpretada como sintaxe de consulta e
 * o FTS lança erro de parse em cima do texto do próprio usuário.
 */
export function toFtsQuery(text: string, minTermLength = 2): string {
  const terms = new Set<string>();

  for (const word of stripDiacritics(text).split(/[^A-Za-z0-9_$]+/)) {
    if (word.length < minTermLength) continue;
    for (const term of identifierTerms(word)) {
      if (term.length < minTermLength) continue;
      if (INTENT_VERBS.has(term)) continue;
      terms.add(term);
    }
  }

  if (terms.size === 0) return '';

  const clauses: string[] = [];
  for (const term of terms) {
    const escaped = term.replace(/"/g, '""');
    clauses.push(`"${escaped}"`);

    /*
     * Consulta por prefixo para termos longos, cobrindo cognatos entre
     * português e inglês.
     *
     * Vocabulário técnico das duas línguas vem do latim e compartilha raiz:
     * integration/integração, validation/validação, notification/notificação,
     * authentication/autenticação. Truncar em {@link COGNATE_PREFIX} faz os
     * dois casarem sem dicionário nenhum — é propriedade da língua, não lista
     * de exceções. Validado no benchmark: `integration` passou a encontrar
     * `dashboard/integracao/`, que antes dava recall 0.
     *
     * O corte em termos longos limita o falso positivo, e o termo exato
     * continua na consulta — o bm25 o pontua acima do prefixo, então o cognato
     * só decide quando nada exato casa.
     */
    if (term.length >= COGNATE_MIN_LENGTH) {
      clauses.push(`"${escaped.slice(0, COGNATE_PREFIX)}"*`);
    }
  }

  return clauses.join(' OR ');
}

/** Máximo de caracteres de literais indexados por entidade. */
const LITERAL_BUDGET = 600;

/**
 * Literal de string em aspas simples, duplas ou template.
 *
 * Cada alternativa aceita escapes para não parar no meio de uma string — sem
 * isso, `"diz \"oi\""` seria cortado em dois e o resto da linha entraria como
 * se fosse texto.
 */
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

/**
 * Palavras que aparecem em literais sem descrever conteúdo.
 *
 * Utilitários de CSS, nomes de framework e ruído de import. Sem este filtro,
 * `flex`, `items`, `zinc` e `react` competem por espaço com o texto real — e
 * medindo o índice de uma página React, eram *todo* o conteúdo capturado.
 */
const NON_CONTENT_WORDS: ReadonlySet<string> = new Set([
  'use', 'client', 'server', 'react', 'next', 'link', 'import', 'from', 'default',
  'flex', 'grid', 'items', 'justify', 'center', 'between', 'around', 'start', 'end',
  'gap', 'col', 'cols', 'row', 'rows', 'span', 'auto', 'none', 'block', 'inline',
  'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'top', 'bottom', 'left',
  'right', 'text', 'font', 'medium', 'bold', 'semibold', 'light', 'sans', 'serif',
  'border', 'rounded', 'shadow', 'ring', 'outline', 'via', 'opacity',
  'hover', 'focus', 'active', 'disabled', 'group', 'peer', 'dark',
  'zinc', 'slate', 'gray', 'grey', 'neutral', 'stone', 'white', 'black',
  'transition', 'duration', 'ease', 'transform', 'scale', 'translate', 'rotate',
  'cursor', 'pointer', 'select', 'overflow', 'truncate', 'whitespace', 'nowrap',
  'width', 'height', 'min', 'max', 'full', 'screen', 'container', 'wrapper',
  'div', 'span', 'classname', 'class', 'style', 'src', 'alt', 'href',
]);

/**
 * Termos de literais de string e de texto JSX dentro de um trecho de código.
 *
 * Implementado por regex sobre o texto, e não por travessia de AST, de
 * propósito: a mesma função serve todas as linguagens, e a precisão exigida
 * aqui é baixa — o resultado alimenta um índice de busca, onde um falso termo
 * custa ruído marginal, não erro.
 *
 * O orçamento de caracteres existe porque um componente grande pode conter
 * páginas de texto, e indexar tudo diluiria os termos que importam.
 */
export function extractLiteralTerms(source: string): string | undefined {
  const terms = new Set<string>();
  let budget = LITERAL_BUDGET;

  const consume = (raw: string): void => {
    if (budget <= 0) return;
    for (const word of raw.split(/[^\p{L}\p{N}]+/u)) {
      // Palavras de 1–2 letras em texto de interface são artigos e preposições.
      if (word.length < 3 || budget <= 0) continue;
      const lower = word.toLowerCase();
      if (terms.has(lower) || NON_CONTENT_WORDS.has(lower)) continue;
      terms.add(lower);
      budget -= lower.length + 1;
    }
  };

  /*
   * Texto JSX/HTML vem PRIMEIRO; literais de string depois.
   *
   * A ordem foi invertida por medição. Num componente React moderno os
   * literais são dominados por `className="flex items-center …"`, e o
   * orçamento se esgotava em nomes de classe Tailwind antes de alcançar
   * qualquer texto visível: o índice do arquivo-alvo do benchmark continha
   * exatamente `flex items center justify between cursor pointer` e zero
   * palavra do conteúdo real.
   *
   * Texto entre tags é a copy que o usuário vê — justamente o que uma tarefa
   * de interface menciona. Ele tem prioridade no orçamento.
   */
  for (const match of source.matchAll(/>([^<>{}]{3,300})</g)) {
    consume(match[1] ?? '');
    if (budget <= 0) break;
  }

  for (const match of source.matchAll(STRING_LITERAL)) {
    if (budget <= 0) break;
    // Atributo de estilo nunca é conteúdo, e é o maior volume de string do
    // arquivo. Detectado pelo texto imediatamente anterior à abertura.
    if (isStyleAttribute(source, match.index)) continue;
    consume(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return terms.size === 0 ? undefined : [...terms].join(' ');
}

/** Olha os caracteres antes da string para decidir se ela é um `className`. */
function isStyleAttribute(source: string, start: number): boolean {
  const before = source.slice(Math.max(0, start - 14), start);
  return /(?:class|className|styles?|cn|clsx|tw)\s*[=(:]\s*$/.test(before);
}
