#!/usr/bin/env node
/**
 * Entrypoint da CLI.
 *
 * Usa `util.parseArgs` (nativo do Node) em vez de commander/yargs: a superfície
 * de argumentos do PIL é pequena e estável, e uma dependência a mais aqui
 * contraria a spec §32 sem resolver problema nenhum.
 */

// Primeiro import de proposito: silencia o aviso de experimental do
// node:sqlite antes que qualquer modulo carregue o driver. Ver warnings.ts.
import './warnings.js';

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { PilError, isPilError } from '../core/errors.js';
import { bold, dim, red, yellow } from './output.js';
import { cmdInit, cmdScan, cmdStatus } from './commands/scan.js';
import { cmdContext, cmdImpact } from './commands/query.js';

const USAGE = `${bold('pil')} — Project Intelligence Layer

${bold('USO')}
  pil <comando> [opções]

${bold('COMANDOS')}
  init                     cria .pil/ com a configuração padrão
  scan                     indexa o projeto (incremental por padrão)
  status                   cobertura, contagens e saúde do índice
  context "<tarefa>"       monta o pacote de contexto para a tarefa
  impact "<símbolo>"       o que quebra se este símbolo mudar

${bold('OPÇÕES')}
  --root <caminho>         raiz do projeto (padrão: diretório atual)
  --budget <n>             teto de tokens do contexto
  --max-hops <n>           profundidade de expansão no grafo
  --include <caminho>      força um arquivo no contexto (repetível)
  --include-from <arq>     lê os caminhos de um arquivo, um por linha
  --min-confidence <n>     descarta arestas abaixo desta confiança (impact)
  --rebuild                reindexa tudo, ignorando o índice atual
  --explain                mostra por que cada entidade entrou
  --raw                    imprime só o pacote, para canalizar a um agente
  --json                   saída em JSON
  --quiet                  sem barra de progresso
  --force                  sobrescreve configuração existente (init)
  -h, --help               esta ajuda

${bold('EXEMPLOS')}
  pil init && pil scan
  pil context "corrigir o cálculo de comissão" --budget 20000 --explain
  pil context "adicionar desconto progressivo" --raw | claude -p
  pil context "retomar refactor" --include-from arquivos.txt --raw
  pil impact "calculateCommission"
`;

const OPTIONS = {
  root: { type: 'string' },
  budget: { type: 'string' },
  'max-hops': { type: 'string' },
  include: { type: 'string', multiple: true },
  'include-from': { type: 'string' },
  'min-confidence': { type: 'string' },
  rebuild: { type: 'boolean', default: false },
  explain: { type: 'boolean', default: false },
  raw: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * Junta os caminhos de `--include` com os de `--include-from`.
 *
 * O arquivo existe porque a linha de comando do Windows tem teto de ~32 KB, e
 * `--include` repetido estoura isso bem antes do que parece: 246 arquivos
 * derrubaram um script com `Falha na execução do programa 'node.exe': O nome do
 * arquivo ou a extensão é muito grande`. Uma lista longa gerada por script é
 * justamente o caso de uso de `--include`, então o penhasco ficava exatamente
 * onde a opção é mais útil.
 */
export async function readIncludes(
  inline: string[] | undefined,
  fromFile: string | undefined,
): Promise<string[] | undefined> {
  const paths = [...(inline ?? [])];

  if (fromFile !== undefined) {
    let content: string;
    try {
      content = await readFile(fromFile, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new PilError(
          'CONFIG_INVALID',
          `arquivo de lista não encontrado: ${fromFile}`,
          'Informe um arquivo com um caminho por linha.',
        );
      }
      throw error;
    }

    let filePathsCount = 0;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      // Linha vazia e `#` permitem gerar o arquivo com comentário sem quebrar.
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        paths.push(trimmed);
        filePathsCount++;
      }
    }

    if (filePathsCount === 0) {
      throw new PilError(
        'CONFIG_INVALID',
        `arquivo de lista está vazio: ${fromFile}`,
        'Informe um arquivo com um caminho por linha.',
      );
    }
  }

  return paths.length > 0 ? paths : undefined;
}

/** Converte para número recusando lixo em vez de deixar `NaN` circular. */
function toNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`valor inválido para ${flag}: "${value}"`);
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const root = values.root ?? process.cwd();
  const argument = rest.join(' ').trim();

  switch (command) {
    case 'init':
      process.stdout.write(`${await cmdInit(root, values.force)}\n`);
      return 0;

    case 'scan':
      process.stdout.write(`${await cmdScan(root, values.rebuild, values.quiet)}\n`);
      return 0;

    case 'status':
      process.stdout.write(`${await cmdStatus(root)}\n`);
      return 0;

    case 'context': {
      if (argument === '') {
        process.stderr.write(`${red('erro:')} informe a tarefa. Ex.: pil context "corrigir login"\n`);
        return 2;
      }
      const output = await cmdContext({
        root,
        task: argument,
        budget: toNumber(values.budget, '--budget'),
        maxHops: toNumber(values['max-hops'], '--max-hops'),
        include: await readIncludes(values.include, values['include-from']),
        explain: values.explain,
        raw: values.raw,
        json: values.json,
      });
      process.stdout.write(`${output}\n`);
      return 0;
    }

    case 'impact': {
      if (argument === '') {
        process.stderr.write(`${red('erro:')} informe o símbolo. Ex.: pil impact "AuthService"\n`);
        return 2;
      }
      const output = await cmdImpact({
        root,
        target: argument,
        maxHops: toNumber(values['max-hops'], '--max-hops'),
        minConfidence: toNumber(values['min-confidence'], '--min-confidence'),
        json: values.json,
      });
      process.stdout.write(`${output}\n`);
      return 0;
    }

    // Comandos previstos pela spec §23 mas ainda não implementados. Falham com
    // a fase em que entram, em vez de "comando desconhecido" — a diferença
    // entre "não existe" e "ainda não" importa para quem lê o roadmap.
    case 'ask':
    case 'graph':
    case 'analyze':
    case 'migrate':
    case 'export':
      process.stderr.write(
        `${yellow('!')} \`pil ${command}\` ainda não implementado.\n${dim('  Ver docs/ROADMAP.md — Fase 2 em diante.')}\n`,
      );
      return 3;

    default:
      process.stderr.write(`${red('erro:')} comando desconhecido "${command}"\n\n${USAGE}\n`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (isPilError(error)) {
    process.stderr.write(`${red('erro:')} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${dim(error.hint)}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${red('erro inesperado:')} ${(error as Error).message}\n`);
    // Stack só com PIL_DEBUG: numa CLI, stack por padrão esconde a mensagem
    // útil no meio de ruído de framework.
    if (process.env['PIL_DEBUG']) process.stderr.write(`${dim(String((error as Error).stack))}\n`);
    process.exitCode = 1;
  }
}