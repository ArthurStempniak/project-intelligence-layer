/**
 * `pil context` e `pil impact`.
 */

import { indexPath, loadConfig } from '../../core/config/load.js';
import { ContextEngine } from '../../context/engine.js';
import { renderPackage } from '../../context/compiler.js';
import { ImpactAnalyzer, type RiskLevel } from '../../context/impact.js';
import { SqliteStorage } from '../../storage/sqlite/sqlite-storage.js';
import {
  bar,
  bold,
  confidenceLabel,
  cyan,
  dim,
  duration,
  green,
  heading,
  num,
  percent,
  red,
  table,
  yellow,
} from '../output.js';

export interface ContextArgs {
  root: string;
  task: string;
  budget?: number | undefined;
  maxHops?: number | undefined;
  include?: string[] | undefined;
  explain: boolean;
  /** Imprime o pacote pronto para o agente, sem relatório. */
  raw: boolean;
  json: boolean;
}

export async function cmdContext(args: ContextArgs): Promise<string> {
  const config = await loadConfig(args.root);
  const storage = new SqliteStorage(indexPath(args.root));

  try {
    await storage.migrate();

    const outcome = await new ContextEngine(storage, config).build({
      task: args.task,
      budget: args.budget ?? config.context.defaultBudget,
      maxHops: args.maxHops,
      include: args.include,
    });

    const { package: pkg, ranking } = outcome;

    // `--raw` existe para ser canalizado a um agente: qualquer relatório na
    // saída viraria contexto espúrio para o modelo.
    if (args.raw) return renderPackage(pkg);
    if (args.json) return JSON.stringify(pkg, null, 2);

    const m = pkg.metrics;
    const lines = [
      heading('CONTEXTO'),
      table([
        ['tarefa', pkg.task],
        ['tipo inferido', pkg.taskKind],
        ['símbolos citados', ranking.analysis.symbols.join(', ') || dim('nenhum')],
      ]),
      heading('ORÇAMENTO'),
      table([
        ['projeto inteiro', `${num(m.projectTokens)} tokens`],
        ['orçamento', `${num(m.budget)} tokens`],
        ['selecionado', `${num(m.selectedTokens)} tokens`],
      ]),
      '',
      `  ${bar(m.reduction)}  ${bold(percent(m.reduction * 100 / 100))} de redução`,
      '',
      table([
        ['arquivos', `${num(m.filesSelected)} de ${num(m.filesInProject)}`],
        ['entidades', `${num(m.entitiesSelected)} de ${num(m.entitiesConsidered)} consideradas`],
        ['tempo', duration(m.elapsedMs)],
      ]),
    ];

    if (pkg.items.length === 0) {
      lines.push(
        '',
        `${yellow('!')} nenhuma entidade relevante encontrada.`,
        '',
        dim('Se a tarefa está em português e o código usa nomes em inglês, a busca'),
        dim('lexical não alcança (ARCHITECTURE.md §10). Tente citar o identificador'),
        dim('diretamente ou usar --include <caminho>.'),
      );
      return lines.join('\n');
    }

    lines.push(heading('SELECIONADO'));
    for (const item of pkg.items) {
      const detail =
        item.detail === 'FULL' ? green('full') : item.detail === 'SIGNATURE' ? cyan('sig ') : dim('ref ');
      lines.push(
        `  ${String(item.score).padStart(3)}  ${detail}  ${String(num(item.tokens)).padStart(6)}t  ${item.entityId}`,
      );
    }

    if (args.explain) {
      lines.push(heading('POR QUE ENTRARAM'));
      const byId = new Map(ranking.ranked.map((r) => [r.entity.id, r]));
      for (const item of pkg.items.slice(0, 15)) {
        const scored = byId.get(item.entityId);
        if (!scored) continue;
        lines.push(`  ${bold(scored.entity.qualifiedName)}  ${dim(`score ${Math.round(scored.score)}`)}`);
        for (const reason of scored.reasons) lines.push(`    ${dim('·')} ${reason}`);
      }
    }

    if (pkg.omitted.length > 0) {
      lines.push(
        heading('OMITIDO POR ORÇAMENTO'),
        `  ${num(pkg.omitted.length)} entidade(s) relevante(s) não couberam`,
        dim('  (aumente --budget para incluí-las)'),
      );
    }

    return lines.join('\n');
  } finally {
    await storage.close();
  }
}

