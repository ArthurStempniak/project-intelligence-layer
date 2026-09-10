#!/usr/bin/env node
/**
 * Runner do benchmark.
 *
 *   npm run bench -- --repo ../meu-projeto --limit 20 --budget 20000
 */

import { parseArgs } from 'node:util';

import { isGitRepo } from './corpus.js';
import { runBenchmark, type BenchmarkReport } from './benchmark.js';
import { bar, bold, dim, duration, green, heading, num, percent, red, table, yellow } from '../cli/output.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    limit: { type: 'string', default: '20' },
    budget: { type: 'string', default: '20000' },
    json: { type: 'boolean', default: false },
  },
});

const repo = values.repo ?? process.cwd();

if (!(await isGitRepo(repo))) {
  process.stderr.write(`${red('erro:')} ${repo} não é um repositório git\n`);
  process.exit(2);
}

const limit = Number(values.limit);
const budget = Number(values.budget);

process.stderr.write(`${dim(`montando corpus de ${repo}…`)}\n`);

const report = await runBenchmark({
  repo,
  budget,
  limit,
  onCase: (result, index, total) => {
    const status = result.error
      ? red('erro')
      : result.recall >= 0.8
        ? green(percent(result.recall, 0))
        : result.recall === 0
          ? red('0%')
          : yellow(percent(result.recall, 0));
    process.stderr.write(
      `${dim(`  [${index}/${total}]`)} ${result.sha} recall ${status}  ${dim(result.task.slice(0, 46))}\n`,
    );
  },
});

process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);

function render(r: BenchmarkReport): string {
  const a = r.aggregate;
  const evaluated = r.cases.filter((c) => c.error === undefined).length;

  const lines = [
    heading('PIL BENCHMARK'),
    table([
      ['repositório', r.repo],
      ['orçamento', `${num(r.budget)} tokens`],
      ['casos avaliados', `${evaluated} ${dim(`(de ${r.commitsScanned} commits varridos)`)}`],
    ]),
    '',
    // Recall e redução sempre lado a lado: um sem o outro é propaganda.
    `  recall     ${bar(a.meanRecall)}  ${bold(percent(a.meanRecall, 0))}`,
    `  redução    ${bar(a.meanReduction)}  ${bold(percent(a.meanReduction, 0))}`,
    `  precisão   ${bar(a.meanPrecision)}  ${percent(a.meanPrecision, 0)} ${dim('(observada, sem meta)')}`,
    '',
    table([
      ['time to context', `${duration(a.medianElapsedMs)} ${dim(`p95 ${duration(a.p95ElapsedMs)}`)}`],
      ['casos sem acerto', `${a.misses} ${dim('recall 0')}`],
    ]),
  ];

  const rejected = Object.entries(r.rejected);
  if (rejected.length > 0) {
    lines.push(
      heading('COMMITS DESCARTADOS'),
      table(rejected.map(([reason, count]) => [reason, num(count)])),
    );
  }

  /*
   * A lista de piores casos é a parte útil do relatório: a média diz se houve
   * regressão, os piores casos dizem onde consertar — e é neles que se descobre
   * qual sinal está faltando.
   */
  const worst = r.cases
    .filter((c) => c.error === undefined)
    .sort((x, y) => x.recall - y.recall)
    .slice(0, 8);

  if (worst.length > 0) {
    lines.push(heading('PIORES CASOS'));
    for (const c of worst) {
      lines.push(
        `  ${c.sha}  ${percent(c.recall, 0).padStart(5)}  ${dim(`${c.selectedFiles.length}/${c.expectedFiles.length} arq`)}  ${c.task.slice(0, 52)}`,
      );
    }
  }

  const failed = r.cases.filter((c) => c.error !== undefined);
  if (failed.length > 0) {
    lines.push(
      heading('CASOS COM ERRO'),
      ...failed.slice(0, 5).map((c) => `  ${c.sha}  ${dim(String(c.error))}`),
    );
  }

  return lines.join('\n');
}
