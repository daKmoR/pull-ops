/**
 * @typedef {import('./output.js').ReviewInlineComment} ReviewInlineComment
 * @typedef {{
 *   comment: ReviewInlineComment;
 *   reason: string;
 * }} DroppedReviewComment
 */

/**
 * @param {{ comments: ReviewInlineComment[], patch: string }} options
 * @returns {{ publishable: ReviewInlineComment[], dropped: DroppedReviewComment[] }}
 */
export function filterCommentsToDiffAnchors({ comments, patch }) {
  const reviewableLines = collectReviewableDiffLines(patch);
  /** @type {ReviewInlineComment[]} */
  const publishable = [];
  /** @type {DroppedReviewComment[]} */
  const dropped = [];

  for (const comment of comments) {
    const fileLines = reviewableLines.get(comment.path);
    if (fileLines === undefined) {
      dropped.push({
        comment,
        reason: `Path ${comment.path} is not present in the pull request diff.`,
      });
      continue;
    }

    if (!fileLines.has(comment.line)) {
      dropped.push({
        comment,
        reason: `Line ${comment.line} in ${comment.path} is not an added line in the pull request diff.`,
      });
      continue;
    }

    publishable.push(comment);
  }

  return { publishable, dropped };
}

/**
 * @param {string} patch
 * @returns {Map<string, Set<number>>}
 */
export function collectReviewableDiffLines(patch) {
  /** @type {Map<string, Set<number>>} */
  const result = new Map();
  /** @type {string | undefined} */
  let path;
  /** @type {number | undefined} */
  let nextNewLine;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      path = parseNewFilePath(line);
      nextNewLine = undefined;
      if (path !== undefined && !result.has(path)) {
        result.set(path, new Set());
      }
      continue;
    }

    if (line.startsWith('@@')) {
      nextNewLine = parseNewHunkStart(line);
      continue;
    }

    if (path === undefined || nextNewLine === undefined || line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('+')) {
      result.get(path)?.add(nextNewLine);
      nextNewLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      continue;
    }

    nextNewLine += 1;
  }

  return result;
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseNewFilePath(line) {
  const rawPath = line.replace(/^\+\+\+\s+/, '').trim();
  if (rawPath === '/dev/null') {
    return undefined;
  }

  return rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
}

/**
 * @param {string} line
 * @returns {number | undefined}
 */
function parseNewHunkStart(line) {
  const match = line.match(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (match?.[1] === undefined) {
    return undefined;
  }

  return Number(match[1]);
}
