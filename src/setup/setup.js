import { createHash } from 'node:crypto';
import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadPullOpsConfig } from '../config/PullOpsConfig.js';
import {
  createGitHubClient,
  MISSING_GITHUB_AUTHENTICATION_BLOCKER,
  MISSING_GITHUB_AUTHENTICATION_SUGGESTIONS,
  parseGitHubRepository,
  PULL_OPS_LABELS,
  readGitHubAuthToken as readDefaultGitHubAuthToken,
} from '../github/GitHubClient.js';
import { renderPullOpsGitHubActionsWorkflowFiles } from './githubActionsWorkflows.js';
import {
  countSetupChanges,
  createFileSetupChangeSet,
  createLabelSetupChangeSet,
  hasSetupChanges,
  mergeSetupChangeSets,
} from './setupResult.js';

/**
 * @typedef {import('./init.types.js').PullOpsInstallManifest} PullOpsInstallManifest
 * @typedef {import('./init.types.js').PullOpsInstallManifestFileEntry} PullOpsInstallManifestFileEntry
 * @typedef {import('./init.types.js').PullOpsSetupResult} PullOpsSetupResult
 * @typedef {import('./setup.types.js').PullOpsInstallManifestState} PullOpsInstallManifestState
 * @typedef {import('./setup.types.js').PullOpsSetupCommandOptions} PullOpsSetupCommandOptions
 * @typedef {import('./setup.types.js').PullOpsSetupDoctorOptions} PullOpsSetupDoctorOptions
 * @typedef {import('./setup.types.js').PullOpsSetupGitHubLabelsOptions} PullOpsSetupGitHubLabelsOptions
 * @typedef {import('./setup.types.js').PullOpsSetupProfile} PullOpsSetupProfile
 * @typedef {import('./setup.types.js').SetupAdditionalPrereqReader} SetupAdditionalPrereqReader
 * @typedef {import('./setup.types.js').SetupFileCollector} SetupFileCollector
 * @typedef {import('./setup.types.js').SetupFileState} SetupFileState
 * @typedef {import('./setup.types.js').SetupInspectionResult} SetupInspectionResult
 * @typedef {import('./setup.types.js').SetupPrereqResult} SetupPrereqResult
 * @typedef {import('./setup.types.js').SetupWrite} SetupWrite
 * @typedef {import('../github/types.js').EnsureLabelsResult} EnsureLabelsResult
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../github/types.js').GitHubLabel} GitHubLabel
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

const execFileAsync = promisify(nodeExecFile);
const CONFIG_PATH = 'pullops.config.js';
const PACKAGE_JSON_PATH = 'package.json';
const PACKAGE_LOCK_PATH = 'package-lock.json';
const MANIFEST_PATH = '.pullops/install-manifest.json';
const SETUP_SKILL_PATH = '.agents/skills/pullops-setup/SKILL.md';
const LOCAL_PULL_OPS_DEPENDENCY = '@pull-ops/cli';
const LOCAL_PULL_OPS_EXECUTABLE_PATH = 'node_modules/.bin/pullops';
const LOCAL_PULL_OPS_PACKAGE_PATH = join('node_modules', '@pull-ops', 'cli');
const LOCAL_PULL_OPS_PACKAGE_JSON_PATH = join(LOCAL_PULL_OPS_PACKAGE_PATH, 'package.json');
const LOCAL_PULL_OPS_BUNDLED_SKILLS_PATH = join('.agents', 'skills');
const LOCAL_PULL_OPS_SETUP_SKILL_TEMPLATE_PATH = join('src', 'setup', 'pullopsSetupSkill.txt');
const LOCAL_PULL_OPS_AGENT_DOC_TEMPLATE_ROOT = join('src', 'setup', 'agent-docs');
const AGENT_DOC_TARGETS = [
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  'docs/agents/domain.md',
];
const GITHUB_ACTIONS_REQUIRED_SECRETS = ['PULLOPS_GITHUB_TOKEN', 'OPENAI_API_KEY'];
const UNTRACKED_MANIFEST_PATHS = new Set([CONFIG_PATH, ...AGENT_DOC_TARGETS]);

const SETUP_SKILLS_AREA = 'skills';
const SETUP_AGENT_DOCS_AREA = 'agent-docs';
const SETUP_GITHUB_ACTIONS_AREA = 'github-actions';
const SETUP_GITHUB_LABELS_AREA = 'github-labels';
const SETUP_DOCTOR_AREA = 'doctor';

/**
 * @param {PullOpsSetupCommandOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupSkills({
  cwd = process.cwd(),
  check = false,
  force = false,
} = {}) {
  return await reconcileSetupFiles({
    cwd,
    check,
    force,
    area: SETUP_SKILLS_AREA,
    readySummary: 'Installed bundled PullOps skills.',
    incompleteSummary: 'Bundled PullOps skills are incomplete.',
    collectDesiredFileContents: collectBundledSkillFileContents,
  });
}

/**
 * @param {PullOpsSetupCommandOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupAgentDocs({
  cwd = process.cwd(),
  check = false,
  force = false,
} = {}) {
  return await reconcileSetupFiles({
    cwd,
    check,
    force,
    area: SETUP_AGENT_DOCS_AREA,
    readySummary: 'Installed PullOps-compatible agent docs.',
    incompleteSummary: 'PullOps-compatible agent docs are incomplete.',
    collectDesiredFileContents: collectAgentDocFileContents,
    preserveUnmanagedExistingPaths: new Set(AGENT_DOC_TARGETS),
  });
}

/**
 * @param {PullOpsSetupCommandOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupGitHubActions({
  cwd = process.cwd(),
  check = false,
  force = false,
} = {}) {
  return await reconcileSetupFiles({
    cwd,
    check,
    force,
    area: SETUP_GITHUB_ACTIONS_AREA,
    readySummary: 'Installed PullOps GitHub Actions workflows.',
    incompleteSummary: 'PullOps GitHub Actions workflows are incomplete.',
    collectDesiredFileContents: collectGitHubActionsWorkflowFileContents,
    readAdditionalPrereqs: inspectGitHubActionsCommandPrereqs,
  });
}

/**
 * @param {PullOpsSetupGitHubLabelsOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupGitHubLabels({
  cwd = process.cwd(),
  check = false,
  force = false,
  githubClient,
  repository,
} = {}) {
  void force;
  const resolvedCwd = await resolveExistingPath(cwd);
  const prereqResult = await readSetupPrereqs({ cwd: resolvedCwd, verifyRuntime: true });
  if (prereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area: SETUP_GITHUB_LABELS_AREA,
      summary: prereqResult.suggestions[0] ?? 'PullOps GitHub label setup is incomplete.',
      changes: {},
      changesNeeded: {},
      blockers: prereqResult.blockers,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
    });
  }

  try {
    const client =
      githubClient ??
      createGitHubClient({
        ...(repository === undefined ? {} : { repository: parseGitHubRepository(repository) }),
        readRemoteOriginUrl: () => readGitRemoteOriginUrl(resolvedCwd),
      });

    if (check) {
      if (client.listRepositoryLabels === undefined) {
        throw new Error('GitHub client does not support listing repository labels.');
      }
      const existingLabels = await client.listRepositoryLabels();
      const inspection = inspectPullOpsGitHubLabels(existingLabels);
      const changesNeeded = createLabelSetupChangeSet(inspection);
      return createSetupResult({
        status: hasSetupChanges(changesNeeded) ? 'blocked' : 'ready',
        area: SETUP_GITHUB_LABELS_AREA,
        summary: hasSetupChanges(changesNeeded)
          ? summarizeGitHubLabelSetupResult({ mode: 'check', result: inspection })
          : completeSummaryForArea(SETUP_GITHUB_LABELS_AREA),
        changes: {},
        changesNeeded,
        blockers: [],
        warnings: [],
        suggestions: hasSetupChanges(changesNeeded)
          ? ['Run PullOps setup github-labels to reconcile the repository labels.']
          : [],
      });
    }

    const result = await client.ensureLabels(PULL_OPS_LABELS);
    return createSetupResult({
      status: result.created.length + result.updated.length > 0 ? 'changed' : 'ready',
      area: SETUP_GITHUB_LABELS_AREA,
      summary:
        result.created.length + result.updated.length > 0
          ? summarizeGitHubLabelSetupResult({ mode: 'apply', result })
          : completeSummaryForArea(SETUP_GITHUB_LABELS_AREA),
      changes: createLabelSetupChangeSet(result),
      changesNeeded: {},
      blockers: [],
      warnings: [],
      suggestions: [],
    });
  } catch (error) {
    const failure = formatGitHubLabelSetupFailure(error);
    return createSetupResult({
      status: 'blocked',
      area: SETUP_GITHUB_LABELS_AREA,
      summary: 'PullOps GitHub label setup is incomplete.',
      changes: {},
      changesNeeded: {},
      blockers: [failure.blocker],
      warnings: [],
      suggestions: failure.suggestions,
    });
  }
}

/**
 * @param {PullOpsSetupDoctorOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupDoctor({
  cwd = process.cwd(),
  profile = 'full',
  repository,
  readGitHubAuthToken = readDefaultGitHubAuthToken,
  readRepositoryActionsSecretNames,
  readRepositoryLabels,
} = {}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const prereqResult = await readSetupPrereqs({ cwd: resolvedCwd, verifyRuntime: true });
  if (prereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area: SETUP_DOCTOR_AREA,
      summary: doctorSummary({
        profile,
        blockersCount: prereqResult.blockers.length,
        changesNeededCount: 0,
      }),
      changes: {},
      changesNeeded: {},
      blockers: prereqResult.blockers,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
    });
  }

  const desiredFileContents = new Map();
  try {
    if (profile === 'local') {
      const setupSkillFiles = await collectSetupSkillFileContents({ cwd: resolvedCwd });
      for (const [path, contents] of setupSkillFiles.entries()) {
        desiredFileContents.set(path, contents);
      }
    }
    if (profile === 'full') {
      const skillFiles = await collectBundledSkillFileContents({ cwd: resolvedCwd });
      for (const [path, contents] of skillFiles.entries()) {
        desiredFileContents.set(path, contents);
      }
    }
    if (profile === 'full' || profile === 'authoring') {
      const docFiles = await collectAgentDocFileContents({ cwd: resolvedCwd });
      for (const [path, contents] of docFiles.entries()) {
        desiredFileContents.set(path, contents);
      }
    }
    if (profile === 'full' || profile === 'github-actions') {
      const workflowFiles = await collectGitHubActionsWorkflowFileContents({ cwd: resolvedCwd });
      for (const [path, contents] of workflowFiles.entries()) {
        desiredFileContents.set(path, contents);
      }
    }
  } catch (error) {
    return createLocalPackageLoadFailureResult({
      area: SETUP_DOCTOR_AREA,
      summary: doctorSummary({
        profile,
        blockersCount: 1,
        changesNeededCount: 0,
      }),
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
      error,
    });
  }

  const inspection = await inspectSetupFiles({
    cwd: resolvedCwd,
    desiredFileContents,
    check: true,
    force: false,
    preserveUnmanagedExistingPaths:
      profile === 'full' || profile === 'authoring' ? new Set(AGENT_DOC_TARGETS) : new Set(),
  });

  const gitHubAuthenticationInspection = shouldInspectLocalGitHubAuthentication(profile)
    ? await inspectLocalGitHubAuthentication({ readGitHubAuthToken })
    : { blockers: [], warnings: [], suggestions: [] };
  const canInspectRemoteGitHub = gitHubAuthenticationInspection.blockers.length === 0;
  const githubActionsInspection =
    canInspectRemoteGitHub && (profile === 'full' || profile === 'github-actions')
      ? await inspectGitHubActionsReadiness({
          cwd: resolvedCwd,
          repository,
          readGitHubAuthToken,
          readRepositoryActionsSecretNames,
        })
      : { blockers: [], warnings: [], suggestions: [] };
  const githubLabelsInspection =
    canInspectRemoteGitHub && (profile === 'full' || profile === 'github-actions')
      ? await inspectGitHubLabelsReadiness({
          cwd: resolvedCwd,
          repository,
          readGitHubAuthToken,
          readRepositoryLabels,
        })
      : { changesNeeded: {}, warnings: [], suggestions: [] };

  const optionalAuthoringResult =
    profile === 'full' || profile === 'authoring'
      ? await inspectOptionalAuthoringSkills({ cwd: resolvedCwd })
      : { warnings: [], suggestions: [] };
  const runsIgnoreResult = await inspectPullOpsRunsIgnore({ cwd: resolvedCwd });

  const blockers = dedupeStrings([
    ...inspection.blockers,
    ...gitHubAuthenticationInspection.blockers,
    ...githubActionsInspection.blockers,
  ]);
  const changesNeeded = mergeSetupChangeSets([
    createFileSetupChangeSet(inspection.changesNeeded),
    githubLabelsInspection.changesNeeded,
  ]);
  const warnings = dedupeStrings([
    ...prereqResult.warnings,
    ...inspection.warnings,
    ...gitHubAuthenticationInspection.warnings,
    ...githubActionsInspection.warnings,
    ...githubLabelsInspection.warnings,
    ...optionalAuthoringResult.warnings,
    ...runsIgnoreResult.warnings,
  ]);
  const suggestions = dedupeStrings([
    ...prereqResult.suggestions,
    ...inspection.suggestions,
    ...gitHubAuthenticationInspection.suggestions,
    ...githubActionsInspection.suggestions,
    ...githubLabelsInspection.suggestions,
    ...optionalAuthoringResult.suggestions,
    ...runsIgnoreResult.suggestions,
  ]);
  const status = blockers.length > 0 || hasSetupChanges(changesNeeded) ? 'blocked' : 'ready';

  return createSetupResult({
    status,
    area: SETUP_DOCTOR_AREA,
    summary: doctorSummary({
      profile,
      blockersCount: blockers.length,
      changesNeededCount: countSetupChanges(changesNeeded),
    }),
    changes: {},
    changesNeeded,
    blockers,
    warnings,
    suggestions,
  });
}

/**
 * @param {{
 *   cwd: string,
 *   check: boolean,
 *   force: boolean,
 *   area: string,
 *   readySummary: string,
 *   incompleteSummary: string,
 *   collectDesiredFileContents: SetupFileCollector,
 *   readAdditionalPrereqs?: SetupAdditionalPrereqReader,
 *   preserveUnmanagedExistingPaths?: Set<string>,
 * }} options
 * @returns {Promise<PullOpsSetupResult>}
 */