export interface ImpactArgs {
  root: string;
  target: string;
  maxHops?: number | undefined;
  minConfidence?: number | undefined;
  json: boolean;
}

const RISK_COLOR: Record<RiskLevel, (text: string) => string> = {
  LOW: green,
  MEDIUM: yellow,
  HIGH: red,
};

export async function cmdImpact(args: ImpactArgs): Promise<string> {
  const storage = new SqliteStorage(indexPath(args.root));

  try {
    await storage.migrate();

    const report = await new ImpactAnalyzer(storage).analyze({
      target: args.target,
      ...(args.maxHops === undefined ? {} : { maxHops: args.maxHops }),
      ...(args.minConfidence === undefined ? {} : { minConfidence: args.minConfidence }),
    });

    if (args.json) return JSON.stringify(report, null, 2);

    const lines = [
      heading('ANÁLISE DE IMPACTO'),
      table([
        ['alvo', bold(report.target.qualifiedName)],
        ['local', dim(`${report.target.filePath}:${report.target.startLine}`)],
        ['tipo', report.target.type],
      ]),
    ];

    // A ambiguidade do alvo aparece antes dos números: um relatório perfeito
    // sobre a função errada é o pior desfecho possível deste comando.
    if (report.alternatives.length > 0) {
      lines.push(
        '',
        `${yellow('!')} há ${report.alternatives.length} outro(s) símbolo(s) com esse nome:`,
        ...report.alternatives.slice(0, 5).map((alt) => `    ${dim(alt.id)}`),
        dim('  Passe o id completo para analisar um deles.'),
      );
    }

    lines.push(
      heading('ALCANCE'),
      table([
        ['chamadores diretos', num(report.direct.length)],
        ['chamadores indiretos', num(report.indirect.length)],
        ['arquivos afetados', num(report.affectedFiles.length)],
        ['testes afetados', num(report.affectedTests.length)],
      ]),
      heading('RISCO'),
      `  ${RISK_COLOR[report.risk](bold(report.risk))}  ${dim(report.riskRationale)}`,
    );

    if (report.direct.length > 0) {
      lines.push(heading('CHAMADORES DIRETOS'));
      for (const item of report.direct.slice(0, 20)) {
        lines.push(
          `  ${item.entity.qualifiedName.padEnd(34)} ${dim(item.entity.filePath)}  ${dim(item.pathConfidence.toFixed(2))}`,
        );
      }
    }

    if (report.indirect.length > 0) {
      lines.push(heading('CHAMADORES INDIRETOS'));
      for (const item of report.indirect.slice(0, 15)) {
        lines.push(
          `  ${item.entity.qualifiedName.padEnd(34)} ${dim(`${item.hopDistance} saltos`)}  ${dim(item.pathConfidence.toFixed(2))}`,
        );
      }
    }

    if (report.criticalDependencies.length > 0) {
      lines.push(
        heading('DEPENDÊNCIAS DO ALVO'),
        `  ${report.criticalDependencies.join(', ')}`,
      );
    }

    /*
     * O limite da análise é declarado, não escondido.
     *
     * Arestas de baixa confiança são exatamente onde a análise estática pode
     * estar errada; omitir esse número faria o relatório parecer mais completo
     * do que é.
     */
    if (report.lowConfidenceEdges > 0) {
      lines.push(
        heading('LIMITE DESTA ANÁLISE'),
        `  ${report.lowConfidenceEdges} aresta(s) apontando para o alvo têm confiança baixa`,
        dim('  (resolução por nome, sem prova de binding — verifique manualmente)'),
      );
    }

    if (report.affectedTests.length === 0 && report.direct.length > 0) {
      lines.push('', `${yellow('!')} nenhum teste cobre os chamadores encontrados`);
    }

    return lines.join('\n');
  } finally {
    await storage.close();
  }
}

export { confidenceLabel };
