import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_PULL_OPS_CONFIG } from '../config/PullOpsConfig.js';

/**
 * @typedef {import('./init.types.js').PullOpsSetupResult} PullOpsSetupResult
 * @typedef {import('./init.types.js').PullOpsInstallManifest} PullOpsInstallManifest
 * @typedef {import('./init.types.js').PullOpsInstallManifestFileEntry} PullOpsInstallManifestFileEntry
 * @typedef {import('./init.types.js').PullOpsInitOptions} PullOpsInitOptions
 */

const execFileAsync = promisify(nodeExecFile);
const SETUP_AREA = 'setup-entry';
const CONFIG_PATH = 'pullops.config.js';
const MANIFEST_PATH = '.pullops/install-manifest.json';
const SKILL_PATH = '.agents/skills/pullops-setup/SKILL.md';
const SETUP_SKILL_TEMPLATE_URL = new URL('./pullopsSetupSkill.txt', import.meta.url);

/**
 * @param {PullOpsInitOptions} [options]
 * @returns {Promise<PullOpsSetupResult>}
 */
export async function runPullOpsInit({ cwd = process.cwd(), check = false, force = false } = {}) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const repositoryRoot = await readGitRepositoryRoot(resolvedCwd);
  if (repositoryRoot === undefined) {
    return createBlockedResult({
      summary: 'PullOps init requires a git repository.',
      blockers: ['Git could not determine a repository root.'],
      suggestions: ['Run PullOps init from inside a git repository.'],
    });
  }

  const resolvedRepositoryRoot = await resolveExistingPath(repositoryRoot);
  if (resolvedRepositoryRoot !== resolvedCwd) {
    return createBlockedResult({
      summary: 'PullOps init must run from the repository root.',
      blockers: [
        `Current directory ${resolvedCwd} is not the git repository root ${resolvedRepositoryRoot}.`,
      ],
      suggestions: [`Rerun PullOps init from ${resolvedRepositoryRoot}.`],
    });
  }

  const packageJsonPath = join(resolvedCwd, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    return createBlockedResult({
      summary: 'PullOps init requires a root package.json manifest.',
      blockers: ['Missing root package.json.'],
      suggestions: ['Create a root package.json before running PullOps init.'],
    });
  }

  const configContent = buildPullOpsConfigContents();
  const skillContent = await readSetupSkillTemplate();
  const desiredManagedFileContents = new Map([
    [CONFIG_PATH, configContent],
    [SKILL_PATH, skillContent],
  ]);
  const manifestState = await readInstallManifestState(join(resolvedCwd, MANIFEST_PATH));
  const desiredManifestEntries = buildDesiredManifestEntries({
    existingFileEntries: manifestState?.fileEntries ?? [],
    managedFileEntries: [
      { path: CONFIG_PATH, hash: hashContent(configContent) },
      { path: SKILL_PATH, hash: hashContent(skillContent) },
    ],
  });
  const desiredManifestContent =
    manifestState !== undefined &&
    areManifestEntriesEqual(manifestState.fileEntries, desiredManifestEntries)
      ? manifestState.raw
      : buildInstallManifestContents({ fileEntries: desiredManifestEntries });
  const desiredFileContents = new Map([
    ...desiredManagedFileContents,
    [MANIFEST_PATH, desiredManifestContent],
  ]);
  const fileStates = await readSetupFileStates({
    cwd: resolvedCwd,
    desiredFileContents,
    manifestEntries: manifestState?.entries ?? new Map(),
  });

  /** @type {string[]} */
  const changesNeeded = [];
  /** @type {string[]} */
  const blockers = [];
  /** @type {Array<{ path: string, contents: string }>} */
  const writes = [];

  for (const state of fileStates) {
    if (state.currentContent === state.desiredContent) {
      continue;
    }

    addUnique(changesNeeded, state.path);

    if (state.currentContent === undefined) {
      writes.push({ path: state.path, contents: state.desiredContent });
      continue;
    }

    if (state.path === MANIFEST_PATH) {
      if (manifestState === undefined) {
        blockers.push(`Existing file ${state.path} is not a valid PullOps install manifest.`);
        continue;
      }

      if (
        isManifestConsistentWithCurrentManagedFiles({
          manifestState,
          managedFileStates: fileStates.filter(fileState => fileState.path !== MANIFEST_PATH),
        }) ||
        force
      ) {
        writes.push({ path: state.path, contents: state.desiredContent });
        continue;
      }

      blockers.push(
        `Existing PullOps-owned file ${state.path} has local changes. Re-run with --force to replace it.`,
      );
      continue;
    }

    if (state.manifestHash === undefined) {
      blockers.push(`Existing file ${state.path} is not manifest-owned yet.`);
      continue;
    }

    if (state.currentHash === state.manifestHash) {
      writes.push({ path: state.path, contents: state.desiredContent });
      continue;
    }

    if (!force) {
      blockers.push(
        `Existing PullOps-owned file ${state.path} has local changes. Re-run with --force to replace it.`,
      );
      continue;
    }

    writes.push({ path: state.path, contents: state.desiredContent });
  }

  if (blockers.length > 0) {
    return createBlockedResult({
      summary: 'PullOps init found existing files that require manual confirmation.',
      blockers,
      changesNeeded,
      suggestions: buildBlockedSuggestions({ force, blockers }),
    });
  }

  if (check) {
    return createSetupResult({
      status: changesNeeded.length > 0 ? 'changes-needed' : 'ready',
      area: SETUP_AREA,
      summary:
        changesNeeded.length > 0
          ? 'PullOps setup entry point is incomplete.'
          : 'PullOps setup entry point is ready.',
      changes: [],
      changesNeeded,
      blockers: [],
      warnings: [],
      suggestions:
        changesNeeded.length > 0 ? ['Run PullOps init to create the missing files.'] : [],
    });
  }

  for (const write of writes) {
    await writeTextFile(join(resolvedCwd, write.path), write.contents);
  }

  return createSetupResult({
    status: 'ready',
    area: SETUP_AREA,
    summary:
      writes.length > 0
        ? 'Installed the PullOps setup entry point.'
        : 'PullOps setup entry point is already complete.',
    changes: writes.map(write => write.path),
    changesNeeded: [],
    blockers: [],
    warnings: [],
    suggestions: [],
  });
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
 * @returns {Promise<string>}
 */