async function reconcileSetupFiles({
  cwd,
  check,
  force,
  area,
  readySummary,
  incompleteSummary,
  collectDesiredFileContents,
  readAdditionalPrereqs,
  preserveUnmanagedExistingPaths = new Set(),
}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const prereqResult = await readSetupPrereqs({ cwd: resolvedCwd, verifyRuntime: true });
  if (prereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area,
      summary: prereqResult.suggestions[0] ?? incompleteSummary,
      changes: {},
      changesNeeded: {},
      blockers: prereqResult.blockers,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
    });
  }

  const additionalPrereqResult = readAdditionalPrereqs
    ? await readAdditionalPrereqs({ cwd: resolvedCwd })
    : { blockers: [], warnings: [], suggestions: [] };
  if (additionalPrereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area,
      summary: additionalPrereqResult.suggestions[0] ?? incompleteSummary,
      changes: {},
      changesNeeded: {},
      blockers: additionalPrereqResult.blockers,
      warnings: additionalPrereqResult.warnings,
      suggestions: additionalPrereqResult.suggestions,
    });
  }

  let desiredFileContents;
  try {
    desiredFileContents = await collectDesiredFileContents({ cwd: resolvedCwd });
  } catch (error) {
    return createLocalPackageLoadFailureResult({
      area,
      summary: incompleteSummary,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
      error,
    });
  }

  const inspection = await inspectSetupFiles({
    cwd: resolvedCwd,
    desiredFileContents,
    check,
    force,
    preserveUnmanagedExistingPaths,
  });

  if (inspection.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area,
      summary: incompleteSummary,
      changes: {},
      changesNeeded: createFileSetupChangeSet(inspection.changesNeeded),
      blockers: inspection.blockers,
      warnings: dedupeStrings([...additionalPrereqResult.warnings, ...inspection.warnings]),
      suggestions: dedupeStrings([
        ...additionalPrereqResult.suggestions,
        ...inspection.suggestions,
      ]),
    });
  }

  if (check) {
    return createSetupResult({
      status: inspection.changesNeeded.length > 0 ? 'blocked' : 'ready',
      area,
      summary: inspection.changesNeeded.length > 0 ? incompleteSummary : readySummary,
      changes: {},
      changesNeeded: createFileSetupChangeSet(inspection.changesNeeded),
      blockers: [],
      warnings: dedupeStrings([...additionalPrereqResult.warnings, ...inspection.warnings]),
      suggestions: inspection.changesNeeded.length > 0 ? inspection.suggestions : [],
    });
  }

  for (const write of inspection.writes) {
    await writeTextFile(join(resolvedCwd, write.path), write.contents);
  }

  return createSetupResult({
    status: inspection.writes.length > 0 ? 'changed' : 'ready',
    area,
    summary: inspection.writes.length > 0 ? readySummary : completeSummaryForArea(area),
    changes: createFileSetupChangeSet(inspection.writes.map(write => write.path)),
    changesNeeded: {},
    blockers: [],
    warnings: dedupeStrings([...additionalPrereqResult.warnings, ...inspection.warnings]),
    suggestions: dedupeStrings([...additionalPrereqResult.suggestions, ...inspection.suggestions]),
  });
}

