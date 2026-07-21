import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  getOperationCatalogOperationLabelReferences,
  getOperationCatalogWorkflowFileName,
  getOperationCatalogWorkflowOperations,
} from '../operations/operationCatalog.js';
import {
  MISSING_GITHUB_AUTHENTICATION_BLOCKER,
  MISSING_GITHUB_AUTHENTICATION_SUGGESTION,
  PULL_OPS_LABELS,
  SANDBOXED_GITHUB_AUTHENTICATION_SUGGESTION,
  SECURE_GITHUB_AUTHENTICATION_SUGGESTION,
} from '../github/GitHubClient.js';
import { renderPullOpsGitHubActionsWorkflowFiles } from './githubActionsWorkflows.js';
import { runPullOpsInit } from './init.js';
import {
  runPullOpsSetupAgentDocs,
  runPullOpsSetupDoctor,
  runPullOpsSetupGitHubActions,
  runPullOpsSetupGitHubLabels,
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
  it('01: reports local setup work with Local Run Records already ignored', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'local',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(result.summary, /local profile/);
    assert.ok(neededFiles(result).includes('.agents/skills/pullops-setup/SKILL.md'));
    assert.ok(neededFiles(result).includes(MANIFEST_PATH));
    assert.ok(!neededFiles(result).includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(!neededFiles(result).includes('docs/agents/issue-tracker.md'));
    assert.doesNotMatch(joinMessages(result.warnings), /Add \.pullops\/runs\/ to \.gitignore/);
    assert.doesNotMatch(joinMessages(result.warnings), /Missing optional authoring skills/);
    assert.deepEqual(result.blockers, []);
  });

  it('02: reports compatible agent docs and optional authoring warnings for the authoring profile', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({ cwd, profile: 'authoring' });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(result.summary, /authoring profile/);
    assert.ok(neededFiles(result).includes('docs/agents/pullops-cli.md'));
    assert.ok(neededFiles(result).includes('docs/agents/issue-tracker.md'));
    assert.ok(neededFiles(result).includes('docs/agents/triage-labels.md'));
    assert.ok(neededFiles(result).includes('docs/agents/domain.md'));
    assert.match(
      joinMessages(result.warnings),
      /Missing optional authoring skills: to-spec, to-tickets\./,
    );
    assert.doesNotMatch(joinMessages(result.warnings), /npx skills@latest add mattpocock\/skills/);
    assert.ok(result.suggestions.includes('npx skills@latest add mattpocock/skills'));
    assert.doesNotMatch(joinMessages(result.warnings), /Add \.pullops\/runs\/ to \.gitignore/);
    assert.deepEqual(result.blockers, []);
  });

  it('03: does not block the local profile for a missing package lock, but still blocks a missing local PullOps dependency', async () => {
    const cwd = await createSetupRepository({
      includeLocalDependency: false,
      includePackageLock: false,
    });
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'local',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.changesNeeded, {});
    assert.doesNotMatch(joinMessages(result.blockers), /package-lock\.json/);
    assert.match(
      joinMessages(result.blockers),
      /Missing local PullOps dependency @pull-ops\/cli in package\.json\./,
    );
  });

  it('04: blocks when the local PullOps executable is not installed', async () => {
    const cwd = await createSetupRepository({ includeLocalExecutable: false });
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'local',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(
      joinMessages(result.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );
    assert.match(joinMessages(result.suggestions), /Run npm ci before rerunning PullOps setup\./);
  });

  it('05: treats the PullOps source package as its local package for setup prereqs', async () => {
    const cwd = await createPullOpsSourceRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'local',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.doesNotMatch(
      joinMessages(result.suggestions),
      /Run npm ci before rerunning PullOps setup\./,
    );
  });

  it('05b: blocks local readiness when GitHub API authentication is unavailable', async () => {
    const cwd = await createPullOpsSourceRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'local',
      readGitHubAuthToken() {
        return undefined;
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(
      joinMessages(result.blockers),
      /GitHub API authentication is required\. PullOps does not make unauthenticated GitHub API requests\./,
    );
    assert.match(
      joinMessages(result.suggestions),
      /Set PULLOPS_GITHUB_TOKEN or GITHUB_TOKEN, or run gh auth login and ensure gh is on PATH/,
    );
    assert.match(
      joinMessages(result.suggestions),
      /For Codex sandboxes, make GITHUB_TOKEN available to the host shell/,
    );
    assert.match(joinMessages(result.suggestions), /Do not print GitHub tokens with echo/);
  });

  it('06: blocks the full profile for unowned bundled skill files while preserving target-owned agent docs', async () => {
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

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'full',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.ok(!neededFiles(result).includes('docs/agents/issue-tracker.md'));
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
    assert.equal(dryRun.status, 'blocked');
    assert.equal(dryRun.area, 'skills');
    assert.ok(neededFiles(dryRun).includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(neededFiles(dryRun).includes(MANIFEST_PATH));
    assert.deepEqual(dryRun.changes, {});
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'changed');
    assert.equal(applied.area, 'skills');
    assert.ok(changedFiles(applied).includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.ok(changedFiles(applied).includes(MANIFEST_PATH));

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
    assert.deepEqual(dryRun.changesNeeded, {});
    assert.match(
      joinMessages(dryRun.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.deepEqual(applied.changes, {});
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
    assert.ok(neededFiles(dryRun).includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.match(
      joinMessages(dryRun.blockers),
      /Existing file \.agents\/skills\/pullops-pr-review\/SKILL\.md is not manifest-owned yet\./,
    );

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.ok(neededFiles(applied).includes('.agents/skills/pullops-pr-review/SKILL.md'));
    assert.match(
      joinMessages(applied.blockers),
      /Existing file \.agents\/skills\/pullops-pr-review\/SKILL\.md is not manifest-owned yet\./,
    );
  });

  it('04: adopts matching bundled skills from the PullOps source package without local node_modules', async () => {
    const cwd = await createPullOpsSourceRepository();
    await runPullOpsInit({ cwd });
    await installPullOpsSourceSkillDirectories({ cwd });

    const dryRun = await runPullOpsSetupSkills({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.equal(dryRun.area, 'skills');
    assert.deepEqual(dryRun.blockers, []);
    assert.ok(neededFiles(dryRun).includes(MANIFEST_PATH));

    const applied = await runPullOpsSetupSkills({ cwd });
    assert.equal(applied.status, 'changed');
    assert.equal(applied.area, 'skills');
    assert.deepEqual(applied.blockers, []);
    assert.deepEqual(applied.warnings, []);
    assert.ok(changedFiles(applied).includes(MANIFEST_PATH));

    const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');
    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(
      manifest.files.some(entry => entry.path === '.agents/skills/pullops-pr-review/SKILL.md'),
    );
  });
});

describe('setup agent docs', () => {
  it('01: skips target-owned docs, creates missing compatible docs from the target local package, and protects managed updates', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, 'docs', 'agents'), { recursive: true });
    await writeFile(
      join(cwd, 'docs', 'agents', 'domain.md'),
      '# Existing target-owned domain doc\n',
    );

    const dryRun = await runPullOpsSetupAgentDocs({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.equal(dryRun.area, 'agent-docs');
    assert.ok(neededFiles(dryRun).includes('docs/agents/pullops-cli.md'));
    assert.ok(neededFiles(dryRun).includes('docs/agents/issue-tracker.md'));
    assert.ok(neededFiles(dryRun).includes('docs/agents/triage-labels.md'));
    assert.ok(!neededFiles(dryRun).includes('docs/agents/domain.md'));
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(applied.status, 'changed');
    assert.equal(applied.area, 'agent-docs');
    assert.ok(changedFiles(applied).includes('docs/agents/pullops-cli.md'));
    assert.ok(changedFiles(applied).includes('docs/agents/issue-tracker.md'));
    assert.ok(changedFiles(applied).includes('docs/agents/triage-labels.md'));
    assert.ok(!changedFiles(applied).includes('docs/agents/domain.md'));
    assert.ok(!changedFiles(applied).includes(MANIFEST_PATH));

    const pullOpsCliText = await readFile(join(cwd, 'docs', 'agents', 'pullops-cli.md'), 'utf8');
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

    assert.match(
      pullOpsCliText,
      /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops <args>/,
    );
    assert.match(issueTrackerText, /Blocked by: #<issue>/);
    assert.match(issueTrackerText, /GitHub native sub-issues/);
    assert.match(issueTrackerText, /ready-for-agent/);
    assert.equal(triageLabelsText, LOCAL_TRIAGE_DOC_SENTINEL);
    assert.equal(domainText, '# Existing target-owned domain doc\n');
    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(!manifest.files.some(entry => entry.path === 'docs/agents/pullops-cli.md'));
    assert.ok(!manifest.files.some(entry => entry.path === 'docs/agents/issue-tracker.md'));
    assert.ok(!manifest.files.some(entry => entry.path === 'docs/agents/triage-labels.md'));
    assert.ok(!manifest.files.some(entry => entry.path === 'docs/agents/domain.md'));

    await writeFile(
      join(cwd, 'docs', 'agents', 'triage-labels.md'),
      `${triageLabelsText}\nlocal edit\n`,
    );

    const rerun = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(rerun.status, 'ready');
    assert.deepEqual(rerun.changes, {});
  });

  it('02: blocks dry-run and apply when the local PullOps executable is missing', async () => {
    const cwd = await createSetupRepository({ includeLocalExecutable: false });
    await runPullOpsInit({ cwd });

    const dryRun = await runPullOpsSetupAgentDocs({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.deepEqual(dryRun.changesNeeded, {});
    assert.match(
      joinMessages(dryRun.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );

    const applied = await runPullOpsSetupAgentDocs({ cwd });
    assert.equal(applied.status, 'blocked');
    assert.deepEqual(applied.changes, {});
    assert.match(
      joinMessages(applied.blockers),
      /Missing local PullOps executable node_modules\/\.bin\/pullops\./,
    );
  });
});

describe('setup github-actions', () => {
  it('01: installs the workflow kit from the source generator and leaves non-PullOps workflows alone', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    const customWorkflowPath = join(cwd, '.github', 'workflows', 'custom.yml');
    await writeFile(customWorkflowPath, 'name: Custom Workflow\n');

    const dryRun = await runPullOpsSetupGitHubActions({ cwd, check: true });
    assert.equal(dryRun.status, 'blocked');
    assert.equal(dryRun.area, 'github-actions');

    const expectedWorkflowPaths = [
      join('.github', 'workflows', 'pullops-dispatch.yml'),
      ...getOperationCatalogWorkflowOperations().map(operation =>
        join(
          '.github',
          'workflows',
          getOperationCatalogWorkflowFileName(operation.name) ?? `pullops-${operation.name}.yml`,
        ),
      ),
    ];

    assert.deepEqual(
      [...neededFiles(dryRun)].sort(),
      [...expectedWorkflowPaths, MANIFEST_PATH].sort(),
    );
    assert.deepEqual(dryRun.blockers, []);

    const applied = await runPullOpsSetupGitHubActions({ cwd });
    assert.equal(applied.status, 'changed');
    assert.equal(applied.area, 'github-actions');
    assert.deepEqual(
      [...changedFiles(applied)].sort(),
      [...expectedWorkflowPaths, MANIFEST_PATH].sort(),
    );

    const dispatchWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-dispatch.yml'),
      'utf8',
    );
    const specPrepareWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-spec-prepare.yml'),
      'utf8',
    );
    const issueImplementWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-issue-implement.yml'),
      'utf8',
    );
    const prCloseTicketWorkflowText = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-pr-close-ticket.yml'),
      'utf8',
    );
    const customWorkflowText = await readFile(customWorkflowPath, 'utf8');
    const manifestText = await readFile(join(cwd, MANIFEST_PATH), 'utf8');

    for (const workflowPath of expectedWorkflowPaths) {
      assert.equal(
        await readFile(join(cwd, workflowPath), 'utf8'),
        await readFile(join(REPO_ROOT, workflowPath), 'utf8'),
      );
    }

    const actualDispatchRoutes = [...dispatchWorkflowText.matchAll(/'([^']+)': '([^']+\.yml)'/g)]
      .map(([, labelName, workflowPath]) => [labelName, workflowPath])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
    const expectedDispatchRoutes = getOperationCatalogOperationLabelReferences()
      .map(operation => [
        operation.label,
        getOperationCatalogWorkflowFileName(operation.workflowOperationName) ??
          `pullops-${operation.workflowOperationName}.yml`,
      ])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

    assert.deepEqual(actualDispatchRoutes, expectedDispatchRoutes);
    assert.ok(
      !actualDispatchRoutes.some(
        ([, workflowPath]) => workflowPath === 'pullops-pr-close-ticket.yml',
      ),
    );
    assert.match(specPrepareWorkflowText, /node-version: 22/);
    assert.match(specPrepareWorkflowText, /npm exec pullops -- run spec-prepare/);
    assert.match(issueImplementWorkflowText, /node-version: 22/);
    assert.match(issueImplementWorkflowText, /npm exec pullops -- run issue-implement/);
    assert.match(prCloseTicketWorkflowText, /node-version: 22/);
    assert.match(prCloseTicketWorkflowText, /npm exec pullops -- run pr-close-ticket/);
    assert.equal(customWorkflowText, 'name: Custom Workflow\n');
    assert.match(customWorkflowText, /Custom Workflow/);

    /** @type {import('./init.types.js').PullOpsInstallManifest} */
    const manifest = JSON.parse(manifestText);
    assert.ok(
      manifest.files.some(entry => entry.path === '.github/workflows/pullops-dispatch.yml'),
    );
    assert.ok(
      manifest.files.some(entry => entry.path === '.github/workflows/pullops-pr-close-ticket.yml'),
    );
    assert.ok(!manifest.files.some(entry => entry.path === '.github/workflows/custom.yml'));
  });

  it('01b: pins every generated GitHub Action to a full commit SHA', () => {
    const renderedWorkflowSets = [
      renderPullOpsGitHubActionsWorkflowFiles(),
      renderPullOpsGitHubActionsWorkflowFiles({ runnerCli: 'claude' }),
    ];
    const actionReferences = renderedWorkflowSets.flatMap(workflows =>
      [...workflows.values()].flatMap(workflow =>
        [...workflow.matchAll(/^\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)].map(match => match[1]),
      ),
    );

    assert.ok(actionReferences.length > 0);
    for (const actionReference of actionReferences) {
      assert.match(actionReference, /^[^@]+@[0-9a-f]{40}$/);
    }
    assert.ok(
      actionReferences.includes(
        'openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56',
      ),
    );
    assert.ok(
      actionReferences.includes(
        'anthropics/claude-code-action@37b464ce72700f7b2c5ff8d2db7fa7b15df792f5',
      ),
    );
  });

  it('02: blocks when repository context is unavailable for secret inspection', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(
      joinMessages(result.blockers),
      /GitHub Actions readiness requires a GitHub remote or explicit repository context\./,
    );
    assert.ok(neededFiles(result).includes('.github/workflows/pullops-dispatch.yml'));
  });

  it('03: blocks GitHub Actions readiness when package-lock.json is missing', async () => {
    const cwd = await createSetupRepository({
      includePackageLock: false,
      includeGitHubRemote: true,
    });
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'],
      readRepositoryLabels: async () => PULL_OPS_LABELS.map(label => ({ ...label })),
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(
      joinMessages(result.blockers),
      /Missing package-lock\.json required for npm ci in PullOps GitHub Actions workflows\./,
    );
  });

  it('04: reports missing repository Actions secrets as warnings when they are visible', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN'],
      readRepositoryLabels: async () => PULL_OPS_LABELS.map(label => ({ ...label })),
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.match(
      joinMessages(result.warnings),
      /Missing repository Actions secrets: OPENAI_API_KEY\./,
    );
  });

  it('04b: requires the Anthropic API key secret for claude Runner Commands', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await writeFile(
      join(cwd, 'pullops.config.mjs'),
      ['export default {', '  runner: {', "    command: 'claude',", '  },', '};', ''].join('\n'),
    );
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'],
      readRepositoryLabels: async () => PULL_OPS_LABELS.map(label => ({ ...label })),
    });

    assert.equal(result.status, 'ready');
    assert.match(
      joinMessages(result.warnings),
      /Missing repository Actions secrets: ANTHROPIC_API_KEY\./,
    );
  });

  it('05: warns when repository Actions secrets cannot be inspected', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => {
        throw new Error('repository secrets are hidden');
      },
      readRepositoryLabels: async () => PULL_OPS_LABELS.map(label => ({ ...label })),
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.match(
      joinMessages(result.warnings),
      /Unable to inspect repository Actions secrets: repository secrets are hidden/,
    );
  });

  it('06: blocks the full doctor profile without GitHub repository context', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });
    await runPullOpsSetupSkills({ cwd });
    await runPullOpsSetupAgentDocs({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'full',
      readGitHubAuthToken: readReadyGitHubAuthToken,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.match(
      joinMessages(result.blockers),
      /GitHub Actions readiness requires a GitHub remote or explicit repository context\./,
    );
    assert.ok(neededFiles(result).includes('.github/workflows/pullops-dispatch.yml'));
  });

  it('07: warns when the full doctor profile cannot inspect repository Actions secrets for non-context reasons', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupSkills({ cwd });
    await runPullOpsSetupAgentDocs({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'full',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => {
        throw new Error('repository secrets are hidden');
      },
      readRepositoryLabels: async () => PULL_OPS_LABELS.map(label => ({ ...label })),
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.changesNeeded, {});
    assert.match(
      joinMessages(result.warnings),
      /Unable to inspect repository Actions secrets: repository secrets are hidden/,
    );
  });

  it('08: threads an explicit repository into GitHub Actions and label readiness checks', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });
    /** @type {Array<{ cwd: string, repository?: string }>} */
    const secretReaderCalls = [];
    /** @type {Array<{ cwd: string, repository?: string }>} */
    const labelReaderCalls = [];

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'github-actions',
      repository: 'acme/widgets',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async options => {
        secretReaderCalls.push(options);
        return ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'];
      },
      readRepositoryLabels: async options => {
        labelReaderCalls.push(options);
        return PULL_OPS_LABELS.map(label => ({ ...label }));
      },
    });

    assert.equal(result.status, 'ready');
    assert.equal(secretReaderCalls[0]?.repository, 'acme/widgets');
    assert.equal(labelReaderCalls[0]?.repository, 'acme/widgets');
  });

  it('09: generates resolve-conflicts workflow passes from PullOps config', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });
    await writeFile(
      join(cwd, 'pullops.config.mjs'),
      [
        'export default {',
        '  operations: {',
        '    prResolveConflicts: {',
        '      maxConflictResolutionPasses: 4,',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
    );

    const result = await runPullOpsSetupGitHubActions({ cwd });

    assert.equal(result.status, 'changed');
    const workflow = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-pr-resolve-conflicts.yml'),
      'utf8',
    );
    assert.match(workflow, /Run Codex conflict pass 4/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.complete_3\.outputs\.prompt_file \}\}/);
    assert.match(
      workflow,
      /COMPLETE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/complete-4\.json/,
    );
    assert.match(workflow, /steps\.complete_4\.outputs\.run_runner == 'true'/);
  });

  it('09b: generates Claude Code runner steps for claude Runner Commands', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });
    await writeFile(
      join(cwd, 'pullops.config.mjs'),
      [
        'export default {',
        '  runner: {',
        "    command: 'claude --permission-mode bypassPermissions',",
        '  },',
        '};',
        '',
      ].join('\n'),
    );

    const result = await runPullOpsSetupGitHubActions({ cwd });

    assert.equal(result.status, 'changed');
    const workflow = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-issue-implement.yml'),
      'utf8',
    );
    assert.match(workflow, /Verify Anthropic API key/);
    assert.match(workflow, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    assert.match(
      workflow,
      /uses: anthropics\/claude-code-action@37b464ce72700f7b2c5ff8d2db7fa7b15df792f5 # v1/,
    );
    assert.match(workflow, /--model \$\{\{ steps\.prepare\.outputs\.model \}\}/);
    assert.doesNotMatch(workflow, /openai\/codex-action/);
    assert.doesNotMatch(workflow, /OPENAI_API_KEY/);

    const conflictsWorkflow = await readFile(
      join(cwd, '.github', 'workflows', 'pullops-pr-resolve-conflicts.yml'),
      'utf8',
    );
    assert.match(conflictsWorkflow, /Run Claude Code conflict pass 3/);
    assert.match(
      conflictsWorkflow,
      /Read the file \$\{\{ steps\.complete_2\.outputs\.prompt_file \}\} and follow the instructions in it exactly\./,
    );
    assert.doesNotMatch(conflictsWorkflow, /openai\/codex-action/);
  });

  it('10: force-reconciles one setup area while another manifest-owned area has also drifted', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });
    await runPullOpsSetupSkills({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    await writeFile(
      join(cwd, '.agents', 'skills', 'pullops-pr-review', 'SKILL.md'),
      'drifted skill\n',
    );
    await writeFile(
      join(cwd, '.github', 'workflows', 'pullops-dispatch.yml'),
      'drifted workflow\n',
    );

    const blocked = await runPullOpsSetupGitHubActions({ cwd });
    assert.equal(blocked.status, 'blocked');
    assert.match(
      joinMessages(blocked.blockers),
      /pullops-dispatch\.yml has local changes\. Re-run with --force to replace it\./,
    );
    assert.match(
      joinMessages(blocked.blockers),
      /pullops-pr-review\/SKILL\.md has local changes outside this setup command\./,
    );

    const forcedWorkflows = await runPullOpsSetupGitHubActions({ cwd, force: true });
    assert.equal(forcedWorkflows.status, 'changed');
    assert.deepEqual(forcedWorkflows.blockers, []);
    assert.ok(changedFiles(forcedWorkflows).includes('.github/workflows/pullops-dispatch.yml'));
    assert.match(
      joinMessages(forcedWorkflows.warnings),
      /pullops-pr-review\/SKILL\.md has local changes outside this setup command\./,
    );

    const forcedSkills = await runPullOpsSetupSkills({ cwd, force: true });
    assert.equal(forcedSkills.status, 'changed');
    assert.deepEqual(forcedSkills.blockers, []);
    assert.ok(changedFiles(forcedSkills).includes('.agents/skills/pullops-pr-review/SKILL.md'));

    const workflowsCheck = await runPullOpsSetupGitHubActions({ cwd, check: true });
    assert.equal(workflowsCheck.status, 'ready');
    assert.deepEqual(workflowsCheck.warnings, []);
    const skillsCheck = await runPullOpsSetupSkills({ cwd, check: true });
    assert.equal(skillsCheck.status, 'ready');
    assert.deepEqual(skillsCheck.warnings, []);
  });
});