async function readSetupSkillTemplate() {
  return await readFile(SETUP_SKILL_TEMPLATE_URL, 'utf8');
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
 * @param {string} content
 * @returns {string}
 */
function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
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
 * @returns {string}
 */
function buildPullOpsConfigContents() {
  const operations = DEFAULT_PULL_OPS_CONFIG.operations;
  const config = {
    baseBranch: DEFAULT_PULL_OPS_CONFIG.baseBranch,
    branchPrefix: DEFAULT_PULL_OPS_CONFIG.branchPrefix,
    issueStore: {
      provider: 'github',
    },
    runner: DEFAULT_PULL_OPS_CONFIG.runner,
    operations: {
      prdPrepare: { modelTier: operations.prdPrepare.modelTier },
      issueImplement: { modelTier: operations.issueImplement.modelTier },
      prdAutoAdvance: { modelTier: operations.prdAutoAdvance.modelTier },
      prdAutoComplete: { modelTier: operations.prdAutoComplete.modelTier },
      prReview: { modelTier: operations.prReview.modelTier },
      prAddressReview: { modelTier: operations.prAddressReview.modelTier },
      prFixCi: { modelTier: operations.prFixCi.modelTier },
      prUpdateBranch: { modelTier: operations.prUpdateBranch.modelTier },
      prResolveConflicts: {
        modelTier: operations.prResolveConflicts.modelTier,
        maxConflictResolutionPasses: operations.prResolveConflicts.maxConflictResolutionPasses,
      },
      prFinalize: {
        modelTier: operations.prFinalize.modelTier,
        aiHistoryCleanup: operations.prFinalize.aiHistoryCleanup,
      },
      prCloseChildIssue: { modelTier: operations.prCloseChildIssue.modelTier },
    },
  };

  return `/** @type {import("@pull-ops/cli/types.js").PullOpsConfig} */\nconst config = ${JSON.stringify(
    config,
    null,
    2,
  )};\n\nexport default config;\n`;
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
 * @param {{
 *   summary: string,
 *   blockers: string[],
 *   changesNeeded?: string[],
 *   suggestions?: string[],
 * }} options
 * @returns {PullOpsSetupResult}
 */
function createBlockedResult({
  summary,
  blockers,
  changesNeeded = [],
  suggestions = ['Rerun PullOps init after addressing the blockers.'],
}) {
  return createSetupResult({
    status: 'blocked',
    area: SETUP_AREA,
    summary,
    changes: [],
    changesNeeded,
    blockers,
    warnings: [],
    suggestions,
  });
}

/**
 * @param {{ force: boolean, blockers: string[] }} options
 * @returns {string[]}
 */
function buildBlockedSuggestions({ force, blockers }) {
  if (blockers.some(blocker => blocker.includes('repository root'))) {
    return ['Rerun PullOps init from the repository root.'];
  }

  if (blockers.some(blocker => blocker.includes('package.json'))) {
    return ['Create a root package.json before rerunning PullOps init.'];
  }

  if (blockers.some(blocker => blocker.includes('valid PullOps install manifest'))) {
    return ['Remove or adopt the existing install manifest before rerunning PullOps init.'];
  }

  if (blockers.some(blocker => blocker.includes('not manifest-owned'))) {
    return ['Remove or adopt the existing file before rerunning PullOps init.'];
  }

  if (force) {
    return ['Rerun PullOps init with --force after confirming the manifest-owned files.'];
  }

  return ['Rerun PullOps init after addressing the blockers.'];
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
      entries: new Map(
        parsed.files.map(entry => [
          String(entry.path),
          String(entry.hash),
        ]),
      ),
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