/**
 * @param {{
 *   cwd: string,
 *   desiredFileContents: Map<string, string>,
 *   check: boolean,
 *   force: boolean,
 *   preserveUnmanagedExistingPaths?: Set<string>,
 * }} options
 * @returns {Promise<SetupInspectionResult>}
 */
async function inspectSetupFiles({
  cwd,
  desiredFileContents,
  check,
  force,
  preserveUnmanagedExistingPaths = new Set(),
}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const manifestState = await readInstallManifestState(join(resolvedCwd, MANIFEST_PATH));
  if (manifestState === undefined) {
    return {
      changesNeeded: [],
      blockers: [
        'Existing file .pullops/install-manifest.json is not a valid PullOps install manifest.',
      ],
      warnings: [],
      suggestions: ['Run PullOps init before using PullOps setup commands.'],
      writes: [],
    };
  }

  const configPath = join(resolvedCwd, CONFIG_PATH);
  if (!(await pathExists(configPath))) {
    return {
      changesNeeded: [],
      blockers: ['Missing required PullOps config pullops.config.js.'],
      warnings: [],
      suggestions: ['Run PullOps init before using PullOps setup commands.'],
      writes: [],
    };
  }

  try {
    await loadPullOpsConfig({ cwd: resolvedCwd });
  } catch (error) {
    return {
      changesNeeded: [],
      blockers: [`Unable to load PullOps Config from ${CONFIG_PATH}: ${getErrorMessage(error)}`],
      warnings: [],
      suggestions: ['Fix pullops.config.js before rerunning PullOps setup.'],
      writes: [],
    };
  }

  const desiredFileStates = await readSetupFileStates({
    cwd: resolvedCwd,
    desiredFileContents,
    manifestEntries: manifestState.entries,
  });
  /** @type {string[]} */
  const changesNeeded = [];
  /** @type {Array<{ path: string, contents: string }>} */
  const writes = [];
  /** @type {Map<string, string>} */
  const managedDesiredFileContents = new Map();
  for (const state of desiredFileStates) {
    if (preserveUnmanagedExistingPaths.has(state.path)) {
      if (state.currentContent === undefined) {
        addUnique(changesNeeded, state.path);
        if (!check) {
          writes.push({ path: state.path, contents: state.desiredContent });
        }
      }
      continue;
    }

    managedDesiredFileContents.set(state.path, state.desiredContent);
  }

  const manifestConflictBlockers = await collectManifestConflictBlockers({
    cwd: resolvedCwd,
    manifestState,
    desiredPaths: new Set(managedDesiredFileContents.keys()),
    excludedPaths: UNTRACKED_MANIFEST_PATHS,
    force,
  });
  if (manifestConflictBlockers.length > 0) {
    return {
      changesNeeded: [],
      blockers: manifestConflictBlockers,
      warnings: [],
      suggestions: ['Restore or force the managed files before rerunning PullOps setup.'],
      writes: [],
    };
  }

  const desiredManifestEntries = buildDesiredManifestEntries({
    existingFileEntries: manifestState.fileEntries,
    managedFileEntries: [...managedDesiredFileContents.entries()].map(([path, contents]) => ({
      path,
      hash: hashContent(contents),
    })),
    excludedPaths: UNTRACKED_MANIFEST_PATHS,
  });
  const desiredManifestContent = areManifestEntriesEqual(
    manifestState.fileEntries,
    desiredManifestEntries,
  )
    ? manifestState.raw
    : buildInstallManifestContents({ fileEntries: desiredManifestEntries });

  const desiredFiles = new Map([
    ...managedDesiredFileContents,
    [MANIFEST_PATH, desiredManifestContent],
  ]);
  const fileStates = await readSetupFileStates({
    cwd: resolvedCwd,
    desiredFileContents: desiredFiles,
    manifestEntries: manifestState.entries,
  });

  for (const state of fileStates) {
    if (state.currentContent === state.desiredContent) {
      continue;
    }

    addUnique(changesNeeded, state.path);

    if (state.currentContent === undefined) {
      if (!check) {
        writes.push({ path: state.path, contents: state.desiredContent });
      }
      continue;
    }

    if (state.path === MANIFEST_PATH) {
      if (
        isManifestConsistentWithCurrentManagedFiles({
          manifestState,
          managedFileStates: fileStates.filter(fileState => fileState.path !== MANIFEST_PATH),
        }) ||
        force
      ) {
        if (!check) {
          writes.push({ path: state.path, contents: state.desiredContent });
        }
        continue;
      }

      return {
        changesNeeded,
        blockers: [
          'Existing PullOps install manifest has local changes. Re-run with --force to replace it.',
        ],
        warnings: [],
        suggestions: ['Restore or force the install manifest before rerunning PullOps setup.'],
        writes: [],
      };
    }

    if (state.manifestHash === undefined) {
      return {
        changesNeeded,
        blockers: [`Existing file ${state.path} is not manifest-owned yet.`],
        warnings: [],
        suggestions: ['Restore or adopt the existing file before rerunning PullOps setup.'],
        writes: [],
      };
    }

    if (state.currentHash === state.manifestHash || force) {
      if (!check) {
        writes.push({ path: state.path, contents: state.desiredContent });
      }
      continue;
    }

    return {
      changesNeeded,
      blockers: [
        `Existing PullOps-owned file ${state.path} has local changes. Re-run with --force to replace it.`,
      ],
      warnings: [],
      suggestions: ['Restore or force the managed files before rerunning PullOps setup.'],
      writes: [],
    };
  }

  return {
    changesNeeded,
    blockers: [],
    warnings: [],
    suggestions:
      changesNeeded.length > 0
        ? ['Review the missing files, then rerun the matching PullOps setup command.']
        : [],
    writes,
  };
}

