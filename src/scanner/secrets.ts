/**
 * Barreira de segredos (spec §19).
 *
 * Roda antes da indexação, não antes do envio: o índice em `.pil/` é ele próprio
 * um artefato que pode ser copiado, versionado por engano ou lido por outra
 * ferramenta. Um segredo que entra no índice já vazou do ponto de vista de quem
 * o classificou como segredo.
 *
 * A assimetria de custo orienta a calibragem: barrar um arquivo legítimo custa
 * um ajuste em `.pil/config.json`; indexar uma chave privada custa uma rotação
 * de credencial. Na dúvida, barra.
 */

import { IgnoreSet } from './ignore.js';

export type SecretVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Padrões de conteúdo com forma reconhecível e específica.
 *
 * Deliberadamente restrito a formatos que têm estrutura própria — cabeçalho de
 * chave PEM seguido do corpo, prefixos de token de provedores conhecidos.
 * Padrões genéricos do tipo `senha\s*=\s*"..."` foram descartados: em código
 * real eles casam com nomes de campo, testes e formulários, e o excesso de falso
 * positivo levaria o usuário a desligar a verificação inteira — que é o pior
 * desfecho possível.
 *
 * O cabeçalho PEM exige o corpo base64 na sequência. Sem essa exigência o
 * detector bloqueia qualquer arquivo que apenas *fale* sobre chaves: este
 * módulo, seus testes e a documentação de segurança. Foi o que aconteceu no
 * primeiro `pil scan` do PIL sobre si mesmo — a ferramenta escondeu do índice
 * justamente o código que decide o que esconder. Um cabeçalho sem corpo não é
 * uma chave, então exigir o corpo ganha precisão sem perder cobertura.
 */
const CONTENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=]{20}/,
    reason: 'chave privada PEM',
  },
  {
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----\s+[A-Za-z0-9+/=]{20}/,
    reason: 'chave privada OpenSSH',
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: 'access key da AWS' },
  { pattern: /\bghp_[A-Za-z0-9]{36}\b/, reason: 'token pessoal do GitHub' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, reason: 'token de acesso do GitHub' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, reason: 'chave de API da Anthropic' },
  { pattern: /\bsk-[A-Za-z0-9]{40,}\b/, reason: 'chave de API da OpenAI' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, reason: 'token do Slack' },
  { pattern: /"type"\s*:\s*"service_account"/, reason: 'service account do Google' },
  {
    pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s:@/]+@/,
    reason: 'string de conexão com credencial embutida',
  },
];

/** Só o começo do arquivo é inspecionado — o suficiente para cabeçalhos e envs. */
const CONTENT_SCAN_BYTES = 16_000;

export class SecretGuard {
  readonly #denyPaths: IgnoreSet;
  readonly #scanContent: boolean;

  constructor(denyPaths: readonly string[], scanContent = true) {
    this.#denyPaths = IgnoreSet.fromPatterns(denyPaths);
    this.#scanContent = scanContent;
  }

  /** Verdade sobre o caminho, decidida antes de o arquivo ser lido. */
  checkPath(relativePath: string): SecretVerdict {
    if (this.#denyPaths.ignores(relativePath)) {
      return { blocked: true, reason: 'caminho na lista de negação' };
    }
    return { blocked: false };
  }

  /** Verdade sobre o conteúdo, decidida antes de o arquivo ser indexado. */
  checkContent(content: string): SecretVerdict {
    if (!this.#scanContent) return { blocked: false };

    const sample =
      content.length > CONTENT_SCAN_BYTES ? content.slice(0, CONTENT_SCAN_BYTES) : content;

    for (const { pattern, reason } of CONTENT_PATTERNS) {
      if (pattern.test(sample)) return { blocked: true, reason };
    }
    return { blocked: false };
  }
}
