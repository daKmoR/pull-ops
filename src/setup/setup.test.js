import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { OPERATION_LABEL_REFERENCES, WORKFLOW_OPERATIONS } from '../operations/operations.js';
import { runPullOpsInit } from './init.js';
import {
  runPullOpsSetupAgentDocs,
  runPullOpsSetupDoctor,
  runPullOpsSetupGitHubActions,
  runPullOpsSetupSkills,
} from './setup.js';

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = '.pullops/install-manifest.json';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOCAL_SETUP_SKILL_SENTINEL = '# Local package pullops-setup sentinel\n';
const LOCAL_REVIEW_SKILL_SENTINEL = '# Local package pullops-pr-review sentinel\n';
const LOCAL_TRIAGE_DOC_SENTINEL = '# Local package triage labels sentinel\nneeds-triage\n';
const LOCAL_DOMAIN_DOC_SENTINEL = '# Local package domain sentinel\nUse CONTEXT.md\n';

describe('setup doctor', () => {
  it('01: reports local setup work and .pullops/runs warnings for the local profile', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'local' });

    assert.equal(result.status, 'changes-needed');
    assert.equal(result.area, 'setup-doctor');
    assert.match(result.summary, /local profile/);
    assert.ok(result.changesNeeded.includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(!result.changesNeeded.includes('docs/agents/issue-tracker.md'));
    assert.match(joinMessages(result.warnings), /Add \.pullops\/runs\/ to \.gitignore/);
    assert.doesNotMatch(joinMessages(result.warnings), /Missing optional authoring skills/);
    assert.deepEqual(result.blockers, []);
  });

  it('02: reports compatible agent docs and optional authoring warnings for the authoring profile', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'authoring' });

    assert.equal(result.status, 'changes-needed');
    assert.equal(result.area, 'setup-doctor');
    assert.match(result.summary, /authoring profile/);
    assert.ok(result.changesNeeded.includes('docs/agents/issue-tracker.md'));
    assert.ok(result.changesNeeded.includes('docs/agents/triage-labels.md'));
    assert.ok(result.changesNeeded.includes('docs/agents/domain.md'));
    assert.match(
      joinMessages(result.warnings),
      /Missing optional authoring skills: to-prd, to-issues\./,
    );
    assert.match(joinMessages(result.warnings), /npx skills@latest add mattpocock\/skills/);
    assert.match(joinMessages(result.warnings), /Add \.pullops\/runs\/ to \.gitignore/);
    assert.deepEqual(result.blockers, []);
  });

  it('03: blocks when the local package lock or local PullOps dependency is missing', async () => {
    const cwd = await createSetupRepository({
      includeLocalDependency: false,
      includePackageLock: false,
    });
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'local' });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'setup-doctor');
    assert.deepEqual(result.changesNeeded, []);
    assert.match(
      joinMessages(result.blockers),
      /Missing package-lock\.json required for npm ci and the local PullOps dependency\./,
    );
    assert.match(
      joinMessages(result.blockers),
      /Missing local PullOps dependency @pull-ops\/cli in package\.json\./,
    );
  });

  it('04: blocks when the local PullOps executable is not installed', async () => {
    const cwd = await createSetupRepository({ includeLocalExecutable: false });
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'local' });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'setup-doctor');
    assert.match(
      joinMessages(result.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );
    assert.match(joinMessages(result.suggestions), /Run npm ci before rerunning PullOps setup\./);
  });

  it('05: blocks the full profile for unowned bundled skill files while preserving target-owned agent docs', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, 'docs', 'agents'), { recursive: true });
    await writeFile(
      join(cwd, 'docs', 'agents', 'issue-tracker.md'),
      '# Existing target-owned issue tracker doc\n',
    );
    await mkdir(join(cwd, '.agents', 'skills', 'pullops-pr-review'), { recursive: true });
    await writeFile(
      join(cwd, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'),
      '# Existing unowned review skill\n',
    );

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'full' });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'setup-doctor');
    assert.ok(!result.changesNeeded.includes('docs/agents/issue-tracker.md'));
    assert.match(
      joinMessages(result.blockers),
      /Existing file \.agents\/skills\/pullops-pr-review\/SKILL\.md is not manifest-owned yet\./,
    );
  });
});

