import { createIssueSnapshot } from './issueSnapshot.js';
import { publishTickets } from './publishTickets.js';
import { publishConcreteIssue } from './publishConcreteIssue.js';
import { publishSpecIssue } from './publishSpecIssue.js';

/**
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('./types.js').IssueStore} IssueStore
 * @typedef {import('./types.js').IssueStoreContext} IssueStoreContext
 */

/**
 * Creates the Issue Store: the PullOps-owned interface for creating,
 * force-updating, reading, listing, and relating Spec Issues, Tickets,
 * Concrete Issues, and Issue Dependencies in the configured Issue Tracker.
 *
 * @param {IssueStoreContext} context
 * @returns {IssueStore}
 */
export function createIssueStore({ cwd, config, githubClient }) {
  return {
    async publishSpecIssue(rawRequest, { createdAt } = {}) {
      return await publishSpecIssue({ cwd, config, githubClient, rawRequest, createdAt });
    },

    async publishTickets(rawRequest, { parentIssueNumber, forceUpdate, createdAt } = {}) {
      return await publishTickets({
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

    async readTicketSnapshots(parentIssueNumber) {
      const parent = await githubClient.getIssue(parentIssueNumber);
      const tickets = [];
      for (const subIssue of parent.subIssues) {
        const ticket = await githubClient.getIssue(subIssue.number);
        tickets.push(createIssueSnapshot(ticket));
      }

      return tickets;
    },

    async relateTicket({ parentIssueNumber, ticketNumber }) {
      const addSubIssue = githubClient.addSubIssue;
      if (typeof addSubIssue !== 'function') {
        throw new Error('GitHub client does not support sub-issue relationships.');
      }

      await addSubIssue.call(githubClient, { parentIssueNumber, ticketNumber });
    },
  };
}