describe('setup github-labels', () => {
  it('01: checks and applies only PullOps operation and status labels', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    /** @type {import('../github/types.js').GitHubLabel[]} */
    const listedLabels = PULL_OPS_LABELS.map(label => ({ ...label }));
    listedLabels[1] = {
      ...listedLabels[1],
      color: '000000',
    };
    const removedLabel = listedLabels.splice(5, 1)[0];
    if (removedLabel === undefined) {
      throw new Error('Expected a removed label.');
    }
    /** @type {import('../github/types.js').PullOpsLabel[]} */
    const ensuredLabels = [];
    let ensureCalls = 0;
    let listedCalls = 0;
    const githubClient = {
      async listRepositoryLabels() {
        listedCalls += 1;
        return listedLabels;
      },
      /**
       * @param {import('../github/types.js').PullOpsLabel[]} labels
       */
      async ensureLabels(labels) {
        ensureCalls += 1;
        ensuredLabels.push(...labels);
        return {
          created: [labels[0].name],
          updated: [labels[1].name],
          alreadyCorrect: labels.slice(2).map(label => label.name),
        };
      },
    };

    const dryRun = await runPullOpsSetupGitHubLabels({
      cwd,
      check: true,
      githubClient,
    });

    assert.equal(dryRun.status, 'blocked');
    assert.equal(dryRun.area, 'github-labels');
    assert.equal(
      dryRun.summary,
      `PullOps GitHub label setup found 2 labels needing changes: 1 created, 1 updated, ${PULL_OPS_LABELS.length - 2} already correct.`,
    );
    assert.deepEqual(dryRun.changes, {});
    assert.deepEqual(dryRun.changesNeeded, {
      labels: {
        created: [removedLabel.name],
        updated: [listedLabels[1].name],
      },
    });
    assert.deepEqual(dryRun.blockers, []);
    assert.deepEqual(dryRun.warnings, []);
    assert.deepEqual(dryRun.suggestions, [
      'Run PullOps setup github-labels to reconcile the repository labels.',
    ]);
    assert.equal(ensureCalls, 0);
    assert.equal(listedCalls, 1);

    const applied = await runPullOpsSetupGitHubLabels({
      cwd,
      githubClient,
    });

    assert.equal(applied.status, 'changed');
    assert.equal(applied.area, 'github-labels');
    assert.equal(
      applied.summary,
      `Reconciled ${PULL_OPS_LABELS.length} PullOps labels: 1 created, 1 updated, ${PULL_OPS_LABELS.length - 2} already correct.`,
    );
    assert.deepEqual(applied.changes, {
      labels: {
        created: [PULL_OPS_LABELS[0].name],
        updated: [PULL_OPS_LABELS[1].name],
      },
    });
    assert.deepEqual(applied.changesNeeded, {});
    assert.deepEqual(applied.blockers, []);
    assert.deepEqual(applied.warnings, []);
    assert.deepEqual(applied.suggestions, []);
    assert.equal(ensureCalls, 1);
    assert.equal(ensuredLabels.length, PULL_OPS_LABELS.length);
    assert.equal(
      ensuredLabels.some(label => label.name === 'pullops:human-required'),
      true,
    );
  });

  it('02: reports label readiness gaps as warnings when repository labels cannot be inspected', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupSkills({ cwd });
    await runPullOpsSetupAgentDocs({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'full',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'],
      readRepositoryLabels: async () => {
        throw new Error('repository labels are hidden');
      },
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.changesNeeded, {});
    assert.match(
      joinMessages(result.warnings),
      /Unable to inspect repository PullOps labels: repository labels are hidden/,
    );
  });

  it('03: reports PullOps label drift in the full doctor profile', async () => {
    const cwd = await createSetupRepository({ includeGitHubRemote: true });
    await runPullOpsInit({ cwd });
    await runPullOpsSetupSkills({ cwd });
    await runPullOpsSetupAgentDocs({ cwd });
    await runPullOpsSetupGitHubActions({ cwd });

    const result = await runPullOpsSetupDoctor({
      cwd,
      profile: 'full',
      readGitHubAuthToken: readReadyGitHubAuthToken,
      readRepositoryActionsSecretNames: async () => ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'],
      readRepositoryLabels: async () => {
        const labels = PULL_OPS_LABELS.map(label => ({ ...label }));
        labels[2] = {
          ...labels[2],
          color: '000000',
        };
        labels.splice(7, 1);
        return labels;
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.area, 'doctor');
    assert.deepEqual(result.blockers, []);
    assert.ok((result.changesNeeded.labels?.updated ?? []).includes(PULL_OPS_LABELS[2].name));
    assert.ok((result.changesNeeded.labels?.created ?? []).includes(PULL_OPS_LABELS[7].name));
  });

  it('04: reports auth handoff steps when GitHub label inspection lacks a token', async () => {
    const cwd = await createSetupRepository();
    await runPullOpsInit({ cwd });

    const result = await runPullOpsSetupGitHubLabels({
      cwd,
      check: true,
      githubClient: {
        async ensureLabels() {
          throw new Error('ensureLabels was not expected in this test.');
        },
        async listRepositoryLabels() {
          throw new Error(
            `${MISSING_GITHUB_AUTHENTICATION_BLOCKER} ${MISSING_GITHUB_AUTHENTICATION_SUGGESTION}`,
          );
        },
      },
    });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.blockers, [
      `Unable to reconcile PullOps GitHub labels: ${MISSING_GITHUB_AUTHENTICATION_BLOCKER}`,
    ]);
    assert.deepEqual(result.suggestions, [
      MISSING_GITHUB_AUTHENTICATION_SUGGESTION,
      SANDBOXED_GITHUB_AUTHENTICATION_SUGGESTION,
      SECURE_GITHUB_AUTHENTICATION_SUGGESTION,
    ]);
  });
});

