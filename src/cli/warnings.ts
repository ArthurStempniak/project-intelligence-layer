/**
 * Silencia o aviso de experimental do `node:sqlite`.
 *
 * O módulo é experimental no Node 22 e emite `ExperimentalWarning` a cada
 * processo. Numa CLI isso significa duas linhas de ruído em stderr antes de
 * qualquer saída útil, em todo comando — e o usuário não pode fazer nada a
 * respeito, porque a escolha do driver é do PIL, não dele.
 *
 * Silenciado de forma cirúrgica: apenas esse aviso. Qualquer outro
 * `ExperimentalWarning`, e todo `DeprecationWarning`, continua aparecendo —
 * suprimir tudo esconderia problemas reais do projeto junto com o ruído.
 *
 * **Este módulo precisa ser importado antes de qualquer coisa que carregue o
 * driver SQLite.** ESM avalia as dependências na ordem em que são declaradas,
 * então basta ser o primeiro `import` de `bin.ts`; movê-lo para baixo faz o
 * aviso voltar a escapar.
 */

const SUPPRESSED = 'SQLite is an experimental feature';

const originalEmitWarning = process.emitWarning.bind(process);

// A assinatura de `emitWarning` tem quatro sobrecargas; repassar os argumentos
// como recebidos é o que mantém todas funcionando sem reimplementá-las.
process.emitWarning = ((...args: Parameters<typeof process.emitWarning>): void => {
  const [warning] = args;
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes(SUPPRESSED)) return;
  originalEmitWarning(...args);
}) as typeof process.emitWarning;
