import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IgnoreSet, parseIgnoreFile, parseIgnoreLine } from '../../src/scanner/ignore.js';
import { detectLanguage, looksBinary } from '../../src/scanner/languages.js';
import { SecretGuard } from '../../src/scanner/secrets.js';
import { Scanner } from '../../src/scanner/scanner.js';
import { estimateTokens, effectiveBudget } from '../../src/core/tokens.js';
import { DEFAULT_DENY_PATHS, DEFAULT_EXCLUDES } from '../../src/core/config/schema.js';

describe('ignore — padrões', () => {
  const set = (...patterns: string[]) => IgnoreSet.fromPatterns(patterns);

  it('casa em qualquer profundidade quando não há barra', () => {
    const ignore = set('node_modules');
    expect(ignore.ignores('node_modules')).toBe(true);
    expect(ignore.ignores('a/b/node_modules')).toBe(true);
  });

  it('ancora na raiz quando há barra no meio', () => {
    const ignore = set('doc/frotz');
    expect(ignore.ignores('doc/frotz')).toBe(true);
    expect(ignore.ignores('a/doc/frotz')).toBe(false);
  });

  it('`*` não atravessa diretório', () => {
    const ignore = set('src/*.ts');
    expect(ignore.ignores('src/a.ts')).toBe(true);
    expect(ignore.ignores('src/nested/a.ts')).toBe(false);
  });

  it('`**/` atravessa qualquer número de diretórios, inclusive zero', () => {
    const ignore = set('**/dist/**');
    expect(ignore.ignores('dist/a.js')).toBe(true);
    expect(ignore.ignores('packages/web/dist/a.js')).toBe(true);
  });

  it('a última regra vence — negação resgata arquivo', () => {
    const ignore = set('*.log', '!importante.log');
    expect(ignore.ignores('erro.log')).toBe(true);
    expect(ignore.ignores('importante.log')).toBe(false);
  });

  it('padrão com barra final casa só diretório', () => {
    const ignore = set('build/');
    expect(ignore.ignores('build', true)).toBe(true);
    expect(ignore.ignores('build', false)).toBe(false);
  });

  it('ignora comentários e linhas vazias', () => {
    expect(parseIgnoreLine('# comentario')).toBeNull();
    expect(parseIgnoreLine('   ')).toBeNull();
    expect(parseIgnoreFile('# a\n\nnode_modules\n')).toHaveLength(1);
  });

  it('trata caractere especial de regex como literal', () => {
    const ignore = set('arquivo+especial.txt');
    expect(ignore.ignores('arquivo+especial.txt')).toBe(true);
    expect(ignore.ignores('arquivoXespecial.txt')).toBe(false);
  });

  it('não poda diretório quando existe alguma negação', () => {
    // Podar `node_modules/` perderia o arquivo que a negação resgata: é
    // obrigatório entrar no diretório para avaliar as regras lá dentro.
    const comNegacao = set('node_modules/', '!node_modules/minha-lib/**');
    expect(comNegacao.canPrune('node_modules')).toBe(false);

    const semNegacao = set('node_modules/');
    expect(semNegacao.canPrune('node_modules')).toBe(true);
  });
});

describe('detecção de linguagem', () => {
  it('reconhece as extensões prioritárias do MVP', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.tsx')).toBe('tsx');
    expect(detectLanguage('src/a.mjs')).toBe('javascript');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('index.html')).toBe('html');
    expect(detectLanguage('estilo.scss')).toBe('css');
  });

  it('trata .d.ts antes de resolver por extensão simples', () => {
    expect(detectLanguage('types/global.d.ts')).toBe('typescript');
  });

  it('devolve unknown para extensão desconhecida ou ausente', () => {
    expect(detectLanguage('LICENSE')).toBe('unknown');
    expect(detectLanguage('a.xyz')).toBe('unknown');
  });
});

describe('detecção de binário', () => {
  it('detecta NUL no início', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x01]))).toBe(true);
  });

  it('aceita texto UTF-8', () => {
    expect(looksBinary(new TextEncoder().encode('const a = 1; // acentuação'))).toBe(false);
  });
});

