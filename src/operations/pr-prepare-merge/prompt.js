/**
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.issue
 * @param {'issue' | 'parentIssue'} options.sourceKind
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @param {string[]} options.changedFiles
 * @returns {string}
 */
export function buildPrPrepareMergePrompt({
  pullRequest,
  issue,
  sourceKind,
  reviewContext,
  diff,
  changedFiles,
}) {
  return [
    'Use the pullops-pr-prepare-merge skill.',
    '',
    `Prepare merge for PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    'Linked source context:',
    formatIssue(issue, sourceKind),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Changed files that must be assigned exactly once in the Commit Plan:',
    formatChangedFiles(changedFiles),
    '',
    'Changed file summary:',
    formatFiles(reviewContext),
    '',
    'Pull request diff:',
    diff.patch.trim() || '(empty)',
    '',
    'Commit Plan constraints:',
    '- Propose the final Logical Commit Stack only; do not create commits, reset, stage, push, edit labels, update the PR body, or post GitHub comments.',
    '- Each changed file must appear in exactly one commit files array.',
    '- Commit headers must be conventional commit headers.',
    '- Commit footers must include traceability. Use Refs: #<issue> footers for the concrete work and PRD: #<parent> when applicable.',
    '- Concrete Issue PRs default to one logical commit. If more than one commit is necessary, include commitPlan.justification.',
    '- Parent Issue PRs default to one Child Issue Commit per merged Child Issue PR.',
    '- Prepare Merge is history cleanup and PR summary cleanup only. Never merge the PR.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'planned',
        summary: 'One sentence summary of the prepared merge plan.',
        commitPlan: {
          justification: 'Required only when a Concrete Issue PR needs multiple commits.',
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Explain the logical change in this commit.'],
              footers: ['Refs: #42'],
              files: ['src/example.js', 'src/example.test.js'],
            },
          ],
        },
        pullRequest: {
          summary: 'Updated PR summary for human review.',
          changes: ['Specific user-facing or code change in the final PR.'],
          testPlan: ['Command or manual check represented by the final PR.'],
          traceability: ['Closes #42'],
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
        failureReason: 'Specific reason the Commit Plan could not be produced safely.',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * @param {GitHubIssue} issue
 * @param {'issue' | 'parentIssue'} sourceKind
 * @returns {string}
 */
function formatIssue(issue, sourceKind) {
  const label = sourceKind === 'parentIssue' ? 'Parent Issue' : 'Issue';
  return [`${label} #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n');
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