describe('setup skills', () => {
  it('01: installs bundled PullOps skills from the target local package and protects manifest-owned updates', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const dryRun = await runPullOpsSetupSkills({ cwd, check: true });
    assert.equal(dryRun.status, 'changes-needed');
    assert.equal(dryRun.area, 'setup-skills');
    assert.ok(dryRun.changesNeeded.includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(dryRun.changesNeeded.includes(MANIFEST_PATH));
    assert.deepEqual(dryRun.changes, []);
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'ready');
    assert.equal(applied.area, 'setup-skills');
    assert.ok(applied.changes.includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(applied.changes.includes(MANIFEST_PATH));

    const setupSkillText = await readFile(
      join(cwd, '.agents', 'skills', 'pullops-setup', 'SKILL.md'),
      'utf8',
    );
    const reviewSkillText = await readFile(
      join(cwd, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'),
      'utf8',
    );
    assert.equal(setupSkillText, LOCAL_SETUP_SKILL_SENTINEL);
    assert.equal(reviewSkillText, LOCAL_REVIEW_SKILL_SENTINEL);

    const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(
      manifest.files.some(entry => entry.path === '.agents/skills/pullops-pr-review/SKILL.md'),
    );

    await writeFile(join(cwd, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'), 'modified\n');

    const blocked = await runPullOpsSetupSkills({ cwd });
    assert.equal(blocked.status, 'blocked');
    assert.match(joinMessages(blocked.blockers), /pullops-pr-review\/SKILL\.md/);
  });

  it('02: blocks dry-run and apply when the local PullOps executable is missing', async () => {
    const cwd = await createSetupRepository({ includeLocalExecutable: false });
    await runPullOpsInit({ cwd });

    const dryRun = await runPullOpsSetupSkills({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.deepEqual(dryRun.changesNeeded, []);
    assert.match(
      joinMessages(dryRun.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.deepEqual(applied.changes, []);
    assert.match(
      joinMessages(applied.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );
  });

  it('03: blocks dry-run and apply when a bundled PullOps skill already exists outside the manifest', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, '.agents', 'skills', 'pullops-pr-review'), { recursive: true });
    await writeFile(
      join(cwd, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'),
      '# Existing unowned review skill\n',
    );

    const dryRun = await runPullOpsSetupSkills({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.ok(dryRun.changesNeeded.includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.match(
      joinMessages(dryRun.blockers),
      /Existing file \.agents\/skills\/pullops-pr-review\/SKILL\.md is not manifest-owned yet\./,
    );

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.ok(applied.changesNeeded.includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.match(
      joinMessages(applied.blockers),
      /Existing file \.agents\/skills\/pullops-pr-review\/SKILL\.md is not manifest-owned yet\./,
    );
  });
});

describe('setup agent docs', () => {
  it('01: skips target-owned docs, creates missing compatible docs from the target local package, and protects managed updates', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, 'docs', 'agents'), { recursive: true });
    await writeFile(
      join(cwd, 'docs', 'agents', 'issue-tracker.md'),
      '# Existing target-owned issue tracker doc\n',
    );

    const dryRun = await runPullOpsSetupAgentDocs({ cwd, check: true });
    assert.equal(dryRun.status, 'changes-needed');
    assert.equal(dryRun.area, 'setup-agent-docs');
    assert.ok(!dryRun.changesNeeded.includes('docs/agents/issue-tracker.md'));
    assert.ok(dryRun.changesNeeded.includes('docs/agents/triage-labels.md'));
    assert.ok(dryRun.changesNeeded.includes('docs/agents/domain.md'));
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(applied.status, 'ready');
    assert.equal(applied.area, 'setup-agent-docs');
    assert.ok(!applied.changes.includes('docs/agents/issue-tracker.md'));
    assert.ok(applied.changes.includes('docs/agents/triage-labels.md'));
    assert.ok(applied.changes.includes('docs/agents/domain.md'));
    assert.ok(applied.changes.includes(MANIFEST_PATH));

    const issueTrackerText = await readFile(
      join(cwd, 'docs', 'agents', 'issue-tracker.md'),
      'utf8',
    );
    const triageLabelsText = await readFile(
      join(cwd, 'docs', 'agents', 'triage-labels.md'),
      'utf8',
    );
    const domainText = await readFile(join(cwd, 'docs', 'agents', 'domain.md'), 'utf8');
    const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');

    assert.equal(issueTrackerText, '# Existing target-owned issue tracker doc\n');
    assert.equal(triageLabelsText, LOCAL_TRIAGE_DOC_SENTINEL);
    assert.equal(domainText, LOCAL_DOMAIN_DOC_SENTINEL);
    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(!manifest.files.some(entry => entry.path === 'docs/agents/issue-tracker.md'));
    assert.ok(manifest.files.some(entry => entry.path === 'docs/agents/triage-labels.md'));

    await writeFile(
      join(cwd, 'docs', 'agents', 'triage-labels.md'),
      `${triageLabelsText}\nlocal edit\n`,
    );

    const blocked = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(blocked.status, 'blocked');
    assert.match(joinMessages(blocked.blockers), /triage-labels\.md/);
  });

  it('02: blocks dry-run and apply when the local PullOps executable is missing', async () => {
    const cwd = await createSetupRepository({ includeLocalExecutable: false });
    await runPullOpsInit({ cwd });

    const dryRun = await runPullOpsSetupAgentDocs({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.deepEqual(dryRun.changesNeeded, []);
    assert.match(
      joinMessages(dryRun.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );

    const applied = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.deepEqual(applied.changes, []);
    assert.match(
      joinMessages(applied.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );
  });
});

describe('setup github-actions', () => {
  it('01: installs the workflow kit from the target local package and leaves non-PullOps workflows alone', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    const customWorkflowPath = join(cwd, '.github', 'workflows', 'custom.yml');
    await writeFile(customWorkflowPath, 'name: Custom Workflow\n');

    const dryRun = await runPullOpsSetupGitHubActions({ cwd, check: true });
    assert.equal(dryRun.status, 'changes-needed');
    assert.equal(dryRun.area, 'setup-github-actions');

    const expectedWorkflowPaths = [
      join('.github', 'workflows', 'pullops-dispatch.yml'),
      ...WORKFLOW_OPERATIONS.map(operation =>
        join('.github', 'workflows', `pullops-${operation.name}.yml`),
      ),
    ];

    assert.deepEqual(
      [...dryRun.changesNeeded].sort(),
      [...expectedWorkflowPaths, MANIFEST_PATH].sort(),
    );
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupGitHubActions({ cwd });
    assert.equal(applied.status, 'ready');
    assert.equal(applied.area, 'setup-github-actions');
    assert.deepEqual([...applied.changes].sort(), [...expectedWorkflowPaths, MANIFEST_PATH].sort());

    const dispatchWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-dispatch.yml'),
      'utf8',
    );
    const prdPrepareWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-prd-prepare.yml'),
      'utf8',
    );
    const issueImplementWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-issue-implement.yml'),
      'utf8',
    );
    const prCloseChildIssueWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-pr-close-child-issue.yml'),
      'utf8',
    );
    const customWorkflowText = await readFile(customWorkflowPath, 'utf8');
    const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');

    const actualDispatchRoutes = [...dispatchWorkflowText.matchAll(/'([^']+)': '([^']+\.yml)'/g)]
      .map(([, labelName, workflowPath]) => [labelName, workflowPath])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
    const expectedDispatchRoutes = OPERATION_LABEL_REFERENCES.map(operation => [
      operation.label,
      `pullops-${operation.workflowOperationName}.yml`,
    ]).sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

    assert.deepEqual(actualDispatchRoutes, expectedDispatchRoutes);
    assert.ok(
      !actualDispatchRoutes.some(
        ([, workflowPath]) => workflowPath === 'pullops-pr-close-child-issue.yml',
      ),
    );
    assert.match(prdPrepareWorkflowText, /node-version: 22/);
    assert.match(prdPrepareWorkflowText, /npm exec pullops -- run prd-prepare/);
    assert.match(issueImplementWorkflowText, /node-version: 22/);
    assert.match(issueImplementWorkflowText, /npm exec pullops -- run issue-implement/);
    assert.match(prCloseChildIssueWorkflowText, /node-version: 22/);
    assert.match(prCloseChildIssueWorkflowText, /npm exec pullops -- run pr-close-child-issue/);
    assert.equal(customWorkflowText, 'name: Custom Workflow\n');
    assert.match(customWorkflowText, /Custom Workflow/);

    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(
      manifest.files.some(entry => entry.path === '.github/workflows/pullops-dispatch.yml'),
    );
    assert.ok(
      manifest.files.some(
        entry => entry.path === '.github/workflows/pullops-pr-close-child-issue.yml',
      ),
    );
    assert.ok(!manifest.files.some(entry => entry.path === '.github/workflows/custom.yml'));
  });

  it('02: blocks when repository context is unavailable for secret inspection', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'github-actions' });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'setup-doctor');
    assert.match(
      joinMessages(result.blockers),
      /GitHub Actions readiness requires a GitHub remote or explicit repository context\./,
    );
    assert.ok(result.changesNeeded.includes('.github/workflows/pullops-dispatch.yml'));
  });

  it('03: reports missing repository Actions secrets as warnings when they are visible', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN'],
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'setup-doctor');
    assert.deepEqual(result.blockers, []);
    assert.match(
      joinMessages(result.warnings),
      /Missing repository Actions secrets: OPENAI_API_KEY\./,
    );
  });

  it('04: warns when repository Actions secrets cannot be inspected', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readRepositoryActionsSecretNames: async () => {
        throw new Error('repository secrets are hidden');
      },
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'setup-doctor');
    assert.deepEqual(result.blockers, []);
    assert.match(
      joinMessages(result.warnings),
      /Unable to inspect repository Actions secrets: repository secrets are hidden/,
    );
  });
});

