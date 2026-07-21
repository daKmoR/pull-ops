import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const tempRoot = await mkdtemp(join(tmpdir(), 'pullops-package-smoke-'));
const npmCache = process.env.PULLOPS_SMOKE_NPM_CACHE ?? join(tempRoot, 'npm-cache');

try {
  const packageDirectory = join(tempRoot, 'package');
  await mkdir(packageDirectory, { recursive: true });
  const packResult = await run({
    command: 'npm',
    args: ['pack', '--ignore-scripts', '--json', '--pack-destination', packageDirectory],
    cwd: REPO_ROOT,
  });
  const packedPackages = JSON.parse(packResult.stdout);
  assert.equal(packedPackages.length, 1);
  const tarballPath = join(packageDirectory, packedPackages[0].filename);

  await verifyConsumer({ tarballPath });

  process.stdout.write('Packaged PullOps smoke test passed for an ES module repository.\n');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

/**
 * @param {{ tarballPath: string }} options
 * @returns {Promise<void>}
 */
async function verifyConsumer({ tarballPath }) {
  const cwd = join(tempRoot, 'consumer-module');
  await mkdir(cwd, { recursive: true });
  await run({ command: 'git', args: ['init', '--initial-branch=main'], cwd });
  await writeFile(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pullops-module-smoke',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  await run({
    command: 'npm',
    args: ['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    cwd,
  });

  const executable = join(cwd, 'node_modules', '.bin', 'pullops');
  const initialized = await runJson({ executable, args: ['init', '--json'], cwd });
  assert.equal(initialized.status, 'changed');
  assert.ok(initialized.changes.files.includes('pullops.config.js'));
  assert.ok(initialized.changes.files.includes('.gitignore'));

  const skills = await runJson({ executable, args: ['setup', 'skills', '--json'], cwd });
  assert.equal(skills.status, 'changed');
  const agentDocs = await runJson({
    executable,
    args: ['setup', 'agent-docs', '--json'],
    cwd,
  });
  assert.equal(agentDocs.status, 'changed');
  const doctor = await runJson({
    executable,
    args: ['setup', 'doctor', '--profile', 'authoring', '--json'],
    cwd,
  });
  assert.equal(doctor.status, 'ready');
  assert.doesNotMatch(doctor.warnings.join('\n'), /\.pullops\/runs/);

  const config = await readFile(join(cwd, 'pullops.config.js'), 'utf8');
  assert.match(config, /provider: 'github'/);
  await run({
    command: 'git',
    args: ['check-ignore', '--quiet', '--no-index', '.pullops/runs/release-smoke/state.json'],
    cwd,
  });

  const checked = await runJson({ executable, args: ['init', '--check', '--json'], cwd });
  assert.equal(checked.status, 'ready');
}

/**
 * @param {{ executable: string, args: string[], cwd: string }} options
 * @returns {Promise<Record<string, any>>}
 */
async function runJson({ executable, args, cwd }) {
  const result = await run({ command: executable, args, cwd });
  return JSON.parse(result.stdout);
}

/**
 * @param {{ command: string, args: string[], cwd: string }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function run({ command, args, cwd }) {
  return await execFileAsync(command, args, {
    cwd,
    env: { ...process.env, npm_config_cache: npmCache },
  });
}
