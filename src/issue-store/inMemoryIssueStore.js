import { createIssueStore } from './IssueStore.js';

/**
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').IssueStore} IssueStore
 */

/**
 * Creates an Issue Store backed by an in-memory issue tracker instead of
 * GitHub. It is the second adapter at the Issue Store seam: the real publish,
 * read, and relate flows run unchanged against a Map of issues, so caller
 * tests exercise the same behavior as production without hand-rolled
 * GitHub client stubs.
 *
 * @param {{
 *   cwd?: string,
 *   issues?: Partial<GitHubIssue>[],
 * }} [options]
 * @returns {{
 *   store: IssueStore,
 *   issues: Map<number, GitHubIssue>,
 *   readIssue: (number: number) => GitHubIssue,
 * }}
 */
export function createInMemoryIssueStore({ cwd = process.cwd(), issues = [] } = {}) {
  /** @type {Map<number, GitHubIssue>} */
  const issuesByNumber = new Map();
  let nextIssueNumber = 1;

  for (const issue of issues) {
    const complete = completeIssue(issue, issue.number ?? nextIssueNumber);
    issuesByNumber.set(complete.number, complete);
    nextIssueNumber = Math.max(nextIssueNumber, complete.number + 1);
  }

  /**
   * @param {number} number
   * @returns {GitHubIssue}
   */
  function requireIssue(number) {
    const issue = issuesByNumber.get(number);
    if (issue === undefined) {
      throw new Error(`Issue #${number} not found.`);
    }

    return issue;
  }

  const githubClient = /** @type {import('../github/types.js').GitHubClient} */ (
    /** @type {unknown} */ ({
      /** @param {number} number */
      async getIssue(number) {
        return requireIssue(number);
      },

      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue({ title, body, labels = [] }) {
        const issue = completeIssue({ title, body, labels: [...labels] }, nextIssueNumber);
        nextIssueNumber += 1;
        issuesByNumber.set(issue.number, issue);
        return issue;
      },

      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue({ number, title, body, labels }) {
        const issue = requireIssue(number);
        if (title !== undefined) {
          issue.title = title;
        }

        if (body !== undefined) {
          issue.body = body;
        }

        if (labels !== undefined) {
          issue.labels = [...labels];
        }

        return issue;
      },

      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue({ parentIssueNumber, ticketNumber }) {
        const parent = requireIssue(parentIssueNumber);
        const ticket = requireIssue(ticketNumber);
        ticket.parent = {
          number: parent.number,
          title: parent.title,
          relationshipSource: 'native',
        };
        if (!parent.subIssues.some(subIssue => subIssue.number === ticket.number)) {
          parent.subIssues.push({
            number: ticket.number,
            title: ticket.title,
            relationshipSource: 'native',
          });
        }
      },

      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async addLabelsToIssue({ number, labels }) {
        const issue = requireIssue(number);
        issue.labels = [...new Set([...issue.labels, ...labels])];
      },

      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async removeLabelsFromIssue({ number, labels }) {
        const issue = requireIssue(number);
        issue.labels = issue.labels.filter(label => !labels.includes(label));
      },
    })
  );

  const store = createIssueStore({
    cwd,
    config: { issueStore: { provider: 'github' } },
    githubClient,
  });

  return { store, issues: issuesByNumber, readIssue: requireIssue };
}

/**
 * @param {Partial<GitHubIssue>} issue
 * @param {number} number
 * @returns {GitHubIssue}
 */
function completeIssue(issue, number) {
  return {
    number,
    title: 'Issue',
    body: '',
    state: 'OPEN',
    url: `https://github.example/issues/${number}`,
    authorLogin: 'pullops',
    labels: [],
    parent: null,
    subIssues: [],
    ...issue,
  };
}
