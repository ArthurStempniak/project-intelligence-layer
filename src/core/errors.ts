/** Erros do PIL. Todos carregam codigo estavel para a CLI mapear exit codes. */

export type PilErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'CONFIG_INVALID'
  | 'STORAGE_ERROR'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'PARSER_UNAVAILABLE'
  | 'BUDGET_TOO_SMALL'
  | 'PROVIDER_ERROR'
  | 'SECURITY_VIOLATION';

export class PilError extends Error {
  readonly code: PilErrorCode;
  /** Acao concreta que resolve — a CLI imprime isto abaixo da mensagem. */
  readonly hint?: string | undefined;

  constructor(code: PilErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'PilError';
    this.code = code;
    this.hint = hint;
  }
}

export function isPilError(error: unknown): error is PilError {
  return error instanceof PilError;
}
