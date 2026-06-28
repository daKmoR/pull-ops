import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runPullOpsInit } from './init.js';

const execFileAsync = promisify(execFile);
const CONFIG_PATH = 'pullops.config.js';
const MANIFEST_PATH = '.pullops/install-manifest.json';
const SKILL_PATH = '.agents/skills/pullops-setup/SKILL.md';

test('init creates the setup entry point and records manifest hashes', async () => {
  const cwd = await createGitRepository();

  const result = await runPullOpsInit({ cwd });

  assert.equal(result.status, 'ready');
  assert.equal(result.area, 'setup-entry');
  assert.deepEqual([...result.changes].sort(), [CONFIG_PATH, MANIFEST_PATH, SKILL_PATH].sort());
  assert.deepEqual(result.changesNeeded, []);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.suggestions, []);

  const configText = await readFile(join(cwd, CONFIG_PATH), 'utf8');
  const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
  const skillText = await readFile(join(cwd, SKILL_PATH), 'utf8');

  assert.match(configText, /PullOpsConfig/);
  assert.match(configText, /"provider": "github"/);
  assert.doesNotMatch(configText, /escalationModelTier/);
  assert.doesNotMatch(configText, /humanFeedbackResponseModelTier/);
  assert.match(skillText, /# PullOps Setup Skill/);
  assert.match(skillText, /pullops setup doctor --profile full --json/);
  assert.match(skillText, /pullops setup skills --check --json/);
  assert.match(skillText, /pullops setup agent-docs --check --json/);
  assert.match(skillText, /pullops setup github-actions --check --json/);
  assert.match(skillText, /pullops setup doctor --profile github-actions --json/);
  assert.match(
    skillText,
    /Do not invoke `setup-matt-pocock-skills` or any remote skill package installer\./,
  );

  /** @type {import('./init.types.js').PullOpsInstallManifest} */
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'pullops-install-manifest');
  assert.equal(manifest.hashAlgorithm, 'sha256');
  assert.deepEqual(
    manifest.files.map(file => file.path),
    [CONFIG_PATH, SKILL_PATH],
  );

  const configEntry = manifest.files.find(file => file.path === CONFIG_PATH);
  const skillEntry = manifest.files.find(file => file.path === SKILL_PATH);
  assert.ok(configEntry);
  assert.ok(skillEntry);
  assert.equal(configEntry.hash, hash(configText));
  assert.equal(skillEntry.hash, hash(skillText));
});

test('init --check reports missing starter artifacts without writing them', async () => {
  const cwd = await createGitRepository();

  const result = await runPullOpsInit({ cwd, check: true });

  assert.equal(result.status, 'changes-needed');
  assert.equal(result.area, 'setup-entry');
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.suggestions, ['Run PullOps init to create the missing files.']);
  assert.deepEqual(
    [...result.changesNeeded].sort(),
    [CONFIG_PATH, MANIFEST_PATH, SKILL_PATH].sort(),
  );

  await assert.rejects(readFile(join(cwd, CONFIG_PATH), 'utf8'));
  await assert.rejects(readFile(join(cwd, MANIFEST_PATH), 'utf8'));
  await assert.rejects(readFile(join(cwd, SKILL_PATH), 'utf8'));
});

test('init blocks modified generated files unless the manifest owns them and force is given', async () => {
  const ownedRepo = await createGitRepository();
  await runPullOpsInit({ cwd: ownedRepo });
  await writeFile(
    join(ownedRepo, CONFIG_PATH),
    'export default { issueStore: { provider: "github" } };\n',
  );

  const blocked = await runPullOpsInit({ cwd: ownedRepo });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blockers[0], /PullOps-owned file pullops\.config\.js/);
  assert.match(await readFile(join(ownedRepo, CONFIG_PATH), 'utf8'), /export default/);

  const forced = await runPullOpsInit({ cwd: ownedRepo, force: true });
  assert.equal(forced.status, 'ready');
  assert.deepEqual([...forced.changes].sort(), [CONFIG_PATH].sort());
  assert.match(await readFile(join(ownedRepo, CONFIG_PATH), 'utf8'), /PullOpsConfig/);

  const unownedRepo = await createGitRepository();
  await writeFile(join(unownedRepo, CONFIG_PATH), 'export default { custom: true };\n');

  const forceBlocked = await runPullOpsInit({ cwd: unownedRepo, force: true });
  assert.equal(forceBlocked.status, 'blocked');
  assert.match(forceBlocked.blockers[0], /not manifest-owned yet/);
  assert.match(await readFile(join(unownedRepo, CONFIG_PATH), 'utf8'), /custom: true/);
});

