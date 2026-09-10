import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
      assert.deepEqual(result, ['inline.ts', 'file1.ts', 'file2.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws PilError when list file does not exist', async () => {
    const nonExistentFile = 'non-existent-lista.txt';
    await assert.rejects(
      async () => {
        await readIncludes(undefined, nonExistentFile);
      },
      (error: unknown) => {
        assert(error instanceof PilError);
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.equal(error.message, `arquivo de lista não encontrado: ${nonExistentFile}`);
        assert.equal(error.hint, 'Informe um arquivo com um caminho por linha.');
        return true;
      },
    );
  });

  it('throws PilError when list file is empty or contains only comments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pil-cli-test-'));
    const listFile = join(dir, 'empty-list.txt');
    await writeFile(listFile, '# only comments\n  \n');

    try {
      await assert.rejects(
        async () => {
          await readIncludes(undefined, listFile);
        },
        (error: unknown) => {
          assert(error instanceof PilError);
          assert.equal(error.code, 'CONFIG_INVALID');
          assert.equal(error.message, `arquivo de lista está vazio: ${listFile}`);
          assert.equal(error.hint, 'Informe um arquivo com um caminho por linha.');
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});