/**
 * @param {{ cwd: string, verifyRuntime?: boolean }} options
 * @returns {Promise<SetupPrereqResult>}
 */
async function readSetupPrereqs({ cwd, verifyRuntime = false }) {
  const resolvedCwd = await resolveExistingPath(cwd);
  /** @type {string[]} */
  const blockers = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const suggestions = [];

  const repositoryRoot = await readGitRepositoryRoot(resolvedCwd);
  if (repositoryRoot === undefined) {
    blockers.push('Git could not determine a repository root.');
    suggestions.push('Run PullOps setup from inside a git repository.');
  } else {
    const resolvedRepositoryRoot = await resolveExistingPath(repositoryRoot);
    if (resolvedRepositoryRoot !== resolvedCwd) {
      blockers.push(
        `Current directory ${resolvedCwd} is not the git repository root ${resolvedRepositoryRoot}.`,
      );
      suggestions.push(`Rerun PullOps setup from ${resolvedRepositoryRoot}.`);
    }
  }

  const packageJsonPath = join(resolvedCwd, PACKAGE_JSON_PATH);
  /** @type {Record<string, unknown> | undefined} */
  let packageJson;
  if (!(await pathExists(packageJsonPath))) {
    blockers.push('Missing root package.json.');
    suggestions.push('Create a root package.json before rerunning PullOps setup.');
  } else {
    try {
      const packageJsonText = await readFile(packageJsonPath, 'utf8');
      packageJson = parseRootPackageJson(packageJsonText);
    } catch (error) {
      blockers.push(`Unable to load root package.json: ${getErrorMessage(error)}`);
      suggestions.push('Fix package.json before rerunning PullOps setup.');
      packageJson = undefined;
    }

    if (packageJson !== undefined) {
      const dependencyVersion = readLocalPullOpsDependencyVersion(packageJson);
      if (dependencyVersion === undefined) {
        blockers.push(
          `Missing local PullOps dependency ${LOCAL_PULL_OPS_DEPENDENCY} in package.json.`,
        );
        suggestions.push(
          `Add ${LOCAL_PULL_OPS_DEPENDENCY} as a dependency or devDependency before rerunning PullOps setup.`,
        );
      }
    }
  }

  if (verifyRuntime) {
    const nodeRuntimeStatus = await inspectNodeRuntime();
    blockers.push(...nodeRuntimeStatus.blockers);
    suggestions.push(...nodeRuntimeStatus.suggestions);

    if (packageJson === undefined || !isLocalPullOpsSourcePackage(packageJson)) {
      const installedLocalPullOpsPackageStatus = await inspectInstalledLocalPullOpsPackage({
        cwd: resolvedCwd,
      });
      blockers.push(...installedLocalPullOpsPackageStatus.blockers);
      suggestions.push(...installedLocalPullOpsPackageStatus.suggestions);

      const localPullOpsExecutableStatus = await inspectLocalPullOpsExecutable({
        cwd: resolvedCwd,
      });
      blockers.push(...localPullOpsExecutableStatus.blockers);
      suggestions.push(...localPullOpsExecutableStatus.suggestions);
    }
  }

  const manifestState = await readInstallManifestState(join(resolvedCwd, MANIFEST_PATH));
  if (manifestState === undefined) {
    blockers.push(
      'Existing file .pullops/install-manifest.json is not a valid PullOps install manifest.',
    );
    suggestions.push('Run PullOps init before using PullOps setup commands.');
    return { blockers, warnings, suggestions, manifestState: undefined };
  }

  const configPath = join(resolvedCwd, CONFIG_PATH);
  if (!(await pathExists(configPath))) {
    blockers.push('Missing required PullOps config pullops.config.js.');
    suggestions.push('Run PullOps init before using PullOps setup commands.');
  }

  if (await pathExists(configPath)) {
    try {
      await loadPullOpsConfig({ cwd: resolvedCwd });
    } catch (error) {
      blockers.push(`Unable to load PullOps Config from ${CONFIG_PATH}: ${getErrorMessage(error)}`);
      suggestions.push('Fix pullops.config.js before rerunning PullOps setup.');
    }
  }

  return {
    blockers: dedupeStrings(blockers),
    warnings,
    suggestions: dedupeStrings(suggestions),
    manifestState,
  };
}

/**
 * @returns {Promise<{ blockers: string[], suggestions: string[] }>}
 */
async function inspectNodeRuntime() {
  try {
    const result = await execFileAsync('node', ['--version']);
    const rawVersion = String(result.stdout ?? '').trim();
    const versionMatch = /^v(\d+)\./.exec(rawVersion);
    const majorVersion = Number(versionMatch?.[1]);
    if (!Number.isInteger(majorVersion)) {
      throw new Error(`Unable to parse Node version "${rawVersion}".`);
    }

    if (majorVersion < 22) {
      return {
        blockers: [`Node ${rawVersion} is unsupported. PullOps setup requires Node >=22.`],
        suggestions: ['Install Node 22 or newer before rerunning PullOps setup.'],
      };
    }

    return { blockers: [], suggestions: [] };
  } catch (error) {
    return {
      blockers: [`Unable to verify a supported Node runtime: ${getErrorMessage(error)}`],
      suggestions: [
        'Install Node 22 or newer and expose node on PATH before rerunning PullOps setup.',
      ],
    };
  }
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<{ blockers: string[], suggestions: string[] }>}
 */
