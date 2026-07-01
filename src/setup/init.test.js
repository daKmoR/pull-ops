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

  assert.equal(result.status, 'changed');
  assert.equal(result.area, 'init');
  assert.deepEqual(
    [...changedFiles(result)].sort(),
    [CONFIG_PATH, MANIFEST_PATH, SKILL_PATH].sort(),
  );
  assert.deepEqual(result.changesNeeded, {});
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.suggestions, []);

  const configText = await readFile(join(cwd, CONFIG_PATH), 'utf8');
  const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
  const skillText = await readFile(join(cwd, SKILL_PATH), 'utf8');

  assert.match(configText, /PullOpsConfig/);
  assert.match(configText, /provider: 'github'/);
  assert.doesNotMatch(configText, /escalationModelTier/);
  assert.doesNotMatch(configText, /humanFeedbackResponseModelTier/);
  assert.match(skillText, /^---\nname: pullops-setup\n/);
  assert.match(skillText, /description: Setup and configure PullOps in the repository\./);
  assert.match(skillText, /disable-model-invocation: true/);
  assert.match(skillText, /# PullOps Setup Skill/);
  assert.match(skillText, /PullOps setup is a readiness loop/);
  assert.match(skillText, /Use this command form for every PullOps CLI command:/);
  assert.match(skillText, /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops <args>/);
  assert.match(skillText, /setup doctor --profile full --json/);
  assert.match(
    skillText,
    /Completion criterion: every blocker and warning is classified as local action, remote approval, external credential handoff, or external wait\./,
  );
  assert.match(skillText, /run the check command/);
  assert.match(skillText, /setup skills --check --json/);
  assert.match(skillText, /setup agent-docs --check --json/);
  assert.match(skillText, /setup github-actions --check --json/);
  assert.match(skillText, /setup github-labels --check --json/);
  assert.match(
    skillText,
    /Ask before applying `setup github-labels --json` because it mutates the remote repository\./,
  );
  assert.match(
    skillText,
    /pass `--repo OWNER\/REPO` or set `GITHUB_REPOSITORY=OWNER\/REPO` before running the GitHub label setup command\./,
  );
  assert.match(skillText, /setup doctor --profile github-actions --json/);
  assert.match(skillText, /setup doctor --profile full --json/);
  assert.match(
    skillText,
    /Do not invoke `setup-matt-pocock-skills` or any remote skill package installer\./,
  );
  assert.match(skillText, /## GitHub Authentication/);
  assert.match(skillText, /If a sandboxed Codex agent reports missing GitHub authentication/);
  assert.match(skillText, /include_only = \["GITHUB_TOKEN"\]/);
  assert.match(skillText, /Do not print tokens with `echo`/);
  assert.match(
    skillText,
    /Keep `\.pullops\/install-manifest\.json` synchronized only with PullOps-owned generated files[\s\S]*not with the target-owned `pullops\.config\.js`\./,
  );

  /** @type {import('./init.types.js').PullOpsInstallManifest} */
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'pullops-install-manifest');
  assert.equal(manifest.hashAlgorithm, 'sha256');
  assert.deepEqual(
    manifest.files.map(file => file.path),
    [SKILL_PATH],
  );

  const configEntry = manifest.files.find(file => file.path === CONFIG_PATH);
  const skillEntry = manifest.files.find(file => file.path === SKILL_PATH);
  assert.equal(configEntry, undefined);
  assert.ok(skillEntry);
  assert.equal(skillEntry.hash, hash(skillText));
});

test('init --check reports missing starter artifacts without writing them', async () => {
  const cwd = await createGitRepository();

  const result = await runPullOpsInit({ cwd, check: true });

  assert.equal(result.status, 'blocked');
  assert.equal(result.area, 'init');
  assert.deepEqual(result.changes, {});
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.suggestions, ['Run PullOps init to create the missing files.']);
  assert.deepEqual(
    [...neededFiles(result)].sort(),
    [CONFIG_PATH, MANIFEST_PATH, SKILL_PATH].sort(),
  );

  await assert.rejects(readFile(join(cwd, CONFIG_PATH), 'utf8'));
  await assert.rejects(readFile(join(cwd, MANIFEST_PATH), 'utf8'));
  await assert.rejects(readFile(join(cwd, SKILL_PATH), 'utf8'));
});

test('init preserves target-owned config and only force-overwrites manifest-owned files', async () => {
  const ownedRepo = await createGitRepository();
  const targetOwnedConfigText = 'export default { custom: true };\n';
  await writeFile(join(ownedRepo, CONFIG_PATH), targetOwnedConfigText);

  const initialized = await runPullOpsInit({ cwd: ownedRepo });
  assert.equal(initialized.status, 'changed');
  assert.equal(await readFile(join(ownedRepo, CONFIG_PATH), 'utf8'), targetOwnedConfigText);

  await writeFile(join(ownedRepo, SKILL_PATH), '# PullOps Setup Skill\n\nlocal edit\n');

  const blocked = await runPullOpsInit({ cwd: ownedRepo });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blockers[0], /pullops-setup\/SKILL\.md/);
  assert.equal(await readFile(join(ownedRepo, CONFIG_PATH), 'utf8'), targetOwnedConfigText);

  const forced = await runPullOpsInit({ cwd: ownedRepo, force: true });
  assert.equal(forced.status, 'changed');
  assert.deepEqual([...changedFiles(forced)].sort(), [SKILL_PATH].sort());
  assert.equal(await readFile(join(ownedRepo, CONFIG_PATH), 'utf8'), targetOwnedConfigText);
  assert.match(await readFile(join(ownedRepo, SKILL_PATH), 'utf8'), /# PullOps Setup Skill/);

  const unownedSkillRepo = await createGitRepository();
  await mkdir(join(unownedSkillRepo, '.agents', 'skills', 'pullops-setup'), { recursive: true });
  await writeFile(join(unownedSkillRepo, SKILL_PATH), '# Existing unowned setup skill\n');

  const forceBlocked = await runPullOpsInit({ cwd: unownedSkillRepo, force: true });
  assert.equal(forceBlocked.status, 'blocked');
  assert.match(forceBlocked.blockers[0], /not manifest-owned yet/);
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

  assert.equal(result.status, 'changed');
  assert.deepEqual([...changedFiles(result)].sort(), [MANIFEST_PATH, SKILL_PATH].sort());

  const configText = await readFile(join(cwd, CONFIG_PATH), 'utf8');
  const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
  assert.equal(configText, generatedConfigText);

  /** @type {import('./init.types.js').PullOpsInstallManifest} */
  const manifest = JSON.parse(manifestText);
  assert.equal(
    manifest.files.some(file => file.path === CONFIG_PATH),
    false,
  );
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

/**
 * @param {import('./init.types.js').PullOpsSetupResult} result
 * @returns {string[]}
 */
function changedFiles(result) {
  return result.changes.files ?? [];
}

/**
 * @param {import('./init.types.js').PullOpsSetupResult} result
 * @returns {string[]}
 */
function neededFiles(result) {
  return result.changesNeeded.files ?? [];
}
