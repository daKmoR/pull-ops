import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { PullOpsCli } from './PullOpsCli.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('init prints human output by default and JSON output with --json', async () => {
  const cwd = await createGitRepository();

  const humanStdout = createWritableBuffer();
  const humanCli = new PullOpsCli({ cwd, stdout: humanStdout });
  const humanExitCode = await humanCli.run(['init']);

  assert.equal(humanExitCode, 0);
  assert.match(humanStdout.text, /PullOps Init: changed/);
  assert.match(humanStdout.text, /Area: init/);
  assert.match(humanStdout.text, /pullops\.config\.js/);
  assert.match(humanStdout.text, /\.gitignore/);
  assert.match(humanStdout.text, /Changes:/);

  const jsonStdout = createWritableBuffer();
  const jsonCli = new PullOpsCli({ cwd, stdout: jsonStdout });
  const jsonExitCode = await jsonCli.run(['init', '--json']);

  assert.equal(jsonExitCode, 0);
  assert.deepEqual(JSON.parse(jsonStdout.text), {
    status: 'ready',
    area: 'init',
    summary: 'PullOps setup entry point is already complete.',
    changes: {},
    changesNeeded: {},
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
  assert.equal(output.status, 'blocked');
  assert.deepEqual(
    output.changesNeeded.files.sort(),
    [
      '.agents/skills/pullops-setup/SKILL.md',
      '.gitignore',
      '.pullops/install-manifest.json',
      'pullops.config.js',
    ].sort(),
  );
});

test('setup doctor returns a nonzero exit code for incomplete setup guidance', async () => {
  const cwd = await createSetupReadyGitRepository();
  const initCli = new PullOpsCli({ cwd, stdout: createWritableBuffer() });
  const initExitCode = await initCli.run(['init']);

  assert.equal(initExitCode, 0);

  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({ cwd, stdout });
  const exitCode = await cli.run(['setup', 'doctor', '--profile', 'authoring', '--json']);

  assert.equal(exitCode, 1);

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'blocked');
  assert.equal(output.area, 'doctor');
  assert.ok(output.changesNeeded.files.includes('docs/agents/issue-tracker.md'));
  assert.ok(output.changesNeeded.files.includes('docs/agents/triage-labels.md'));
});

test('setup github-actions --check returns a nonzero exit code for an incomplete workflow kit', async () => {
  const cwd = await createSetupReadyGitRepository();
  const initCli = new PullOpsCli({ cwd, stdout: createWritableBuffer() });
  const initExitCode = await initCli.run(['init']);

  assert.equal(initExitCode, 0);

  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({ cwd, stdout });
  const exitCode = await cli.run(['setup', 'github-actions', '--check', '--json']);

  assert.equal(exitCode, 1);

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'blocked');
  assert.equal(output.area, 'github-actions');
  assert.ok(output.changesNeeded.files.includes('.github/workflows/pullops-dispatch.yml'));
  assert.ok(output.changesNeeded.files.includes('.github/workflows/pullops-issue-implement.yml'));
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
  await writeFile(join(cwd, 'package.json'), '{"name":"demo","private":true,"type":"module"}\n');
  return cwd;
}

/**
 * @returns {Promise<string>}
 */
async function createSetupReadyGitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-cli-setup-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  await writeFile(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        name: 'demo',
        private: true,
        type: 'module',
        dependencies: {
          '@pull-ops/cli': '^0.1.0',
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(cwd, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'demo',
        lockfileVersion: 3,
      },
      null,
      2,
    )}\n`,
  );
  await installLocalPullOpsPackage({ cwd });

  await installLocalPullOpsExecutable({ cwd });

  return cwd;
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<void>}
 */
async function installLocalPullOpsPackage({ cwd }) {
  const packageRoot = join(cwd, 'node_modules', '@pull-ops', 'cli');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@pull-ops/cli',
        version: '0.1.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );

  const skillSourceRoot = join(REPO_ROOT, '.agents', 'skills');
  const skillEntries = await readdir(skillSourceRoot, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('pullops-')) {
      continue;
    }

    await cp(
      join(skillSourceRoot, entry.name),
      join(packageRoot, '.agents', 'skills', entry.name),
      {
        recursive: true,
      },
    );
  }

  await cp(
    join(REPO_ROOT, 'src', 'setup', 'agent-docs'),
    join(packageRoot, 'src', 'setup', 'agent-docs'),
    { recursive: true },
  );
  await writeFile(
    join(packageRoot, 'src', 'setup', 'pullopsSetupSkill.txt'),
    await readFile(join(REPO_ROOT, 'src', 'setup', 'pullopsSetupSkill.txt'), 'utf8'),
  );
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<void>}
 */
async function installLocalPullOpsExecutable({ cwd }) {
  const executablePath = join(cwd, 'node_modules', '.bin', 'pullops');
  await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true });
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
  await chmod(executablePath, 0o755);
}