async function inspectLocalPullOpsExecutable({ cwd }) {
  const executablePath = join(cwd, LOCAL_PULL_OPS_EXECUTABLE_PATH);
  if (!(await pathExists(executablePath))) {
    return {
      blockers: [`Missing local PullOps executable ${LOCAL_PULL_OPS_EXECUTABLE_PATH}.`],
      suggestions: ['Run npm ci before rerunning PullOps setup.'],
    };
  }

  try {
    await execFileAsync(executablePath, ['--help'], { cwd });
    return { blockers: [], suggestions: [] };
  } catch (error) {
    return {
      blockers: [
        `Local PullOps executable ${LOCAL_PULL_OPS_EXECUTABLE_PATH} could not run: ${getErrorMessage(error)}`,
      ],
      suggestions: ['Run npm ci before rerunning PullOps setup.'],
    };
  }
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<{ blockers: string[], suggestions: string[] }>}
 */
async function inspectInstalledLocalPullOpsPackage({ cwd }) {
  const packageJsonPath = join(cwd, LOCAL_PULL_OPS_PACKAGE_JSON_PATH);
  const packageJsonText = await readTextFileIfExists(packageJsonPath);
  if (packageJsonText === undefined) {
    return {
      blockers: [`Missing installed local PullOps package ${LOCAL_PULL_OPS_PACKAGE_JSON_PATH}.`],
      suggestions: ['Run npm ci before rerunning PullOps setup.'],
    };
  }

  try {
    parseInstalledLocalPullOpsPackageJson(packageJsonText);
    return { blockers: [], suggestions: [] };
  } catch (error) {
    return {
      blockers: [
        `Installed local PullOps package ${LOCAL_PULL_OPS_PACKAGE_JSON_PATH} is invalid: ${getErrorMessage(error)}`,
      ],
      suggestions: ['Run npm ci before rerunning PullOps setup.'],
    };
  }
}

/**
 * @param {{
 *   cwd: string,
 *   desiredFileContents: Map<string, string>,
 *   manifestEntries: Map<string, string>,
 * }} options
 * @returns {Promise<SetupFileState[]>}
 */
async function readSetupFileStates({ cwd, desiredFileContents, manifestEntries }) {
  /** @type {SetupFileState[]} */
  const states = [];

  for (const [path, desiredContent] of desiredFileContents.entries()) {
    const currentContent = await readTextFileIfExists(join(cwd, path));
    states.push({
      path,
      currentContent,
      desiredContent,
      currentHash: currentContent === undefined ? undefined : hashContent(currentContent),
      manifestHash: manifestEntries.get(path),
    });
  }

  return states;
}

/**
 * @param {{
 *   cwd: string,
 *   manifestState: PullOpsInstallManifestState,
 *   desiredPaths: Set<string>,
 *   excludedPaths: Set<string>,
 *   force: boolean,
 * }} options
 * @returns {Promise<string[]>}
 */
async function collectManifestConflictBlockers({
  cwd,
  manifestState,
  desiredPaths,
  excludedPaths,
  force,
}) {
  /** @type {string[]} */
  const blockers = [];

  for (const fileEntry of manifestState.fileEntries) {
    if (excludedPaths.has(fileEntry.path)) {
      continue;
    }

    const currentContent = await readTextFileIfExists(join(cwd, fileEntry.path));
    if (currentContent === undefined) {
      continue;
    }

    const currentHash = hashContent(currentContent);
    if (currentHash === fileEntry.hash) {
      continue;
    }

    if (desiredPaths.has(fileEntry.path) && force) {
      continue;
    }

    if (desiredPaths.has(fileEntry.path)) {
      blockers.push(
        `Existing PullOps-owned file ${fileEntry.path} has local changes. Re-run with --force to replace it.`,
      );
      continue;
    }

    blockers.push(
      `Existing PullOps-owned file ${fileEntry.path} has local changes outside this setup command. Restore it before rerunning PullOps setup.`,
    );
  }

  return blockers;
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<{ warnings: string[], suggestions: string[] }>}
 */
async function inspectOptionalAuthoringSkills({ cwd }) {
  const missing = [];
  for (const skillName of ['to-prd', 'to-issues']) {
    const skillPath = join(cwd, '.agents', 'skills', skillName, 'SKILL.md');
    if (!(await pathExists(skillPath))) {
      missing.push(skillName);
    }
  }

  if (missing.length === 0) {
    return { warnings: [], suggestions: [] };
  }

  return {
    warnings: [`Missing optional authoring skills: ${missing.join(', ')}.`],
    suggestions: ['npx skills@latest add mattpocock/skills'],
  };
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<{ warnings: string[], suggestions: string[] }>}
 */
async function inspectPullOpsRunsIgnore({ cwd }) {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '.pullops/runs'], { cwd });
    return { warnings: [], suggestions: [] };
  } catch {
    return {
      warnings: ['Add .pullops/runs/ to .gitignore so local run records stay out of commits.'],
      suggestions: [],
    };
  }
}

/**
 * @param {PullOpsSetupProfile} profile
 * @returns {boolean}
 */
function shouldInspectLocalGitHubAuthentication(profile) {
  return profile === 'full' || profile === 'local' || profile === 'github-actions';
}

/**
 * @param {{ readGitHubAuthToken: () => string | undefined }} options
 * @returns {Promise<{ blockers: string[], warnings: string[], suggestions: string[] }>}
 */
async function inspectLocalGitHubAuthentication({ readGitHubAuthToken }) {
  try {
    const token = readGitHubAuthToken();
    if (typeof token === 'string' && token.trim() !== '') {
      return { blockers: [], warnings: [], suggestions: [] };
    }
  } catch (error) {
    return {
      blockers: [`Unable to inspect local GitHub API authentication: ${getErrorMessage(error)}`],
      warnings: [],
      suggestions: missingGitHubAuthenticationSuggestions(),
    };
  }

  return {
    blockers: [MISSING_GITHUB_AUTHENTICATION_BLOCKER],
    warnings: [],
    suggestions: missingGitHubAuthenticationSuggestions(),
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   repository?: string,
 *   readGitHubAuthToken?: () => string | undefined,
 *   readRepositoryActionsSecretNames?: (options: { cwd: string, repository?: string, readGitHubAuthToken: () => string | undefined }) => Promise<string[]>;
 * }} [options]
 * @returns {Promise<{ blockers: string[], warnings: string[], suggestions: string[] }>}
 */
