/**
 * `pil init`, `pil scan`, `pil status`.
 */

import { initProject, loadConfig, indexPath } from '../../core/config/load.js';
import type { PilConfig } from '../../core/config/schema.js';
import { Indexer } from '../../indexer/indexer.js';
import { Scanner, type FileSignature } from '../../scanner/scanner.js';
import { isChangeSetEmpty } from '../../core/types/index.js';
import { SqliteStorage } from '../../storage/sqlite/sqlite-storage.js';
import { INDEXED_STATES, type ParseState } from '../../core/types/index.js';
import { bar, bold, clearLine, cyan, dim, duration, green, heading, num, percent, table, yellow } from '../output.js';

export async function cmdInit(root: string, force: boolean): Promise<string> {
  const config = await initProject(root, force);

  const storage = new SqliteStorage(indexPath(root));
  try {
    await storage.migrate();
  } finally {
    await storage.close();
  }

  return [
    `${green('✓')} projeto ${bold(config.project.name)} inicializado`,
    '',
    table([
      ['config', dim('.pil/config.json')],
      ['índice', dim('.pil/index/pil.db')],
      ['modo', `${config.security.mode} ${dim('(nada sai da máquina)')}`],
      ['orçamento', `${num(config.context.defaultBudget)} tokens`],
    ]),
    '',
    dim('Próximo passo: pil scan'),
  ].join('\n');
}

export async function cmdScan(root: string, rebuild: boolean, quiet: boolean): Promise<string> {
  const config = await loadConfig(root);
  const storage = new SqliteStorage(indexPath(root));

  try {
    const migration = await storage.migrate({ onVersionMismatch: 'recreate' });
    if (migration.recreated) {
      process.stderr.write(
        `${yellow('!')} schema do índice mudou; reconstruindo do zero
`,
      );
    }

    const report = await new Indexer(storage, config).run({
      rebuild,
      onProgress: quiet
        ? undefined
        : (done, total, path) => {
            // `\r` sem newline: a linha é sobrescrita a cada arquivo em vez de
            // rolar milhares de linhas num projeto grande.
            if (process.stdout.isTTY) {
              const label = path.length > 50 ? `…${path.slice(-49)}` : path;
              process.stdout.write(`\r${dim(`  [${done}/${total}]`)} ${label}${clearLine}`);
            }
          },
    });

    if (!quiet && process.stdout.isTTY) process.stdout.write(`
${clearLine}`);

    const { changes, resolution } = report;
    const lines = [
      `${green('✓')} scan concluído em ${duration(report.elapsedMs)}`,
      '',
      table([
        ['adicionados', num(changes.added.length)],
        ['modificados', num(changes.modified.length)],
        ['removidos', num(changes.deleted.length)],
        ['inalterados', `${num(changes.unchangedCount)} ${dim('(não reprocessados)')}`],
      ]),
      '',
      table(
        report.resolutionSkipped
          ? [
              ['entidades', dim('inalteradas')],
              ['grafo', dim('resolução não precisou rodar (nenhum arquivo mudou)')],
            ]
          : [
              ['entidades', num(report.entities)],
              ['relações', num(report.relations)],
              [
                'resolvidas',
                `${green(`${num(resolution.exact)} exact`)}  ${cyan(`${num(resolution.scoped)} scoped`)}  ${yellow(`${num(resolution.ambiguous)} ambíguas`)}`,
              ],
              [
                'pendentes',
                `${num(resolution.stillUnresolved)} ${dim(`(${num(resolution.external)} são dependências externas)`)}`,
              ],
            ],
      ),
    ];

    if (report.parseErrors > 0) {
      lines.push('', `${yellow('!')} ${report.parseErrors} arquivo(s) com sintaxe inválida (extração parcial)`);
    }

    const skipped = Object.entries(report.skipped);
    if (skipped.length > 0) {
      lines.push(
        '',
        dim('Pulados:'),
        table(skipped.map(([reason, count]) => [reason, num(count)])),
      );
    }

    return lines.join('\n');
  } finally {
    await storage.close();
  }
}