describe('package files', () => {
  it('01: includes setup agent-doc templates in npm pack dry-run output', async () => {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: REPO_ROOT },
    );
    /** @type {import('./setup.test.types.js').NpmPackDryRunResult} */
    const packResult = JSON.parse(stdout);
    assert.equal(packResult.length, 1);
    const packedPaths = packResult[0].files.map(file => file.path);

    assert.ok(packedPaths.includes('src/setup/agent-docs/issue-tracker.md'));
    assert.ok(packedPaths.includes('src/setup/agent-docs/triage-labels.md'));
    assert.ok(packedPaths.includes('src/setup/agent-docs/domain.md'));
    assert.ok(packedPaths.includes('.github/workflows/pullops-dispatch.yml'));
    for (const operation of WORKFLOW_OPERATIONS) {
      assert.ok(packedPaths.includes(`.github/workflows/pullops-${operation.name}.yml`));
    }
  });
});

/**
 * @returns {Promise<string>}
 */
async function createSetupRepository({
  includeLocalDependency = true,
  includePackageLock = true,
  includeLocalExecutable = true,
  includeGitHubRemote = false,
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-setup-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  /** @type {{ name: string, private: boolean, type: 'module', dependencies?: Record<string, string> }} */
  const packageJson = {
    name: 'demo-target',
    private: true,
    type: 'module',
  };
  if (includeLocalDependency) {
    packageJson.dependencies = {
      '@pull-ops/cli': '^0.1.0',
    };
  }
  await writeFile(join(cwd, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  if (includeGitHubRemote) {
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd,
    });
  }
  if (includePackageLock) {
    await writeFile(
      join(cwd, 'package-lock.json'),
      `${JSON.stringify(
        {
          name: 'demo-target',
          lockfileVersion: 3,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (includeLocalDependency) {
    await installLocalPullOpsPackage({ cwd });
  }
  if (includeLocalExecutable) {
    await installLocalPullOpsExecutable({ cwd });
  }
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

  await cp(join(REPO_ROOT, '.github', 'workflows'), join(packageRoot, '.github', 'workflows'), {
    recursive: true,
  });

  await mkdir(join(packageRoot, 'src', 'setup', 'agent-docs'), { recursive: true });
  await cp(
    join(REPO_ROOT, 'src', 'setup', 'agent-docs'),
    join(packageRoot, 'src', 'setup', 'agent-docs'),
    { recursive: true },
  );
  await writeFile(
    join(packageRoot, 'src', 'setup', 'pullopsSetupSkill.txt'),
    LOCAL_SETUP_SKILL_SENTINEL,
  );
  await writeFile(
    join(packageRoot, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'),
    LOCAL_REVIEW_SKILL_SENTINEL,
  );
  await writeFile(
    join(packageRoot, 'src', 'setup', 'agent-docs', 'triage-labels.md'),
    LOCAL_TRIAGE_DOC_SENTINEL,
  );
  await writeFile(
    join(packageRoot, 'src', 'setup', 'agent-docs', 'domain.md'),
    LOCAL_DOMAIN_DOC_SENTINEL,
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

/**
 * @param {string[]} messages
 * @returns {string}
 */
function joinMessages(messages) {
  return messages.join('\n');
}