async function inspectGitHubActionsReadiness({
  cwd = process.cwd(),
  repository,
  readGitHubAuthToken = readDefaultGitHubAuthToken,
  readRepositoryActionsSecretNames = readRepositoryActionsSecretNamesDefault,
} = {}) {
  /** @type {string[]} */
  const blockers = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const suggestions = [];

  if (!(await pathExists(join(cwd, PACKAGE_LOCK_PATH)))) {
    blockers.push(
      'Missing package-lock.json required for npm ci in PullOps GitHub Actions workflows.',
    );
    suggestions.push('Create package-lock.json before rerunning PullOps setup.');
  }

  try {
    const secretNames = await readRepositoryActionsSecretNames({
      cwd,
      ...(repository === undefined ? {} : { repository }),
      readGitHubAuthToken,
    });
    const missingSecrets = GITHUB_ACTIONS_REQUIRED_SECRETS.filter(
      secret => !secretNames.includes(secret),
    );

    if (missingSecrets.length > 0) {
      warnings.push(`Missing repository Actions secrets: ${missingSecrets.join(', ')}.`);
      suggestions.push(
        'Add the missing repository Actions secrets before rerunning PullOps setup.',
      );
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (isGitHubRepositoryContextError(message)) {
      blockers.push(
        'GitHub Actions readiness requires a GitHub remote or explicit repository context.',
      );
      suggestions.push(
        'Set GITHUB_REPOSITORY or configure remote.origin.url before rerunning PullOps setup.',
      );
    } else {
      warnings.push(`Unable to inspect repository Actions secrets: ${message}`);
      suggestions.push(
        'Make the repository Actions secrets visible or rerun PullOps setup with repository access.',
      );
    }
  }

  return {
    blockers: dedupeStrings(blockers),
    warnings: dedupeStrings(warnings),
    suggestions: dedupeStrings(suggestions),
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   repository?: string,
 *   readGitHubAuthToken?: () => string | undefined,
 *   readRepositoryLabels?: (options: { cwd: string, repository?: string, readGitHubAuthToken: () => string | undefined }) => Promise<GitHubLabel[]>,
 * }} [options]
 * @returns {Promise<{ changesNeeded: import('./init.types.js').PullOpsSetupChangeSet, warnings: string[], suggestions: string[] }>}
 */
async function inspectGitHubLabelsReadiness({
  cwd = process.cwd(),
  repository,
  readGitHubAuthToken = readDefaultGitHubAuthToken,
  readRepositoryLabels = readRepositoryLabelsDefault,
} = {}) {
  try {
    const existingLabels = await readRepositoryLabels({
      cwd,
      ...(repository === undefined ? {} : { repository }),
      readGitHubAuthToken,
    });
    const inspection = inspectPullOpsGitHubLabels(existingLabels);
    const changesNeeded = createLabelSetupChangeSet(inspection);

    if (!hasSetupChanges(changesNeeded)) {
      return { changesNeeded: {}, warnings: [], suggestions: [] };
    }

    return {
      changesNeeded,
      warnings: [],
      suggestions: ['Run PullOps setup github-labels to reconcile the repository labels.'],
    };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      changesNeeded: {},
      warnings: [`Unable to inspect repository PullOps labels: ${message}`],
      suggestions: [
        'Set GITHUB_REPOSITORY or configure remote.origin.url before rerunning PullOps setup.',
      ],
    };
  }
}

/**
 * @param {{ cwd: string, repository?: string, readGitHubAuthToken: () => string | undefined }} options
 * @returns {Promise<GitHubLabel[]>}
 */
async function readRepositoryLabelsDefault({ cwd, repository, readGitHubAuthToken }) {
  const client = createAuthenticatedSetupGitHubClient({
    cwd,
    repository,
    readGitHubAuthToken,
  });
  if (client.listRepositoryLabels === undefined) {
    throw new Error('GitHub client does not support listing repository labels.');
  }
  return await client.listRepositoryLabels();
}

/**
 * @param {GitHubLabel[]} existingLabels
 * @returns {EnsureLabelsResult}
 */
function inspectPullOpsGitHubLabels(existingLabels) {
  const existingLabelsByName = new Map(existingLabels.map(label => [label.name, label]));
  /** @type {EnsureLabelsResult} */
  const result = {
    created: [],
    updated: [],
    alreadyCorrect: [],
  };

  for (const label of PULL_OPS_LABELS) {
    const existingLabel = existingLabelsByName.get(label.name);

    if (existingLabel === undefined) {
      result.created.push(label.name);
      continue;
    }

    if (labelNeedsUpdate(existingLabel, label)) {
      result.updated.push(label.name);
      continue;
    }

    result.alreadyCorrect.push(label.name);
  }

  return result;
}

/**
 * @param {GitHubLabel} existingLabel
 * @param {PullOpsLabel} expectedLabel
 * @returns {boolean}
 */
function labelNeedsUpdate(existingLabel, expectedLabel) {
  return (
    normalizeLabelColor(existingLabel.color) !== normalizeLabelColor(expectedLabel.color) ||
    existingLabel.description !== expectedLabel.description
  );
}

/**
 * @param {string} color
 * @returns {string}
 */
function normalizeLabelColor(color) {
  return color.replace(/^#/, '').toLowerCase();
}

/**
 * @param {{ cwd: string, repository?: string, readGitHubAuthToken: () => string | undefined }} options
 * @returns {Promise<string[]>}
 */
async function readRepositoryActionsSecretNamesDefault({ cwd, repository, readGitHubAuthToken }) {
  const client = createAuthenticatedSetupGitHubClient({
    cwd,
    repository,
    readGitHubAuthToken,
  });
  if (client.listRepositoryActionsSecretNames === undefined) {
    throw new Error('GitHub client does not support listing repository Actions secrets.');
  }
  return await client.listRepositoryActionsSecretNames();
}

/**
 * @param {{ cwd: string, repository?: string, readGitHubAuthToken: () => string | undefined }} options
 * @returns {GitHubClient}
 */
function createAuthenticatedSetupGitHubClient({ cwd, repository, readGitHubAuthToken }) {
  const auth = readGitHubAuthToken();
  return createGitHubClient({
    env: auth === undefined ? {} : { PULLOPS_GITHUB_TOKEN: auth },
    readGitHubCliToken: () => undefined,
    ...(repository === undefined ? {} : { repository: parseGitHubRepository(repository) }),
    readRemoteOriginUrl: () => readGitRemoteOriginUrl(cwd),
  });
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<Map<string, string>>}
 */
async function collectSetupSkillFileContents({ cwd }) {
  const localPackageRoot = await resolveInstalledLocalPullOpsPackageRoot({ cwd });
  return new Map([
    [
      SETUP_SKILL_PATH,
      await readFile(join(localPackageRoot, LOCAL_PULL_OPS_SETUP_SKILL_TEMPLATE_PATH), 'utf8'),
    ],
  ]);
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<Map<string, string>>}
 */
async function collectBundledSkillFileContents({ cwd }) {
  const localPackageRoot = await resolveInstalledLocalPullOpsPackageRoot({ cwd });
  const skillRootPath = join(localPackageRoot, LOCAL_PULL_OPS_BUNDLED_SKILLS_PATH);
  const entries = await readdir(skillRootPath, { withFileTypes: true });
  const skillDirectories = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('pullops-'))
    .sort((left, right) => left.name.localeCompare(right.name));

  /** @type {Map<string, string>} */
  const fileContents = new Map();
  for (const skillDirectory of skillDirectories) {
    await collectDirectoryFileContents({
      sourcePath: join(skillRootPath, skillDirectory.name),
      targetPath: join('.agents', 'skills', skillDirectory.name),
      fileContents,
    });
  }

  fileContents.set(
    SETUP_SKILL_PATH,
    await readFile(join(localPackageRoot, LOCAL_PULL_OPS_SETUP_SKILL_TEMPLATE_PATH), 'utf8'),
  );
  return fileContents;
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<Map<string, string>>}
 */