test('init refreshes unchanged manifest-owned starter files without force', async () => {
  const cwd = await createGitRepository();
  const generatedConfigText = 'export default { baseBranch: "trunk" };\n';
  const generatedSkillText = '# PullOps Setup Skill\n\nLegacy starter.\n';
  const extraManifestEntry = { path: '.pullops/workflow-kit.txt', hash: 'preserved-hash' };

  await writeFile(join(cwd, CONFIG_PATH), generatedConfigText);
  await mkdir(join(cwd, '.agents', 'skills', 'pullops-setup'), { recursive: true });
  await writeFile(join(cwd, SKILL_PATH), generatedSkillText);
  await mkdir(join(cwd, '.pullops'), { recursive: true });
  await writeFile(
    join(cwd, MANIFEST_PATH),
    buildManifest([
      { path: CONFIG_PATH, hash: hash(generatedConfigText) },
      { path: SKILL_PATH, hash: hash(generatedSkillText) },
      extraManifestEntry,
    ]),
  );

  const result = await runPullOpsInit({ cwd });

  assert.equal(result.status, 'ready');
  assert.deepEqual([...result.changes].sort(), [CONFIG_PATH, MANIFEST_PATH, SKILL_PATH].sort());

  const configText = await readFile(join(cwd, CONFIG_PATH), 'utf8');
  const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
  assert.match(configText, /PullOpsConfig/);
  assert.doesNotMatch(configText, /escalationModelTier/);

  /** @type {import('./init.types.js').PullOpsInstallManifest} */
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(
    manifest.files.find(file => file.path === extraManifestEntry.path),
    extraManifestEntry,
  );
});

test('init blocks replacing an existing non-PullOps manifest', async () => {
  const cwd = await createGitRepository();
  const invalidManifest = '{\n  "custom": true\n}\n';
  await mkdir(join(cwd, '.pullops'), { recursive: true });
  await writeFile(join(cwd, MANIFEST_PATH), invalidManifest);

  const result = await runPullOpsInit({ cwd });

  assert.equal(result.status, 'blocked');
  assert.match(result.blockers[0], /valid PullOps install manifest/);
  assert.equal(await readFile(join(cwd, MANIFEST_PATH), 'utf8'), invalidManifest);
});

test('init refuses non-root execution, missing git repositories, and missing root manifests', async () => {
  const repo = await createGitRepository();
  const resultDir = join(repo, 'packages', 'widget');
  await mkdir(resultDir, { recursive: true });

  const nonRoot = await runPullOpsInit({ cwd: resultDir });
  assert.equal(nonRoot.status, 'blocked');
  assert.match(nonRoot.summary, /repository root/);
  assert.match(nonRoot.blockers[0], /repository root/);

  const nonGitCwd = await mkdtemp(join(tmpdir(), 'pullops-init-non-git-'));
  await writeFile(join(nonGitCwd, 'package.json'), '{"name":"demo"}\n');
  const nonGit = await runPullOpsInit({ cwd: nonGitCwd });
  assert.equal(nonGit.status, 'blocked');
  assert.match(nonGit.summary, /git repository/);

  const missingPackageRepo = await mkdtemp(join(tmpdir(), 'pullops-init-no-package-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: missingPackageRepo });
  const missingPackage = await runPullOpsInit({ cwd: missingPackageRepo });
  assert.equal(missingPackage.status, 'blocked');
  assert.match(missingPackage.summary, /package\.json/);
});

/**
 * @returns {Promise<string>}
 */
async function createGitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-init-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  await writeFile(join(cwd, 'package.json'), '{"name":"demo","private":true}\n');
  return cwd;
}

/**
 * @param {string} value
 * @returns {string}
 */
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {import('./init.types.js').PullOpsInstallManifest['files']} files
 * @returns {string}
 */
function buildManifest(files) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'pullops-install-manifest',
      hashAlgorithm: 'sha256',
      files,
    },
    null,
    2,
  )}\n`;
}
