import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readIncludes } from '../../src/cli/bin.js';
import { PilError } from '../../src/core/errors.js';

describe('readIncludes', () => {
  it('combines inline includes with file includes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pil-cli-test-'));
    const listFile = join(dir, 'list.txt');
    await writeFile(listFile, 'file1.ts\n# comment\n\nfile2.ts\n');

    try {
      const result = await readIncludes(['inline.ts'], listFile);
      expect(result).toEqual(['inline.ts', 'file1.ts', 'file2.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws PilError when list file does not exist', async () => {
    const nonExistentFile = 'non-existent-lista.txt';
    try {
      await readIncludes(undefined, nonExistentFile);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PilError);
      const pilErr = err as PilError;
      expect(pilErr.code).toBe('CONFIG_INVALID');
      expect(pilErr.message).toBe(`arquivo de lista não encontrado: ${nonExistentFile}`);
      expect(pilErr.hint).toBe('Informe um arquivo com um caminho por linha.');
    }
  });

  it('throws PilError when list file is empty or contains only comments and no inline includes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pil-cli-test-'));
    const listFile = join(dir, 'empty-list.txt');
    await writeFile(listFile, '# only comments\n  \n');

    try {
      await readIncludes(undefined, listFile);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PilError);
      const pilErr = err as PilError;
      expect(pilErr.code).toBe('CONFIG_INVALID');
      expect(pilErr.message).toBe(`arquivo de lista está vazio: ${listFile}`);
      expect(pilErr.hint).toBe('Informe um arquivo com um caminho por linha.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns inline includes even if list file is empty or contains only comments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pil-cli-test-'));
    const listFile = join(dir, 'empty-list.txt');
    await writeFile(listFile, '# only comments\n  \n');

    try {
      const result = await readIncludes(['inline.ts'], listFile);
      expect(result).toEqual(['inline.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});