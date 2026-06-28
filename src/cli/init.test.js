import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { PullOpsCli } from './PullOpsCli.js';

const execFileAsync = promisify(execFile);

test('init prints human output by default and JSON output with --json', async () => {
  const cwd = await createGitRepository();

  const humanStdout = createWritableBuffer();
  const humanCli = new PullOpsCli({ cwd, stdout: humanStdout });
  const humanExitCode = await humanCli.run(['init']);

  assert.equal(humanExitCode, 0);
  assert.match(humanStdout.text, /PullOps Init: ready/);
  assert.match(humanStdout.text, /Area: setup-entry/);
  assert.match(humanStdout.text, /pullops\.config\.js/);
  assert.match(humanStdout.text, /Changes:/);

  const jsonStdout = createWritableBuffer();
  const jsonCli = new PullOpsCli({ cwd, stdout: jsonStdout });
  const jsonExitCode = await jsonCli.run(['init', '--json']);

  assert.equal(jsonExitCode, 0);
  assert.deepEqual(JSON.parse(jsonStdout.text), {
    status: 'ready',
    area: 'setup-entry',
    summary: 'PullOps setup entry point is already complete.',
    changes: [],
    changesNeeded: [],
    blockers: [],
    warnings: [],
    suggestions: [],
  });
});

test('init --check returns a nonzero exit code for incomplete setup', async () => {
  const cwd = await createGitRepository();
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({ cwd, stdout });

  const exitCode = await cli.run(['init', '--check', '--json']);

  assert.equal(exitCode, 1);
  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'changes-needed');
  assert.deepEqual(
    output.changesNeeded.sort(),
    ['.agents/skills/pullops-setup/SKILL.md', '.pullops/install-manifest.json', 'pullops.config.js'].sort(),
  );
});

/**
 * @returns {{ text: string, write(chunk: string | Uint8Array): void }}
 */
function createWritableBuffer() {
  let text = '';
  return {
    get text() {
      return text;
    },
    write(chunk) {
      text += chunk.toString();
    },
  };
}

/**
 * @returns {Promise<string>}
 */
async function createGitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-cli-init-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  await writeFile(join(cwd, 'package.json'), '{"name":"demo","private":true}\n');
  return cwd;
}