describe('barreira de segredos', () => {
  const guard = new SecretGuard(DEFAULT_DENY_PATHS);

  it('barra caminhos de credencial', () => {
    expect(guard.checkPath('.env').blocked).toBe(true);
    expect(guard.checkPath('config/.env.production').blocked).toBe(true);
    expect(guard.checkPath('certs/server.pem').blocked).toBe(true);
    expect(guard.checkPath('.ssh/id_rsa').blocked).toBe(true);
  });

  it('libera caminhos normais', () => {
    expect(guard.checkPath('src/env.ts').blocked).toBe(false);
    expect(guard.checkPath('src/services/keyboard.ts').blocked).toBe(false);
  });

  /** Chave falsa com a forma real: cabeçalho seguido de corpo base64. */
  const CHAVE_FALSA = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');

  it('detecta chave privada e tokens por conteúdo', () => {
    expect(guard.checkContent(CHAVE_FALSA).blocked).toBe(true);
    expect(guard.checkContent('const k = "AKIAEXEMPLOFALSO0000";').blocked).toBe(true);
    expect(guard.checkContent('DB=postgres://user:senha@host:5432/db').blocked).toBe(true);
  });

  it('não barra arquivo que apenas menciona cabeçalho de chave', () => {
    /*
     * O caso que motivou exigir o corpo base64: no primeiro `pil scan` do PIL
     * sobre si mesmo, este módulo e seu teste foram barrados por conterem a
     * string do cabeçalho. A ferramenta escondia do índice justamente o código
     * que decide o que esconder.
     */
    expect(guard.checkContent("if (line === '-----BEGIN PRIVATE KEY-----') skip();").blocked).toBe(
      false,
    );
    expect(guard.checkContent('// docs: chaves começam com -----BEGIN RSA PRIVATE KEY-----').blocked).toBe(
      false,
    );
  });

  it('não barra código que apenas fala sobre segredos', () => {
    // Falso positivo aqui levaria o usuário a desligar a verificação inteira,
    // que é o pior desfecho possível.
    expect(guard.checkContent('const password = req.body.password;').blocked).toBe(false);
    expect(guard.checkContent('interface Credentials { apiKey: string }').blocked).toBe(false);
    expect(guard.checkContent('// TODO: mover a secret key para o vault').blocked).toBe(false);
  });
});

