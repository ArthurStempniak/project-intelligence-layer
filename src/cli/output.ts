/**
 * Formatação da saída da CLI.
 *
 * Cor é aplicada só quando a saída é um terminal interativo. Redirecionar para
 * arquivo ou pipe (`pil status > relatorio.txt`, `pil context | jq`) tem de
 * produzir texto limpo — códigos ANSI num arquivo são lixo, e num pipe quebram
 * o parser do outro lado.
 */

const useColor =
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

// `String.fromCharCode(27)` em vez do byte ESC literal: um caractere de
// controle invisivel no fonte sobrevive mal a copy/paste, lint e diff.
const ESC = `${String.fromCharCode(27)}[`;

const wrap = (code: string) => (text: string) =>
  useColor ? `${ESC}${code}m${text}${ESC}0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

export function heading(text: string): string {
  return `\n${bold(text)}\n${dim('─'.repeat(text.length))}`;
}

/** Alinha pares rótulo/valor numa coluna estável. */
export function table(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}

/** Barra de proporção, para percentuais em relatório. */
export function bar(fraction: number, width = 20): string {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${dim('░'.repeat(width - filled))}`;
}

export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Separador de milhar — números de projeto grande viram ilegíveis sem isso. */
export function num(value: number): string {
  return value.toLocaleString('pt-BR');
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Confiança exibida como tier, não só como número.
 *
 * Decisão deliberada (ARCHITECTURE.md §4): `0.75` não comunica nada ao usuário,
 * enquanto `SCOPED` avisa que houve casamento por nome sem prova de binding.
 * Mostrar apenas o número convidaria a tratar palpite como fato.
 */
export function confidenceLabel(resolution: string, confidence: number): string {
  const paint =
    resolution === 'EXACT' ? green : resolution === 'SCOPED' ? cyan : resolution === 'AMBIGUOUS' ? yellow : red;
  return `${paint(resolution.toLowerCase())} ${dim(confidence.toFixed(2))}`;
}

/**
 * Apaga do cursor até o fim da linha.
 *
 * Necessário na barra de progresso: sem isso, o resto do caminho anterior fica
 * visível quando o nome do arquivo seguinte é mais curto.
 */
export const clearLine = useColor ? '\u001b[K' : '';
