/**
 * Configuracao do projeto (spec 24), persistida em `.pil/config.json`.
 */

/**
 * Modos de operacao (spec 19).
 * - `local`:  nada sai da maquina. Indexacao e contexto locais; sem provider.
 * - `hybrid`: indexacao local, inferencia externa — so o contexto compilado sai.
 * - `cloud`:  permite envio de contexto a provedores externos.
 *
 * O default e `local`. Codigo privado nunca deve vazar por omissao de config.
 */
export const OPERATION_MODES = ['local', 'hybrid', 'cloud'] as const;
export type OperationMode = (typeof OPERATION_MODES)[number];

export interface PilConfig {
  project: {
    name: string;
    /** Raiz do projeto, absoluta. Preenchida em runtime, nao serializada. */
    root?: string;
  };
  indexing: {
    incremental: boolean;
    /** Extensoes analisadas. Vazio = todas as suportadas. */
    languages: string[];
    /** Acima disto o arquivo e registrado mas nao parseado (spec 8). */
    maxFileSizeBytes: number;
    /** Padroes ignorados alem do `.gitignore`. */
    exclude: string[];
    /**
     * Respeitar `.gitignore` (spec 8). Separado de `exclude` de proposito:
     * `.gitignore` esconde artefatos de build, mas tambem pode esconder
     * arquivos de config que o contexto precisa — sao politicas distintas.
     */
    respectGitignore: boolean;
  };
  context: {
    defaultBudget: number;
    maxHops: number;
    /**
     * Grupos de sinonimos do dominio do projeto, somados ao lexico embutido.
     *
     * Cada grupo e uma lista de termos equivalentes; a expansao e bidirecional.
     * Ex.: `[["nfe", "nota", "fiscal"], ["boleto", "slip"]]`.
     *
     * Existe porque o vocabulario de dominio e do projeto, nao da ferramenta —
     * e porque e a saida mais barata para a barreira de idioma quando nao ha
     * cognato (ARCHITECTURE.md secao 10).
     */
    dictionary: string[][];
    /**
     * Margem de seguranca sobre o orcamento. A contagem de tokens varia por
     * tokenizador e por modelo; sem folga, um pacote "dentro do orcamento"
     * estoura na janela real do provedor.
     */
    budgetSafetyMargin: number;
  };
  security: {
    /**
     * Barrar arquivos com segredos. O filtro roda antes da *indexacao*, nao
     * antes do envio: o proprio indice e um artefato que pode vazar.
     */
    excludeSecrets: boolean;
    /** Caminhos nunca lidos, mesmo que rastreados pelo git. */
    denyPaths: string[];
    mode: OperationMode;
  };
}

/** Diretorio de estado do PIL, relativo a raiz do projeto (spec 24). */
export const PIL_DIR = '.pil';
export const CONFIG_FILENAME = 'config.json';

/**
 * Caminhos negados por padrao. Lista conservadora e sem excecoes automaticas:
 * incluir um `.env` por engano no indice e um incidente, deixar um arquivo
 * legitimo de fora e um ajuste de config.
 */
export const DEFAULT_DENY_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/*.jks',
  '**/id_rsa',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/credentials',
  '**/credentials.json',
  '**/service-account*.json',
  '**/.npmrc',
  '**/.pypirc',
  '**/.aws/**',
  '**/.ssh/**',
];

export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/vendor/**',
  '**/.git/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/poetry.lock',
];

/** 1 MiB: acima disso quase sempre e artefato gerado, nao codigo escrito. */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

export function defaultConfig(projectName: string): PilConfig {
  return {
    project: { name: projectName },
    indexing: {
      incremental: true,
      languages: [],
      maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE,
      exclude: [...DEFAULT_EXCLUDES],
      respectGitignore: true,
    },
    context: {
      defaultBudget: 20_000,
      maxHops: 2,
      dictionary: [],
      budgetSafetyMargin: 0.05,
    },
    security: {
      excludeSecrets: true,
      denyPaths: [...DEFAULT_DENY_PATHS],
      mode: 'local',
    },
  };
}
