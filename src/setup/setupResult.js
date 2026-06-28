/**
 * @typedef {import('./init.types.js').PullOpsSetupChangeSet} PullOpsSetupChangeSet
 * @typedef {import('../github/types.js').EnsureLabelsResult} EnsureLabelsResult
 */

/**
 * @param {string[]} files
 * @returns {PullOpsSetupChangeSet}
 */
export function createFileSetupChangeSet(files) {
  return files.length > 0 ? { files } : {};
}

/**
 * @param {Pick<EnsureLabelsResult, 'created' | 'updated'>} labels
 * @returns {PullOpsSetupChangeSet}
 */
export function createLabelSetupChangeSet(labels) {
  const labelChanges = {
    ...(labels.created.length > 0 ? { created: labels.created } : {}),
    ...(labels.updated.length > 0 ? { updated: labels.updated } : {}),
  };

  return Object.keys(labelChanges).length > 0 ? { labels: labelChanges } : {};
}

/**
 * @param {PullOpsSetupChangeSet[]} changeSets
 * @returns {PullOpsSetupChangeSet}
 */
export function mergeSetupChangeSets(changeSets) {
  /** @type {PullOpsSetupChangeSet} */
  const merged = {};
  const files = dedupeStrings(changeSets.flatMap(changeSet => changeSet.files ?? []));
  if (files.length > 0) {
    merged.files = files;
  }

  const createdLabels = dedupeStrings(
    changeSets.flatMap(changeSet => changeSet.labels?.created ?? []),
  );
  const updatedLabels = dedupeStrings(
    changeSets.flatMap(changeSet => changeSet.labels?.updated ?? []),
  );
  if (createdLabels.length > 0 || updatedLabels.length > 0) {
    merged.labels = {
      ...(createdLabels.length > 0 ? { created: createdLabels } : {}),
      ...(updatedLabels.length > 0 ? { updated: updatedLabels } : {}),
    };
  }

  return merged;
}

/**
 * @param {PullOpsSetupChangeSet} changeSet
 * @returns {boolean}
 */
export function hasSetupChanges(changeSet) {
  return countSetupChanges(changeSet) > 0;
}

/**
 * @param {PullOpsSetupChangeSet} changeSet
 * @returns {number}
 */
export function countSetupChanges(changeSet) {
  return (
    (changeSet.files?.length ?? 0) +
    (changeSet.labels?.created?.length ?? 0) +
    (changeSet.labels?.updated?.length ?? 0)
  );
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupeStrings(values) {
  return [...new Set(values)];
}
