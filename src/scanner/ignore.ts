/**
 * Casamento de padrões no estilo `.gitignore`.
 *
 * Implementado aqui em vez de usar o pacote `ignore` por uma razão concreta: as
 * regras de ignore decidem o que existe para o PIL. Um arquivo excluído por
 * engano não gera erro — ele simplesmente nunca aparece no contexto, e o modo de
 * falha é o agente concluir que o código não existe. Manter a lógica visível e
 * testada vale mais aqui do que economizar 150 linhas.
 *
 * Subconjunto implementado (o que o `.gitignore` real usa na prática):
 *   - comentários (`#`) e linhas vazias
 *   - negação (`!padrao`)
 *   - só-diretório (`padrao/`)
 *   - âncora na raiz (`/padrao`, ou barra no meio do padrão)
 *   - curingas `*` (não cruza `/`), `**` (cruza), `?`
 *   - classes de caractere `[abc]`, `[a-z]`
 *
 * Não implementado, por ausência de uso real neste contexto: `\` de escape
 * antes de caractere especial.
 */

export interface IgnoreRule {
  /** Regex compilada a partir do padrão. */
  matcher: RegExp;
  /** `!padrao` — reabilita um caminho excluído por uma regra anterior. */
  negated: boolean;
  /** `padrao/` — casa apenas diretórios. */
  directoryOnly: boolean;
  /** Padrão original, preservado para diagnóstico. */
  source: string;
}

/**
 * Traduz um padrão gitignore para regex.
 *
 * A ordem dos casos importa: `**` precisa ser tratado antes de `*`, senão o
 * segundo asterisco vira "qualquer coisa menos barra" e o padrão deixa de
 * atravessar diretórios.
 */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let regex = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` consome zero ou mais segmentos — é o que faz `**/node_modules`
        // casar tanto na raiz quanto aninhado.
        if (pattern[index + 2] === '/') {
          regex += '(?:.*/)?';
          index += 3;
          continue;
        }
        regex += '.*';
        index += 2;
        continue;
      }
      regex += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', index);
      if (close > index) {
        regex += pattern.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      regex += '\\[';
      index += 1;
      continue;
    }

    regex += char.replace(/[.+^${}()|\\]/g, '\\$&');
    index += 1;
  }

  // Sem âncora, o padrão pode casar em qualquer profundidade: `node_modules`
  // no .gitignore vale para `a/b/node_modules`, não só para a raiz.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${regex}$`);
}

export function parseIgnoreLine(line: string): IgnoreRule | null {
  const trimmed = line.trimEnd();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let pattern = trimmed;
  let negated = false;

  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }

  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);

  // Uma barra no início ou no meio ancora o padrão na raiz do .gitignore.
  // `doc/frotz` casa só na raiz; `frotz` casa em qualquer nível.
  const slashIndex = pattern.indexOf('/');
  const anchored = slashIndex >= 0 && slashIndex !== pattern.length - 1;
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  if (pattern === '') return null;

  return {
    matcher: patternToRegex(pattern, anchored),
    negated,
    directoryOnly,
    source: trimmed,
  };
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = parseIgnoreLine(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Conjunto de regras aplicáveis a um projeto.
 *
 * Guarda a ordem: no gitignore a **última** regra que casa decide, e é isso que
 * torna `!importante.log` capaz de resgatar um arquivo excluído por `*.log`.
 */
export class IgnoreSet {
  readonly #rules: IgnoreRule[];

  constructor(rules: IgnoreRule[] = []) {
    this.#rules = rules;
  }

  static fromPatterns(patterns: readonly string[]): IgnoreSet {
    const rules: IgnoreRule[] = [];
    for (const pattern of patterns) {
      const rule = parseIgnoreLine(pattern);
      if (rule) rules.push(rule);
    }
    return new IgnoreSet(rules);
  }

  /** Une dois conjuntos preservando a precedência (o segundo decide por último). */
  concat(other: IgnoreSet): IgnoreSet {
    return new IgnoreSet([...this.#rules, ...other.rules]);
  }

  get rules(): readonly IgnoreRule[] {
    return this.#rules;
  }

  /**
   * `relativePath` deve usar separador POSIX e ser relativo à raiz do projeto.
   *
   * Percorre da última regra para a primeira e para na primeira que casar: é a
   * tradução direta de "a última regra vence", sem precisar avaliar todas.
   */
  ignores(relativePath: string, isDirectory = false): boolean {
    for (let i = this.#rules.length - 1; i >= 0; i -= 1) {
      const rule = this.#rules[i] as IgnoreRule;
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.matcher.test(relativePath)) return !rule.negated;
    }
    return false;
  }

  /**
   * Um diretório pode ser podado da varredura?
   *
   * Só quando nenhuma regra de negação existe: `node_modules/` pode ser podado,
   * mas se houver `!node_modules/minha-lib/**` em algum lugar, entrar no
   * diretório é obrigatório — podar ali perderia o arquivo resgatado.
   */
  canPrune(relativePath: string): boolean {
    if (!this.ignores(relativePath, true)) return false;
    return !this.#rules.some((rule) => rule.negated);
  }
}
