/**
 * @typedef {import('../../git/types.js').GitCommit} GitCommit
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubIssueReference[]} options.closedChildIssues
 * @param {string} options.ambiguousReason
 * @param {GitCommit[]} options.commits
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {string[]} options.changedFiles
 * @returns {string}
 */
export function buildPrFinalizePrompt({
  pullRequest,
  parentIssue,
  closedChildIssues,
  ambiguousReason,
  commits,
  reviewContext,
  changedFiles,
}) {
  return [
    'Use the pullops-pr-finalize skill.',
    '',
    `Plan ambiguous PR Finalize history grouping for PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    'Planner scope:',
    '- Propose commit grouping and commit messages only.',
    '- Do not edit files, run commands, create commits, reset, stage, push, edit labels, update PR bodies, change PR references, touch review state, touch checks, change draft state, change merge state, post GitHub comments, or merge the pull request.',
    '- PullOps will validate your output, apply the rewrite deterministically, push with force-with-lease, and verify the final tree still matches the reviewed tree.',
    '',
    'Why deterministic grouping stopped:',
    ambiguousReason,
    '',
    'Parent Issue context:',
    formatIssue(parentIssue),
    '',
    'Closed native Child Issues eligible for Child Issue commits:',
    formatIssueReferences(closedChildIssues),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Changed files that must be assigned exactly once:',
    formatChangedFiles(changedFiles),
    '',
    'Changed file summary:',
    formatFiles(reviewContext),
    '',
    'Current commits since base:',
    formatCommits(commits),
    '',
    'Planner constraints:',
    '- Each changed file must appear in exactly one commit files array, and no unchanged files may appear.',
    '- Prefer one commit per closed native Child Issue represented by the files.',
    '- Include parent-level commits only for explicit PRD-level files.',
    '- Commit headers must be conventional commit headers.',
    `- Child Issue commit footers must include Refs: #<child> and PRD: #${parentIssue.number}.`,
    `- Parent-level commit footers must include Refs: #${parentIssue.number}.`,
    '- Return blocked if you cannot propose a safe grouping from the supplied information.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'planned',
        summary: 'One sentence summary of the history grouping plan.',
        commitPlan: {
          justification: 'Required when grouping is not one commit per closed Child Issue.',
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Explain the logical change in this commit.'],
              footers: ['Refs: #42'],
              files: ['src/example.js', 'src/example.test.js'],
            },
          ],
        },
        followUps: ['Optional follow-up that should not block this PR.'],
      },
      null,
      2,
    ),
    '',
    'If blocked, return only JSON in this shape:',
    JSON.stringify(
      {
        status: 'blocked',
        summary: 'Short blocked summary.',
        failureReason: 'Specific reason the history grouping plan could not be produced safely.',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * @param {GitHubIssue} issue
 * @returns {string}
 */
function formatIssue(issue) {
  return [`Parent Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join(
    '\n',
  );
}

/**
 * @param {GitHubIssueReference[]} issues
 * @returns {string}
 */
function formatIssueReferences(issues) {
  if (issues.length === 0) {
    return '(none)';
  }

  return issues.map(issue => `- #${issue.number} ${issue.title}`).join('\n');
}

/**
 * @param {string[]} changedFiles
 * @returns {string}
 */
function formatChangedFiles(changedFiles) {
  if (changedFiles.length === 0) {
    return '(none)';
  }

  return changedFiles.map(file => `- ${file}`).join('\n');
}

/**
 * @param {GitCommit[]} commits
 * @returns {string}
 */
function formatCommits(commits) {
  if (commits.length === 0) {
    return '(none)';
  }

  return commits
    .map(commit =>
      [
        `- ${commit.sha} ${commit.subject}`,
        `  Files: ${commit.files.length === 0 ? '(none)' : commit.files.join(', ')}`,
        '  Message:',
        indent(commit.body),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} context
 * @returns {string}
 */
function formatFiles(context) {
  if (context.files.length === 0) {
    return '(none)';
  }

  return context.files
    .map(file => `- ${file.path} (+${file.additions} / -${file.deletions})`)
    .join('\n');
}

/**
 * @param {string} value
 * @returns {string}
 */
function indent(value) {
  return value
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
}
