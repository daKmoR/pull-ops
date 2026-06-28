import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadPullOpsConfig } from '../config/PullOpsConfig.js';

/**
 * @typedef {import('./init.types.js').PullOpsInstallManifest} PullOpsInstallManifest
 * @typedef {import('./init.types.js').PullOpsInstallManifestFileEntry} PullOpsInstallManifestFileEntry
 * @typedef {import('./init.types.js').PullOpsSetupResult} PullOpsSetupResult
 * @typedef {import('./setup.types.js').PullOpsSetupCommandOptions} PullOpsSetupCommandOptions
 * @typedef {import('./setup.types.js').PullOpsSetupDoctorOptions} PullOpsSetupDoctorOptions
 * @typedef {import('./setup.types.js').PullOpsSetupProfile} PullOpsSetupProfile
 */

const execFileAsync = promisify(nodeExecFile);
const CONFIG_PATH = 'pullops.config.js';
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

const SETUP_SKILLS_AREA = 'setup-skills';
const SETUP_AGENT_DOCS_AREA = 'setup-agent-docs';
const SETUP_DOCTOR_AREA = 'setup-doctor';

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
 * @param {PullOpsSetupDoctorOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsSetupDoctor({ cwd = process.cwd(), profile = 'full' } = {}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const prereqResult = await readSetupPrereqs({ cwd: resolvedCwd, verifyRuntime: true });
  if (prereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area: SETUP_DOCTOR_AREA,
      summary: doctorSummary('blocked', profile),
      changes: [],
      changesNeeded: [],
      blockers: prereqResult.blockers,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
    });
  }

  const desiredFileContents = new Map();
  try {
    if (profile === 'full' || profile === 'local') {
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
  } catch (error) {
    return createLocalPackageLoadFailureResult({
      area: SETUP_DOCTOR_AREA,
      summary: doctorSummary('blocked', profile),
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

  const optionalAuthoringResult =
    profile === 'full' || profile === 'authoring'
      ? await inspectOptionalAuthoringSkills({ cwd: resolvedCwd })
      : { warnings: [], suggestions: [] };
  const runsIgnoreResult = await inspectPullOpsRunsIgnore({ cwd: resolvedCwd });

  const blockers = inspection.blockers;
  const changesNeeded = inspection.changesNeeded;
  const warnings = dedupeStrings([
    ...prereqResult.warnings,
    ...inspection.warnings,
    ...optionalAuthoringResult.warnings,
    ...runsIgnoreResult.warnings,
  ]);
  const suggestions = dedupeStrings([
    ...prereqResult.suggestions,
    ...inspection.suggestions,
    ...optionalAuthoringResult.suggestions,
    ...runsIgnoreResult.suggestions,
  ]);
  const status =
    blockers.length > 0 ? 'blocked' : changesNeeded.length > 0 ? 'changes-needed' : 'ready';

  return createSetupResult({
    status,
    area: SETUP_DOCTOR_AREA,
    summary: doctorSummary(status, profile),
    changes: [],
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
  preserveUnmanagedExistingPaths = new Set(),
}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const prereqResult = await readSetupPrereqs({ cwd: resolvedCwd, verifyRuntime: true });
  if (prereqResult.blockers.length > 0) {
    return createSetupResult({
      status: 'blocked',
      area,
      summary: prereqResult.suggestions[0] ?? incompleteSummary,
      changes: [],
      changesNeeded: [],
      blockers: prereqResult.blockers,
      warnings: prereqResult.warnings,
      suggestions: prereqResult.suggestions,
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
      changes: [],
      changesNeeded: inspection.changesNeeded,
      blockers: inspection.blockers,
      warnings: inspection.warnings,
      suggestions: inspection.suggestions,
    });
  }

  if (check) {
    return createSetupResult({
      status: inspection.changesNeeded.length > 0 ? 'changes-needed' : 'ready',
      area,
      summary: inspection.changesNeeded.length > 0 ? incompleteSummary : readySummary,
      changes: [],
      changesNeeded: inspection.changesNeeded,
      blockers: [],
      warnings: inspection.warnings,
      suggestions: inspection.changesNeeded.length > 0 ? inspection.suggestions : [],
    });
  }

  for (const write of inspection.writes) {
    await writeTextFile(join(resolvedCwd, write.path), write.contents);
  }

  return createSetupResult({
    status: 'ready',
    area,
    summary: inspection.writes.length > 0 ? readySummary : completeSummaryForArea(area),
    changes: inspection.writes.map(write => write.path),
    changesNeeded: [],
    blockers: [],
    warnings: inspection.warnings,
    suggestions: inspection.suggestions,
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

  const configState = await readManifestFileState({
    cwd: resolvedCwd,
    manifestEntries: manifestState.entries,
    path: CONFIG_PATH,
  });
  if (configState.currentContent === undefined) {
    return {
      changesNeeded: [],
      blockers: ['Missing required PullOps config pullops.config.js.'],
      warnings: [],
      suggestions: ['Run PullOps init before using PullOps setup commands.'],
      writes: [],
    };
  }

  if (configState.manifestHash === undefined) {
    return {
      changesNeeded: [],
      blockers: ['pullops.config.js is not manifest-owned yet.'],
      warnings: [],
      suggestions: ['Run PullOps init before using PullOps setup commands.'],
      writes: [],
    };
  }

  if (configState.currentHash !== configState.manifestHash) {
    return {
      changesNeeded: [],
      blockers: [
        `Existing PullOps-owned file ${CONFIG_PATH} has local changes. Re-run with --force to replace it.`,
      ],
      warnings: [],
      suggestions: ['Restore pullops.config.js before rerunning PullOps setup.'],
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
  /** @type {Map<string, string>} */
  const managedDesiredFileContents = new Map();
  for (const state of desiredFileStates) {
    if (
      shouldPreserveExistingUnmanagedSetupFile({
        state,
        preserveUnmanagedExistingPaths,
      })
    ) {
      continue;
    }

    managedDesiredFileContents.set(state.path, state.desiredContent);
  }

  const manifestConflictBlockers = await collectManifestConflictBlockers({
    cwd: resolvedCwd,
    manifestState,
    desiredPaths: new Set(managedDesiredFileContents.keys()),
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

  /** @type {string[]} */
  const changesNeeded = [];
  /** @type {Array<{ path: string, contents: string }>} */
  const writes = [];

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

  const packageLockPath = join(resolvedCwd, PACKAGE_LOCK_PATH);
  if (!(await pathExists(packageLockPath))) {
    blockers.push(
      'Missing package-lock.json required for npm ci and the local PullOps dependency.',
    );
    suggestions.push('Create package-lock.json before rerunning PullOps setup.');
  }

  const packageJsonPath = join(resolvedCwd, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    blockers.push('Missing root package.json.');
    suggestions.push('Create a root package.json before rerunning PullOps setup.');
  } else {
    /** @type {Record<string, unknown> | undefined} */
    let packageJson;
    try {
      const packageJsonText = await readFile(packageJsonPath, 'utf8');
      const parsedPackageJson = JSON.parse(packageJsonText);
      if (
        typeof parsedPackageJson !== 'object' ||
        parsedPackageJson === null ||
        Array.isArray(parsedPackageJson)
      ) {
        throw new Error('Root package.json must be a JSON object.');
      }
      const validatedPackageJson = /** @type {Record<string, unknown>} */ (parsedPackageJson);
      if (
        typeof validatedPackageJson.name !== 'string' ||
        validatedPackageJson.name.trim() === ''
      ) {
        throw new Error('Root package.json must define a name.');
      }
      packageJson = validatedPackageJson;
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

    const installedLocalPullOpsPackageStatus = await inspectInstalledLocalPullOpsPackage({
      cwd: resolvedCwd,
    });
    blockers.push(...installedLocalPullOpsPackageStatus.blockers);
    suggestions.push(...installedLocalPullOpsPackageStatus.suggestions);

    const localPullOpsExecutableStatus = await inspectLocalPullOpsExecutable({ cwd: resolvedCwd });
    blockers.push(...localPullOpsExecutableStatus.blockers);
    suggestions.push(...localPullOpsExecutableStatus.suggestions);
  }

  const manifestState = await readInstallManifestState(join(resolvedCwd, MANIFEST_PATH));
  if (manifestState === undefined) {
    blockers.push(
      'Existing file .pullops/install-manifest.json is not a valid PullOps install manifest.',
    );
    suggestions.push('Run PullOps init before using PullOps setup commands.');
    return { blockers, warnings, suggestions, manifestState: undefined };
  }

  const configState = await readManifestFileState({
    cwd: resolvedCwd,
    manifestEntries: manifestState.entries,
    path: CONFIG_PATH,
  });
  if (configState.currentContent === undefined) {
    blockers.push('Missing required PullOps config pullops.config.js.');
    suggestions.push('Run PullOps init before using PullOps setup commands.');
  } else if (configState.manifestHash === undefined) {
    blockers.push('pullops.config.js is not manifest-owned yet.');
    suggestions.push('Run PullOps init before using PullOps setup commands.');
  } else if (configState.currentHash !== configState.manifestHash) {
    blockers.push(
      `Existing PullOps-owned file ${CONFIG_PATH} has local changes. Re-run with --force to replace it.`,
    );
    suggestions.push('Restore pullops.config.js before rerunning PullOps setup.');
  }

  try {
    await loadPullOpsConfig({ cwd });
  } catch (error) {
    blockers.push(`Unable to load PullOps Config from ${CONFIG_PATH}: ${getErrorMessage(error)}`);
    suggestions.push('Fix pullops.config.js before rerunning PullOps setup.');
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
    await execFileAsync('node', ['--version']);
    return { blockers: [], suggestions: [] };
  } catch {
    return {
      blockers: ['Node executable is not available on PATH.'],
      suggestions: ['Install Node.js or expose node on PATH before rerunning PullOps setup.'],
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
 *   force: boolean,
 * }} options
 * @returns {Promise<string[]>}
 */
async function collectManifestConflictBlockers({ cwd, manifestState, desiredPaths, force }) {
  /** @type {string[]} */
  const blockers = [];

  for (const fileEntry of manifestState.fileEntries) {
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
    warnings: [
      `Missing optional authoring skills: ${missing.join(', ')}.`,
      'If you want those skills, install them manually with npx skills@latest add mattpocock/skills.',
    ],
    suggestions: [],
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
 * @param {{
 *   cwd: string,
 *   manifestEntries: Map<string, string>,
 *   path: string,
 * }} options
 * @returns {Promise<ManifestFileState>}
 */
async function readManifestFileState({ cwd, manifestEntries, path }) {
  const currentContent = await readTextFileIfExists(join(cwd, path));
  return {
    currentContent,
    currentHash: currentContent === undefined ? undefined : hashContent(currentContent),
    manifestHash: manifestEntries.get(path),
  };
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
 * }} options
 * @returns {PullOpsInstallManifestFileEntry[]}
 */
function buildDesiredManifestEntries({ existingFileEntries, managedFileEntries }) {
  const managedEntriesByPath = new Map(managedFileEntries.map(entry => [entry.path, entry]));
  const seenManagedPaths = new Set();
  /** @type {PullOpsInstallManifestFileEntry[]} */
  const fileEntries = [];

  for (const entry of existingFileEntries) {
    const managedEntry = managedEntriesByPath.get(entry.path);
    if (managedEntry !== undefined) {
      fileEntries.push(managedEntry);
      seenManagedPaths.add(entry.path);
      continue;
    }

    fileEntries.push(entry);
  }

  for (const entry of managedFileEntries) {
    if (!seenManagedPaths.has(entry.path)) {
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
 * @param {{ state: SetupFileState, preserveUnmanagedExistingPaths: Set<string> }} options
 * @returns {boolean}
 */
function shouldPreserveExistingUnmanagedSetupFile({ state, preserveUnmanagedExistingPaths }) {
  return (
    state.currentContent !== undefined &&
    state.manifestHash === undefined &&
    preserveUnmanagedExistingPaths.has(state.path)
  );
}

/**
 * @param {{
 *   status: PullOpsSetupResult['status'],
 *   area: string,
 *   summary: string,
 *   changes: string[],
 *   changesNeeded: string[],
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
 * @param {PullOpsSetupProfile} profile
 * @param {PullOpsSetupResult['status']} status
 * @returns {string}
 */
function doctorSummary(status, profile) {
  if (status === 'blocked') {
    return `PullOps setup doctor found blockers for the ${profile} profile.`;
  }

  if (status === 'changes-needed') {
    return `PullOps setup doctor found setup work for the ${profile} profile.`;
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

  return 'PullOps setup is already complete.';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    changes: [],
    changesNeeded: [],
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

/**
 * @typedef {object} SetupFileState
 * @property {string} path
 * @property {string | undefined} currentContent
 * @property {string} desiredContent
 * @property {string | undefined} currentHash
 * @property {string | undefined} manifestHash
 */

/**
 * @typedef {object} PullOpsInstallManifestState
 * @property {string} raw
 * @property {PullOpsInstallManifestFileEntry[]} fileEntries
 * @property {Map<string, string>} entries
 */

/**
 * @typedef {object} ManifestFileState
 * @property {string | undefined} currentContent
 * @property {string | undefined} currentHash
 * @property {string | undefined} manifestHash
 */

/**
 * @typedef {object} SetupInspectionResult
 * @property {string[]} changesNeeded
 * @property {string[]} blockers
 * @property {string[]} warnings
 * @property {string[]} suggestions
 * @property {Array<{ path: string, contents: string }>} writes
 */

/**
 * @typedef {object} SetupPrereqResult
 * @property {string[]} blockers
 * @property {string[]} warnings
 * @property {string[]} suggestions
 * @property {PullOpsInstallManifestState | undefined} manifestState
 */

/**
 * @typedef {(options: { cwd: string }) => Promise<Map<string, string>>} SetupFileCollector
 */