describe('package files', () => {
  it('01: includes setup agent-doc templates in npm pack dry-run output', async () => {
    const npmCache = await mkdtemp(join(tmpdir(), 'pullops-npm-cache-'));
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: REPO_ROOT, env: { ...process.env, npm_config_cache: npmCache } },
    );
    /** @type {import('./setup.test.types.js').NpmPackDryRunResult} */
    const packResult = JSON.parse(stdout);
    assert.equal(packResult.length, 1);
    const packedPaths = packResult[0].files.map(file => file.path);

    assert.ok(packedPaths.includes('src/setup/agent-docs/pullops-cli.md'));
    assert.ok(packedPaths.includes('src/setup/agent-docs/issue-tracker.md'));
    assert.ok(packedPaths.includes('src/setup/agent-docs/triage-labels.md'));
    assert.ok(packedPaths.includes('src/setup/agent-docs/domain.md'));
    assert.ok(!packedPaths.includes('.github/workflows/pullops-dispatch.yml'));
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
 * @returns {Promise<string>}
 */
async function createPullOpsSourceRepository({ includePackageLock = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-source-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  await writeFile(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        name: '@pull-ops/cli',
        version: '0.1.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  if (includePackageLock) {
    await writeFile(
      join(cwd, 'package-lock.json'),
      `${JSON.stringify(
        {
          name: '@pull-ops/cli',
          lockfileVersion: 3,
        },
        null,
        2,
      )}\n`,
    );
  }

  await mkdir(join(cwd, 'src', 'setup'), { recursive: true });
  await cp(
    join(REPO_ROOT, 'src', 'setup', 'pullopsSetupSkill.txt'),
    join(cwd, 'src', 'setup', 'pullopsSetupSkill.txt'),
  );
  await cp(join(REPO_ROOT, 'src', 'setup', 'agent-docs'), join(cwd, 'src', 'setup', 'agent-docs'), {
    recursive: true,
  });
  return cwd;
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<void>}
 */
async function installPullOpsSourceSkillDirectories({ cwd }) {
  const skillSourceRoot = join(REPO_ROOT, '.agents', 'skills');
  const skillEntries = await readdir(skillSourceRoot, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith('pullops-') ||
      entry.name === 'pullops-setup'
    ) {
      continue;
    }

    await cp(join(skillSourceRoot, entry.name), join(cwd, '.agents', 'skills', entry.name), {
      recursive: true,
    });
  }
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

/**
 * @returns {string}
 */
function readReadyGitHubAuthToken() {
  return 'github-token';
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