export async function cmdStatus(root: string): Promise<string> {
  const config = await loadConfig(root);
  const storage = new SqliteStorage(indexPath(root));

  try {
    await storage.migrate();
    const stats = await storage.stats();

    if (stats.files === 0) {
      return `${yellow('!')} índice vazio.\n\n${dim('Rode `pil scan`.')}`;
    }

    const files = await storage.listFiles();
    const analyzed = files.filter((f) => INDEXED_STATES.has(f.parseState)).length;
    const coverage = analyzed / files.length;

    const byState = new Map<ParseState, number>();
    for (const file of files) {
      byState.set(file.parseState, (byState.get(file.parseState) ?? 0) + 1);
    }

    const lines = [
      heading(`PROJETO ${config.project.name.toUpperCase()}`),
      table([
        ['arquivos', num(stats.files)],
        ['entidades', num(stats.entities)],
        ['relações', num(stats.relations)],
        ['tokens totais', num(stats.totalTokens)],
        [
          'último scan',
          stats.lastScanAt ? new Date(stats.lastScanAt).toLocaleString('pt-BR') : dim('nunca'),
        ],
      ]),
      await renderFreshness(config, storage),
      heading('COBERTURA'),
      `  ${bar(coverage)}  ${percent(coverage)}  ${dim(`${analyzed}/${files.length} arquivos analisados`)}`,
      '',
      table([...byState.entries()].map(([state, count]) => [state, num(count)])),
    ];

    /*
     * Arestas pendentes são reportadas como métrica de saúde, não escondidas.
     * A maioria é dependência externa (legítima), mas uma proporção alta indica
     * que a resolução está falhando — e é o número que revela isso antes de o
     * usuário confiar num `pil impact` incompleto.
     */
    if (stats.relations > 0) {
      const resolved = 1 - stats.unresolvedRelations / stats.relations;
      lines.push(
        heading('RESOLUÇÃO DO GRAFO'),
        `  ${bar(resolved)}  ${percent(resolved)}  ${dim(`${num(stats.unresolvedRelations)} arestas pendentes`)}`,
      );
    }

    const languages = Object.entries(stats.filesByLanguage).sort((a, b) => b[1] - a[1]);
    lines.push(
      heading('LINGUAGENS'),
      table(languages.map(([language, count]) => [language, num(count)])),
    );

    const types = Object.entries(stats.entitiesByType).sort((a, b) => b[1] - a[1]);
    lines.push(
      heading('ENTIDADES'),
      table(types.map(([type, count]) => [type, num(count)])),
    );

    return lines.join('\n');
  } finally {
    await storage.close();
  }
}

/**
 * O índice está atualizado em relação ao disco?
 *
 * É a pergunta que o `pil status` precisava responder e não respondia: mostrar
 * contagens de um índice possivelmente obsoleto convida a confiar num contexto
 * que já não descreve o código. Pior ainda no fluxo em que o PIL faz sentido —
 * o usuário edita, pede contexto, e recebe a versão anterior sem aviso.
 *
 * Barato porque reaproveita o atalho de `mtime` do Scanner: arquivos intactos
 * não são lidos, só verificados. Num projeto de 421 arquivos, ~1s.
 */
async function renderFreshness(config: PilConfig, storage: SqliteStorage): Promise<string> {
  const root = config.project.root;
  if (!root) return '';

  const scanner = new Scanner({
    root,
    exclude: config.indexing.exclude,
    denyPaths: config.security.denyPaths,
    respectGitignore: config.indexing.respectGitignore,
    excludeSecrets: config.security.excludeSecrets,
    maxFileSizeBytes: config.indexing.maxFileSizeBytes,
  });

  const known = new Map<string, FileSignature>(
    (await storage.listFileSignatures()).map((signature) => [signature.path, signature]),
  );

  const scan = await scanner.scan(known);
  const changes = await storage.computeChangeSet([
    ...scan.files.map((file) => file.record),
    ...scan.unchanged,
  ]);

  if (isChangeSetEmpty(changes)) {
    return `${heading('ESTADO')}
  ${green('✓')} índice atualizado — nada mudou desde o último scan`;
  }

  const pendentes = [
    changes.added.length > 0 ? `${num(changes.added.length)} novo(s)` : null,
    changes.modified.length > 0 ? `${num(changes.modified.length)} modificado(s)` : null,
    changes.deleted.length > 0 ? `${num(changes.deleted.length)} removido(s)` : null,
  ].filter((part): part is string => part !== null);

  const amostra = [...changes.modified, ...changes.added]
    .slice(0, 5)
    .map((path) => `    ${dim(path)}`);

  return [
    heading('ESTADO'),
    `  ${yellow('!')} índice desatualizado: ${pendentes.join(', ')}`,
    ...amostra,
    changes.added.length + changes.modified.length > 5 ? dim('    …') : null,
    dim('  Rode `pil scan` antes de pedir contexto.'),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
