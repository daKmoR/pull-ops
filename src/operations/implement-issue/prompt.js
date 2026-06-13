/**
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 */

/**
 * @param {{ issue: GitHubIssue }} options
 * @returns {string}
 */
export function buildImplementIssuePrompt({ issue }) {
  return [
    'Use the pullops-implement-issue skill.',
    '',
    ...formatParentContext(issue),
    `Implement GitHub Issue #${issue.number}: ${issue.title}`,
    '',
    'Issue body:',
    issue.body.trim() || '(empty)',
    '',
    'Constraints:',
    '- Implement the issue as written.',
    '- Keep changes focused, allowing only adjacent work needed to complete the issue correctly.',
    '- Run focused verification that is appropriate for the change.',
    '- Do not create a commit or pull request; PullOps will do that after validating your output.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'implemented',
        summary: 'One sentence summary of the completed implementation.',
        changes: ['Specific code, test, or documentation change.'],
        testPlan: ['Command or manual check that was run.'],
        followUps: ['Optional follow-up that should not be folded into this issue.'],
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
        failureReason: 'Specific reason the issue could not be implemented.',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * @param {GitHubIssue} issue
 * @returns {string[]}
 */
function formatParentContext(issue) {
  if (issue.parent === null) {
    return [];
  }

  return [
    `Parent PRD Issue #${issue.parent.number}: ${issue.parent.title ?? '(title unavailable)'}`,
    'This is a manually selected PRD sub-issue. Implement only the selected sub-issue, using the parent PRD as context.',
    '',
  ];
}