describe('estimativa de tokens', () => {
  it('cresce com o tamanho do código', () => {
    const pequeno = estimateTokens('const a = 1;');
    const grande = estimateTokens('const a = 1;\n'.repeat(20));
    expect(grande).toBeGreaterThan(pequeno * 10);
  });

  it('quebra identificadores compostos em mais de um token', () => {
    expect(estimateTokens('calculateCommission')).toBeGreaterThan(estimateTokens('calc'));
  });

  it('não cobra identação como se fosse texto', () => {
    // `chars/4` cobraria 3 tokens pelos 12 espaços; o real é ~1.
    const comIdentacao = estimateTokens('\n            x');
    expect(comIdentacao).toBeLessThan(4);
  });

  it('devolve 0 para entrada vazia', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('fica numa faixa plausível para código real', () => {
    const codigo = `export function createClient(name: string, cpf: string): Client {
  validateCPF(cpf);
  return repository.create({ name, cpf });
}`;
    const tokens = estimateTokens(codigo);
    // Referência: BPEs reais produzem ~35–55 tokens para este trecho.
    expect(tokens).toBeGreaterThan(25);
    expect(tokens).toBeLessThan(70);
  });
});

describe('orçamento efetivo', () => {
  it('subtrai a margem do teto pedido', () => {
    expect(effectiveBudget(20_000, 0.05)).toBe(19_000);
  });

  it('limita margens absurdas em vez de zerar o orçamento', () => {
    expect(effectiveBudget(1000, 5)).toBe(500);
    expect(effectiveBudget(1000, -1)).toBe(1000);
  });
});

describe('Scanner — varredura real em disco', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pil-scan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (relativePath: string, content: string): Promise<void> => {
    const full = join(root, relativePath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  };

  const scan = () =>
    new Scanner({
      root,
      exclude: [...DEFAULT_EXCLUDES],
      denyPaths: [...DEFAULT_DENY_PATHS],
      respectGitignore: true,
      excludeSecrets: true,
      maxFileSizeBytes: 1024 * 1024,
    }).scan();

  it('encontra arquivos de código e detecta a linguagem', async () => {
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.py', 'def b():\n    return 1\n');

    const result = await scan();
    const byPath = new Map(result.files.map((f) => [f.record.path, f.record]));

    expect(byPath.get('src/a.ts')?.language).toBe('typescript');
    expect(byPath.get('src/b.py')?.language).toBe('python');
    expect(byPath.get('src/a.ts')?.tokenEstimate).toBeGreaterThan(0);
  });

  it('respeita o .gitignore do projeto', async () => {
    await write('.gitignore', 'ignorado.ts\n');
    await write('src/ignorado.ts', 'const x = 1;');
    await write('src/mantido.ts', 'const y = 1;');

    const paths = (await scan()).files.map((f) => f.record.path);
    expect(paths).toContain('src/mantido.ts');
    expect(paths).not.toContain('src/ignorado.ts');
  });

  it('poda node_modules sem descer nele', async () => {
    await write('node_modules/pacote/index.js', 'module.exports = 1;');
    await write('src/a.ts', 'const a = 1;');

    const paths = (await scan()).files.map((f) => f.record.path);
    expect(paths).toEqual(['src/a.ts']);
  });

  it('registra o .env como pulado, sem ler o conteúdo', async () => {
    await write('.env', 'API_KEY=sk-secreto-de-verdade\n');

    const result = await scan();
    const env = result.files.find((f) => f.record.path === '.env');

    expect(env?.record.parseState).toBe('SKIPPED_SECRET');
    // O invariante: o conteúdo nunca entra em memória indexável.
    expect(env?.content).toBeNull();
    expect(env?.record.tokenEstimate).toBe(0);
  });

  it('barra por conteúdo um arquivo de caminho inocente', async () => {
    await write(
      'src/config.ts',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxFAKEfakeFAKEfakeFAKEfake\n',
    );

    const result = await scan();
    const found = result.files.find((f) => f.record.path === 'src/config.ts');

    expect(found?.record.parseState).toBe('SKIPPED_SECRET');
    expect(found?.content).toBeNull();
  });

  it('marca arquivo grande demais sem descartá-lo do índice', async () => {
    await write('src/gigante.ts', 'x'.repeat(2000));

    const scanner = new Scanner({
      root,
      exclude: [...DEFAULT_EXCLUDES],
      denyPaths: [...DEFAULT_DENY_PATHS],
      respectGitignore: true,
      excludeSecrets: true,
      maxFileSizeBytes: 1000,
    });
    const result = await scanner.scan();
    const found = result.files.find((f) => f.record.path === 'src/gigante.ts');

    // Continua no índice: o `pil status` precisa poder dizer que ele existe e
    // por que não foi analisado.
    expect(found?.record.parseState).toBe('SKIPPED_TOO_LARGE');
  });

  it('hash ignora diferença de fim de linha', async () => {
    await write('src/lf.ts', 'const a = 1;\nconst b = 2;\n');
    const lf = (await scan()).files.find((f) => f.record.path === 'src/lf.ts');

    await write('src/lf.ts', 'const a = 1;\r\nconst b = 2;\r\n');
    const crlf = (await scan()).files.find((f) => f.record.path === 'src/lf.ts');

    expect(crlf?.record.contentHash).toBe(lf?.record.contentHash);
  });

  it('classifica linguagem desconhecida sem descartar o arquivo', async () => {
    await write('LEIAME', 'texto solto');

    const found = (await scan()).files.find((f) => f.record.path === 'LEIAME');
    expect(found?.record.parseState).toBe('UNSUPPORTED_LANGUAGE');
    expect(found?.record.language).toBe('unknown');
  });
});

describe('Scanner — atalho de mtime', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pil-mtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const scanWith = (known: Map<string, { path: string; contentHash: string; mtimeMs: number; sizeBytes: number }>) =>
    new Scanner({
      root,
      exclude: [...DEFAULT_EXCLUDES],
      denyPaths: [...DEFAULT_DENY_PATHS],
      respectGitignore: true,
      excludeSecrets: true,
      maxFileSizeBytes: 1024 * 1024,
    }).scan(known);

  it('não lê o arquivo quando mtime e tamanho batem com o índice', async () => {
    const full = join(root, 'a.ts');
    await writeFile(full, 'export const a = 1;\n', 'utf8');

    const primeiro = await scanWith(new Map());
    const registro = primeiro.files[0]?.record;
    expect(registro).toBeDefined();

    const known = new Map([
      [
        'a.ts',
        {
          path: 'a.ts',
          contentHash: registro!.contentHash,
          mtimeMs: registro!.mtimeMs,
          sizeBytes: registro!.sizeBytes,
        },
      ],
    ]);

    const segundo = await scanWith(known);
    // Não voltou em `files` (não foi lido) mas voltou em `unchanged`, para o
    // diff incremental continuar vendo que o arquivo existe.
    expect(segundo.files).toHaveLength(0);
    expect(segundo.unchanged.map((u) => u.path)).toEqual(['a.ts']);
  });

  it('lê de novo quando o tamanho muda, mesmo com o caminho conhecido', async () => {
    const full = join(root, 'a.ts');
    await writeFile(full, 'export const a = 1;\n', 'utf8');
    const primeiro = await scanWith(new Map());
    const registro = primeiro.files[0]!.record;

    await writeFile(full, 'export const a = 1;\nexport const b = 2;\n', 'utf8');

    const known = new Map([
      ['a.ts', { path: 'a.ts', contentHash: registro.contentHash, mtimeMs: registro.mtimeMs, sizeBytes: registro.sizeBytes }],
    ]);
    const segundo = await scanWith(known);

    expect(segundo.files.map((f) => f.record.path)).toEqual(['a.ts']);
    expect(segundo.files[0]?.record.contentHash).not.toBe(registro.contentHash);
  });
});