async function collectAgentDocFileContents({ cwd }) {
  const localPackageRoot = await resolveInstalledLocalPullOpsPackageRoot({ cwd });
  /** @type {Map<string, string>} */
  const fileContents = new Map();

  for (const targetPath of AGENT_DOC_TARGETS) {
    const fileName = targetPath.split('/').at(-1);
    if (fileName === undefined) {
      continue;
    }

    fileContents.set(
      targetPath,
      await readFile(
        join(localPackageRoot, LOCAL_PULL_OPS_AGENT_DOC_TEMPLATE_ROOT, fileName),
        'utf8',
      ),
    );
  }

  return fileContents;
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<Map<string, string>>}
 */
async function collectGitHubActionsWorkflowFileContents({ cwd }) {
  void cwd;
  return renderPullOpsGitHubActionsWorkflowFiles();
}

/**
 * @param {{
 *   sourcePath: string,
 *   targetPath: string,
 *   fileContents: Map<string, string>,
 * }} options
 * @returns {Promise<void>}
 */
async function collectDirectoryFileContents({ sourcePath, targetPath, fileContents }) {
  const entries = await readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextSourcePath = join(sourcePath, entry.name);
    const nextTargetPath = join(targetPath, entry.name);

    if (entry.isDirectory()) {
      await collectDirectoryFileContents({
        sourcePath: nextSourcePath,
        targetPath: nextTargetPath,
        fileContents,
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    fileContents.set(nextTargetPath, await readFile(nextSourcePath, 'utf8'));
  }
}

/**
 * @param {string} cwd
 * @returns {Promise<string | undefined>}
 */
async function readGitRepositoryRoot(cwd) {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const repositoryRoot = String(result.stdout ?? '').trim();
    return repositoryRoot === '' ? undefined : repositoryRoot;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} cwd
 * @returns {string | undefined}
 */
function readGitRemoteOriginUrl(cwd) {
  try {
    const result = nodeExecFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const remoteUrl = String(result ?? '').trim();
    return remoteUrl === '' ? undefined : remoteUrl;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function resolveExistingPath(filePath) {
  return await realpath(resolve(filePath));
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<string>}
 */
async function resolveInstalledLocalPullOpsPackageRoot({ cwd }) {
  const rootPackageJsonText = await readTextFileIfExists(join(cwd, PACKAGE_JSON_PATH));
  if (rootPackageJsonText !== undefined) {
    const rootPackageJson = parseRootPackageJson(rootPackageJsonText);
    if (isLocalPullOpsSourcePackage(rootPackageJson)) {
      return cwd;
    }
  }

  const packageRoot = await resolveExistingPath(join(cwd, LOCAL_PULL_OPS_PACKAGE_PATH));
  const packageJsonText = await readFile(join(packageRoot, 'package.json'), 'utf8');
  parseInstalledLocalPullOpsPackageJson(packageJsonText);
  return packageRoot;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string | undefined>}
 */
async function readTextFileIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<PullOpsInstallManifestState | undefined>}
 */
async function readInstallManifestState(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isInstallManifest(parsed)) {
      return undefined;
    }

    return {
      raw,
      fileEntries: parsed.files.map(entry => ({
        path: String(entry.path),
        hash: String(entry.hash),
      })),
      entries: new Map(parsed.files.map(entry => [String(entry.path), String(entry.hash)])),
    };
  } catch {
    return undefined;
  }
}

/**
 * @param {{
 *   existingFileEntries: PullOpsInstallManifestFileEntry[],
 *   managedFileEntries: PullOpsInstallManifestFileEntry[],
 *   excludedPaths?: Set<string>,
 * }} options
 * @returns {PullOpsInstallManifestFileEntry[]}
 */
function buildDesiredManifestEntries({
  existingFileEntries,
  managedFileEntries,
  excludedPaths = new Set(),
}) {
  const managedEntriesByPath = new Map(
    managedFileEntries
      .filter(entry => !excludedPaths.has(entry.path))
      .map(entry => [entry.path, entry]),
  );
  const seenManagedPaths = new Set();
  /** @type {PullOpsInstallManifestFileEntry[]} */
  const fileEntries = [];

  for (const entry of existingFileEntries) {
    if (excludedPaths.has(entry.path)) {
      continue;
    }

    const managedEntry = managedEntriesByPath.get(entry.path);
    if (managedEntry !== undefined) {
      fileEntries.push(managedEntry);
      seenManagedPaths.add(entry.path);
      continue;
    }

    fileEntries.push(entry);
  }

  for (const entry of managedFileEntries) {
    if (!excludedPaths.has(entry.path) && !seenManagedPaths.has(entry.path)) {
      fileEntries.push(entry);
    }
  }

  return fileEntries;
}

/**
 * @param {PullOpsInstallManifestFileEntry[]} left
 * @param {PullOpsInstallManifestFileEntry[]} right
 * @returns {boolean}
 */
function areManifestEntriesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (entry, index) => entry.path === right[index]?.path && entry.hash === right[index]?.hash,
  );
}

/**
 * @param {{
 *   manifestState: PullOpsInstallManifestState,
 *   managedFileStates: SetupFileState[],
 * }} options
 * @returns {boolean}
 */
function isManifestConsistentWithCurrentManagedFiles({ manifestState, managedFileStates }) {
  return managedFileStates.every(state => {
    if (state.currentContent === undefined) {
      return true;
    }

    if (state.currentContent === state.desiredContent) {
      return true;
    }

    const manifestHash = manifestState.entries.get(state.path);
    return manifestHash !== undefined && state.currentHash === manifestHash;
  });
}

/**
 * @param {{ fileEntries: PullOpsInstallManifestFileEntry[] }} options
 * @returns {string}
 */
