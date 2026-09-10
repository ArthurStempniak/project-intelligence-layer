/**
 * Estimativa de custo em tokens.
 *
 * O PIL precisa saber o custo de um trecho *antes* de decidir incluí-lo, e o
 * orçamento (spec §14) é uma promessa quantitativa. Duas restrições moldam a
 * implementação:
 *
 * 1. Cada provedor tokeniza diferente. Não existe um número correto único —
 *    existe uma estimativa com erro conhecido. Prometer exatidão seria falso.
 * 2. A estimativa roda em todo símbolo de todo arquivo na indexação. Precisa ser
 *    linear e barata.
 *
 * Por que não `chars / 4`: essa regra vem de prosa em inglês. Código tem
 * densidade de pontuação muito maior (`});`, `=>`, `::`) e identação repetida, e
 * a heurística erra para menos justamente em código denso — o erro cai do lado
 * perigoso, estourando o orçamento em vez de desperdiçá-lo.
 *
 * Fase 2 pluga o tokenizador real de cada provedor atrás desta mesma função; a
 * margem de segurança da config existe para cobrir o intervalo até lá.
 */

/**
 * Conta unidades léxicas aproximando o comportamento de um BPE sobre código.
 *
 * A separação em classes existe porque cada uma se comporta de um jeito:
 * identificadores longos são quebrados em subpalavras pelo BPE, pontuação vira
 * quase sempre um token por caractere, e blocos de espaço em branco viram um
 * token por nível de identação — não um por caractere.
 */
export function estimateTokens(source: string): number {
  if (source.length === 0) return 0;

  let tokens = 0;
  const pattern = /([A-Za-z_$][A-Za-z0-9_$]*)|(\d[\d._]*)|(\s+)|([^\sA-Za-z0-9_$])/g;

  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const [, identifier, numeric, whitespace] = match;

    if (identifier !== undefined) {
      tokens += identifierTokenCost(identifier);
    } else if (numeric !== undefined) {
      // Números viram 1–2 tokens; literais longos são quebrados em pedaços.
      tokens += Math.max(1, Math.ceil(numeric.length / 3));
    } else if (whitespace !== undefined) {
      tokens += whitespaceTokenCost(whitespace);
    } else {
      // Pontuação e operadores: aproximadamente um token cada.
      tokens += 1;
    }
  }

  return tokens;
}

/**
 * Um identificador raramente é um token só. `calculateCommission` costuma virar
 * algo como `calculate` + `Commission`, e nomes longos ou incomuns são
 * fragmentados mais agressivamente.
 */
function identifierTokenCost(identifier: string): number {
  // Fronteiras camelCase/PascalCase são onde o BPE tende a cortar, porque as
  // subpalavras resultantes são justamente as frequentes no vocabulário.
  const parts = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter((part) => part.length > 0);

  if (parts.length === 0) return 1;

  let cost = 0;
  for (const part of parts) {
    // Palavras curtas e comuns cabem num token; a partir de ~7 caracteres o
    // BPE geralmente precisa de mais de um fragmento.
    cost += part.length <= 7 ? 1 : Math.ceil(part.length / 6);
  }
  return cost;
}

/**
 * Espaço em branco é onde `chars / 4` mais erra em código: 12 espaços de
 * identação não custam 3 tokens, custam ~1, porque tokenizadores de código têm
 * entradas dedicadas para sequências de identação.
 */
function whitespaceTokenCost(whitespace: string): number {
  const newlines = (whitespace.match(/\n/g) ?? []).length;
  if (newlines === 0) {
    // Espaço simples entre símbolos costuma ser absorvido pelo token seguinte.
    return whitespace.length > 4 ? 1 : 0;
  }
  // Uma quebra de linha mais sua identação formam tipicamente um token.
  return newlines;
}

/**
 * Custo de um trecho já sabendo o número de linhas — atalho usado na indexação,
 * onde o conteúdo já foi lido e medido.
 */
export function estimateFileTokens(source: string): number {
  return estimateTokens(source);
}

/**
 * Aplica a margem de segurança sobre um orçamento.
 *
 * A margem é subtraída do orçamento, não somada à estimativa: assim o teto que o
 * usuário pediu continua sendo um teto real mesmo quando a estimativa erra para
 * menos, que é o lado perigoso do erro.
 */
export function effectiveBudget(budget: number, safetyMargin: number): number {
  const clamped = Math.min(Math.max(safetyMargin, 0), 0.5);
  return Math.floor(budget * (1 - clamped));
}
