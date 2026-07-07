import { createIssueSnapshot } from './issueSnapshot.js';
import { publishChildIssues } from './publishChildIssues.js';
import { publishConcreteIssue } from './publishConcreteIssue.js';
import { publishPrdIssue } from './publishPrdIssue.js';

/**
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('./types.js').IssueStore} IssueStore
 * @typedef {import('./types.js').IssueStoreContext} IssueStoreContext
 */

/**
 * Creates the Issue Store: the PullOps-owned interface for creating,
 * force-updating, reading, listing, and relating PRD Issues, Child Issues,
 * Concrete Issues, and Issue Dependencies in the configured Issue Tracker.
 *
 * @param {IssueStoreContext} context
 * @returns {IssueStore}
 */
export function createIssueStore({ cwd, config, githubClient }) {
  return {
    async publishPrdIssue(rawRequest, { createdAt } = {}) {
      return await publishPrdIssue({ cwd, config, githubClient, rawRequest, createdAt });
    },

    async publishChildIssues(rawRequest, { parentIssueNumber, forceUpdate, createdAt } = {}) {
      return await publishChildIssues({
        cwd,
        config,
        githubClient,
        rawRequest,
        parentIssueNumber,
        forceUpdate,
        createdAt,
      });
    },

    async publishConcreteIssue(rawRequest, { createdAt } = {}) {
      return await publishConcreteIssue({ cwd, config, githubClient, rawRequest, createdAt });
    },

    async readIssueSnapshot(issueNumber) {
      const issue = await githubClient.getIssue(issueNumber);
      return createIssueSnapshot(issue);
    },

    async readChildIssueSnapshots(parentIssueNumber) {
      const parent = await githubClient.getIssue(parentIssueNumber);
      const children = [];
      for (const subIssue of parent.subIssues) {
        const child = await githubClient.getIssue(subIssue.number);
        children.push(createIssueSnapshot(child));
      }

      return children;
    },

    async relateChildIssue({ parentIssueNumber, childIssueNumber }) {
      const addSubIssue = githubClient.addSubIssue;
      if (typeof addSubIssue !== 'function') {
        throw new Error('GitHub client does not support sub-issue relationships.');
      }

      await addSubIssue.call(githubClient, { parentIssueNumber, childIssueNumber });
    },
  };
}