function buildInstallManifestContents({ fileEntries }) {
  /** @type {PullOpsInstallManifest} */
  const manifest = {
    schemaVersion: 1,
    kind: 'pullops-install-manifest',
    hashAlgorithm: 'sha256',
    files: fileEntries,
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * @param {string} content
 * @returns {string}
 */
function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * @param {string} filePath
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeTextFile(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupeStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * @param {string[]} values
 * @param {string} value
 */
function addUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

/**
 * @param {{
 *   status: PullOpsSetupResult['status'],
 *   area: string,
 *   summary: string,
 *   changes: import('./init.types.js').PullOpsSetupChangeSet,
 *   changesNeeded: import('./init.types.js').PullOpsSetupChangeSet,
 *   blockers: string[],
 *   warnings: string[],
 *   suggestions: string[],
 * }} result
 * @returns {PullOpsSetupResult}
 */
function createSetupResult(result) {
  return result;
}

/**
 * @param {{
 *   profile: PullOpsSetupProfile,
 *   changesNeededCount: number,
 *   blockersCount: number,
 * }} options
 * @returns {string}
 */
function doctorSummary({ profile, blockersCount, changesNeededCount }) {
  if (blockersCount > 0) {
    return `PullOps setup doctor found blockers for the ${profile} profile.`;
  }

  if (changesNeededCount > 0) {
    return `PullOps setup doctor found incomplete setup for the ${profile} profile.`;
  }

  return `PullOps setup doctor is ready for the ${profile} profile.`;
}

/**
 * @param {string} area
 * @returns {string}
 */
function completeSummaryForArea(area) {
  if (area === SETUP_SKILLS_AREA) {
    return 'Bundled PullOps skills are already installed.';
  }

  if (area === SETUP_AGENT_DOCS_AREA) {
    return 'PullOps-compatible agent docs are already installed.';
  }

  if (area === SETUP_GITHUB_ACTIONS_AREA) {
    return 'PullOps GitHub Actions workflows are already installed.';
  }

  if (area === SETUP_GITHUB_LABELS_AREA) {
    return 'PullOps GitHub labels are already set up.';
  }

  return 'PullOps setup is already complete.';
}

/**
 * @param {{ mode: 'check' | 'apply', result: EnsureLabelsResult }} options
 * @returns {string}
 */
function summarizeGitHubLabelSetupResult({ mode, result }) {
  const totalLabels = result.created.length + result.updated.length + result.alreadyCorrect.length;
  const changedLabels = result.created.length + result.updated.length;

  if (changedLabels === 0) {
    return completeSummaryForArea(SETUP_GITHUB_LABELS_AREA);
  }

  if (mode === 'check') {
    return [
      `PullOps GitHub label setup found ${changedLabels} labels needing changes:`,
      `${result.created.length} created,`,
      `${result.updated.length} updated,`,
      `${result.alreadyCorrect.length} already correct.`,
    ].join(' ');
  }

  return [
    `Reconciled ${totalLabels} PullOps labels:`,
    `${result.created.length} created,`,
    `${result.updated.length} updated,`,
    `${result.alreadyCorrect.length} already correct.`,
  ].join(' ');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {{ blocker: string, suggestions: string[] }}
 */
function formatGitHubLabelSetupFailure(error) {
  const message = getErrorMessage(error);
  if (isMissingGitHubAuthenticationError(message)) {
    return {
      blocker: `Unable to reconcile PullOps GitHub labels: ${MISSING_GITHUB_AUTHENTICATION_BLOCKER}`,
      suggestions: missingGitHubAuthenticationSuggestions(),
    };
  }

  if (isGitHubRepositoryContextError(message)) {
    return {
      blocker: `Unable to reconcile PullOps GitHub labels: ${message}`,
      suggestions: [
        'Set GITHUB_REPOSITORY or configure remote.origin.url before rerunning PullOps setup.',
      ],
    };
  }

  return {
    blocker: `Unable to reconcile PullOps GitHub labels: ${message}`,
    suggestions: ['Rerun PullOps setup after resolving the reported GitHub API failure.'],
  };
}

/**
 * @returns {string[]}
 */
function missingGitHubAuthenticationSuggestions() {
  return [...MISSING_GITHUB_AUTHENTICATION_SUGGESTIONS];
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isMissingGitHubAuthenticationError(message) {
  return message.includes(MISSING_GITHUB_AUTHENTICATION_BLOCKER);
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isGitHubRepositoryContextError(message) {
  return (
    message.includes('GITHUB_REPOSITORY must be set to "OWNER/REPO"') ||
    message.includes('remote.origin.url must point at a GitHub repository') ||
    message.includes('Invalid GITHUB_REPOSITORY')
  );
}

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<{ blockers: string[], warnings: string[], suggestions: string[] }>}
 */
async function inspectGitHubActionsCommandPrereqs({ cwd }) {
  if (await pathExists(join(cwd, PACKAGE_LOCK_PATH))) {
    return { blockers: [], warnings: [], suggestions: [] };
  }

  return {
    blockers: [
      'Missing package-lock.json required for npm ci in PullOps GitHub Actions workflows.',
    ],
    warnings: [],
    suggestions: ['Create package-lock.json before rerunning PullOps setup.'],
  };
}

/**
 * @param {{
 *   area: string,
 *   summary: string,
 *   warnings: string[],
 *   suggestions: string[],
 *   error: unknown,
 * }} options
 * @returns {PullOpsSetupResult}
 */
function createLocalPackageLoadFailureResult({ area, summary, warnings, suggestions, error }) {
  return createSetupResult({
    status: 'blocked',
    area,
    summary,
    changes: {},
    changesNeeded: {},
    blockers: [
      `Unable to load bundled PullOps setup files from ${LOCAL_PULL_OPS_PACKAGE_PATH}: ${getErrorMessage(error)}`,
    ],
    warnings,
    suggestions: dedupeStrings([...suggestions, 'Run npm ci before rerunning PullOps setup.']),
  });
}

/**
 * @param {string} packageJsonText
 * @returns {Record<string, unknown>}
 */
function parseRootPackageJson(packageJsonText) {
  const parsedPackageJson = JSON.parse(packageJsonText);
  if (
    typeof parsedPackageJson !== 'object' ||
    parsedPackageJson === null ||
    Array.isArray(parsedPackageJson)
  ) {
    throw new Error('Root package.json must be a JSON object.');
  }

  const packageJson = /** @type {Record<string, unknown>} */ (parsedPackageJson);
  if (typeof packageJson.name !== 'string' || packageJson.name.trim() === '') {
    throw new Error('Root package.json must define a name.');
  }

  return packageJson;
}

/**
 * @param {string} packageJsonText
 * @returns {Record<string, unknown>}
 */
function parseInstalledLocalPullOpsPackageJson(packageJsonText) {
  const parsedPackageJson = JSON.parse(packageJsonText);
  if (
    typeof parsedPackageJson !== 'object' ||
    parsedPackageJson === null ||
    Array.isArray(parsedPackageJson)
  ) {
    throw new Error('Installed local PullOps package package.json must be a JSON object.');
  }

  const packageJson = /** @type {Record<string, unknown>} */ (parsedPackageJson);
  if (packageJson.name !== LOCAL_PULL_OPS_DEPENDENCY) {
    throw new Error(`Installed local PullOps package must be named ${LOCAL_PULL_OPS_DEPENDENCY}.`);
  }

  return packageJson;
}

/**
 * @param {Record<string, unknown>} packageJson
 * @returns {string | undefined}
 */
function readLocalPullOpsDependencyVersion(packageJson) {
  if (isLocalPullOpsSourcePackage(packageJson)) {
    const version = packageJson.version;
    if (typeof version === 'string' && version.trim() !== '') {
      return version;
    }
  }
  for (const key of ['dependencies', 'devDependencies']) {
    const dependencyGroup = packageJson[key];
    if (
      typeof dependencyGroup !== 'object' ||
      dependencyGroup === null ||
      Array.isArray(dependencyGroup)
    ) {
      continue;
    }

    const dependencyVersion = /** @type {Record<string, unknown>} */ (dependencyGroup)[
      LOCAL_PULL_OPS_DEPENDENCY
    ];
    if (typeof dependencyVersion === 'string' && dependencyVersion.trim() !== '') {
      return dependencyVersion;
    }
  }

  return undefined;
}

/**
 * @param {Record<string, unknown>} packageJson
 * @returns {boolean}
 */
function isLocalPullOpsSourcePackage(packageJson) {
  return packageJson.name === LOCAL_PULL_OPS_DEPENDENCY;
}

/**
 * @param {unknown} value
 * @returns {value is PullOpsInstallManifest}
 */
function isInstallManifest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'pullops-install-manifest') {
    return false;
  }

  if (manifest.hashAlgorithm !== 'sha256' || !Array.isArray(manifest.files)) {
    return false;
  }

  return manifest.files.every(file => {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      return false;
    }

    const entry = /** @type {Record<string, unknown>} */ (file);
    return typeof entry.path === 'string' && entry.path !== '' && typeof entry.hash === 'string';
  });
}
