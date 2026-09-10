/**
 * Leitura e escrita de `.pil/config.json` (spec §24).
 *
 * A config é mesclada com os defaults campo a campo em vez de exigir um arquivo
 * completo: um `config.json` escrito à mão com só `{"context":{"defaultBudget":
 * 50000}}` precisa continuar funcionando quando novos campos forem
 * acrescentados em versões futuras.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { PilError } from '../errors.js';
import { CONFIG_FILENAME, defaultConfig, PIL_DIR, type PilConfig } from './schema.js';

export function pilDir(root: string): string {
  return join(root, PIL_DIR);
}

export function configPath(root: string): string {
  return join(pilDir(root), CONFIG_FILENAME);
}

export function indexPath(root: string): string {
  return join(pilDir(root), 'index', 'pil.db');
}

export function isInitialized(root: string): boolean {
  return existsSync(configPath(root));
}

export async function initProject(root: string, force = false): Promise<PilConfig> {
  const absoluteRoot = resolve(root);

  if (isInitialized(absoluteRoot) && !force) {
    throw new PilError(
      'ALREADY_INITIALIZED',
      `Já existe um ${PIL_DIR}/ em ${absoluteRoot}.`,
      'Use `pil init --force` para sobrescrever a configuração.',
    );
  }

  const config = defaultConfig(basename(absoluteRoot));
  await mkdir(join(pilDir(absoluteRoot), 'index'), { recursive: true });
  await writeConfig(absoluteRoot, config);
  await writeSelfIgnore(absoluteRoot);

  return { ...config, project: { ...config.project, root: absoluteRoot } };
}

/**
 * Faz o `.pil/` se ignorar sozinho no git.
 *
 * Um `.gitignore` com `*` dentro do proprio diretorio e o jeito de nao poluir o
 * `git status` do projeto alvo sem editar o `.gitignore` dele — mexer num
 * arquivo versionado do usuario para acomodar nossa ferramenta seria intrusivo,
 * e deixar o indice aparecendo como untracked em todo `git status` seria
 * irritante o suficiente para o usuario desinstalar.
 *
 * O indice e cache derivado: nunca deve ser versionado.
 */
async function writeSelfIgnore(root: string): Promise<void> {
  const content = '# Índice do PIL: cache derivado do código-fonte, não versionar.\n*\n';
  await writeFile(join(pilDir(root), '.gitignore'), content, 'utf8');
}

export async function writeConfig(root: string, config: PilConfig): Promise<void> {
  // `root` é derivado do local do arquivo em tempo de execução; persisti-lo
  // tornaria o `.pil/` intransportável entre máquinas.
  const { project, ...rest } = config;
  const serializable = { project: { name: project.name }, ...rest };

  await mkdir(pilDir(root), { recursive: true });
  await writeFile(configPath(root), `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
}

export async function loadConfig(root: string): Promise<PilConfig> {
  const absoluteRoot = resolve(root);

  if (!isInitialized(absoluteRoot)) {
    throw new PilError(
      'NOT_INITIALIZED',
      `Nenhum ${PIL_DIR}/ encontrado em ${absoluteRoot}.`,
      'Rode `pil init` primeiro.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath(absoluteRoot), 'utf8'));
  } catch (error) {
    throw new PilError(
      'CONFIG_INVALID',
      `Não foi possível ler ${CONFIG_FILENAME}: ${(error as Error).message}`,
    );
  }

  return mergeConfig(defaultConfig(basename(absoluteRoot)), parsed, absoluteRoot);
}

function mergeConfig(base: PilConfig, override: unknown, root: string): PilConfig {
  const source = (override ?? {}) as Partial<PilConfig>;

  return {
    project: { ...base.project, ...source.project, root },
    indexing: { ...base.indexing, ...source.indexing },
    context: { ...base.context, ...source.context },
    security: { ...base.security, ...source.security },
  };
}
