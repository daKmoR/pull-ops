import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { buildIssueImplementPrompt } from './issue-implement/prompt.js';
import { buildAddressPrReviewompt } from './pr-address-review/prompt.js';
import { buildPrFinalizePrompt } from './pr-finalize/prompt.js';
import { buildPrFixCiPrompt } from './pr-fix-ci/prompt.js';
import { buildPrResolveConflictsPrompt } from './pr-resolve-conflicts/prompt.js';
import { buildPrReviewPrompt } from './pr-review/prompt.js';

/**
 * @typedef {import('../git/types.js').GitCommit} GitCommit
 * @typedef {import('../git/types.js').GitConflictContext} GitConflictContext
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./pr-address-review/feedback.types.js').PrAddressReviewFeedbackItem} PrAddressReviewFeedbackItem
 * @typedef {import('./pr-fix-ci/classification.types.js').ClassifiedCheckFailure} ClassifiedCheckFailure
 */

/** @type {GitHubIssue} */
const issue = {
  number: 42,
  title: 'Implement parser',
  body: 'Issue body.',
  state: 'OPEN',
  url: 'https://github.com/acme/widgets/issues/42',
  authorLogin: 'maintainer',
  labels: [],
  parent: {
    number: 7,
    title: 'Parent issue',
    url: 'https://github.com/acme/widgets/issues/7',
    state: 'OPEN',
    relationshipSource: 'native',
  },
  subIssues: [],
};

/** @type {GitHubPullRequest} */
const pullRequest = {
  number: 11,
  title: 'Implement parser',
  url: 'https://github.com/acme/widgets/pull/11',
  body: 'Pull request body.',
  headRefName: 'pullops/issue-42',
  isDraft: false,
};

/** @type {GitHubPullRequestReviewContext} */
const reviewContext = {
  files: [{ path: 'src/example.js', additions: 1, deletions: 0 }],
  comments: [],
  reviews: [],
  unresolvedThreads: [],
};

/** @type {GitHubPullRequestDiff} */
const diff = {
  patch: 'diff --git a/src/example.js b/src/example.js\n+change',
};

/** @type {PrAddressReviewFeedbackItem[]} */
const feedbackItems = [
  {
    id: 'thread:123456789',
    surface: 'unresolved_inline_thread',
    authorLogin: 'reviewer',
    location: 'src/example.js:42',
    body: 'Please change this.',
  },
];

/** @type {ClassifiedCheckFailure[]} */
const checkFailures = [
  {
    id: 'check-1',
    checkName: 'lint',
    classification: 'lint',
    actionable: true,
    reason: 'ESLint reported an unused variable.',
  },
];

/** @type {GitConflictContext} */
const conflictContext = {
  branchName: 'pullops/issue-42',
  baseBranch: 'main',
  currentHeadSha: 'abc123',
  conflictedFiles: [
    {
      path: 'src/example.js',
      content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch',
      baseContent: 'base',
      oursContent: 'ours',
      theirsContent: 'theirs',
      exists: true,
    },
  ],
};

/** @type {GitHubIssueReference[]} */
const closedChildIssues = [
  {
    number: 42,
    title: 'Implement parser',
    relationshipSource: 'native',
  },
];

/** @type {GitCommit[]} */
const commits = [
  {
    sha: 'abc123',
    subject: 'feat(issue): implement #42',
    body: 'Refs: #42',
    files: ['src/example.js'],
  },
];

/**
 * @typedef {{ skillName: string, prompt: string }} SkillPromptExample
 */

/** @type {SkillPromptExample[]} */
const examples = [
  {
    skillName: 'pullops-issue-implement',
    prompt: buildIssueImplementPrompt({ issue }),
  },
  {
    skillName: 'pullops-pr-review',
    prompt: buildPrReviewPrompt({ pullRequest, issue, reviewContext, diff }),
  },
  {
    skillName: 'pullops-pr-address-review',
    prompt: buildAddressPrReviewompt({
      pullRequest,
      issue,
      reviewContext,
      diff,
      feedbackItems,
    }),
  },
  {
    skillName: 'pullops-pr-fix-ci',
    prompt: buildPrFixCiPrompt({
      pullRequest,
      issue,
      reviewContext,
      diff,
      checkFailures,
    }),
  },
  {
    skillName: 'pullops-resolve-conflicts',
    prompt: buildPrResolveConflictsPrompt({
      pullRequest,
      issue,
      conflictContext,
      pass: 1,
      maxPasses: 3,
    }),
  },
  {
    skillName: 'pullops-pr-finalize',
    prompt: buildPrFinalizePrompt({
      pullRequest,
      parentIssue: issue,
      closedChildIssues,
      ambiguousReason: 'Files cannot be grouped deterministically.',
      commits,
      reviewContext,
      changedFiles: ['src/example.js', 'src/example.test.js'],
    }),
  },
];
const workerSkillNames = examples.map(example => example.skillName);

describe('PullOps skill contracts', () => {
  for (const example of examples) {
    it(`keeps ${example.skillName} JSON examples aligned with the generated prompt`, async () => {
      const [skillCompleted, skillBlocked] = await readSkillExamples(example.skillName);

      assert.deepEqual(
        exampleShape(skillCompleted),
        exampleShape(extractJsonAfter(example.prompt, 'Final response must be only JSON')),
      );
      assert.deepEqual(
        exampleShape(skillBlocked),
        exampleShape(extractJsonAfter(example.prompt, 'If blocked')),
      );
    });
  }

  it('keeps PR Finalize Child Issue commit examples traceable to the parent PRD', async () => {
    const [skillCompleted] = await readSkillExamples('pullops-pr-finalize');
    const finalizeExample = examples.find(example => example.skillName === 'pullops-pr-finalize');
    assert.ok(finalizeExample);
    const promptCompleted = extractJsonAfter(
      finalizeExample.prompt,
      'Final response must be only JSON',
    );

    assert.ok(hasPrdFooter(skillCompleted.commitPlan.commits[0].footers));
    assert.ok(hasPrdFooter(promptCompleted.commitPlan.commits[0].footers));
  });

  it('keeps worker operation skills responsible for PullOps liveness', async () => {
    for (const skillName of workerSkillNames) {
      const skillText = await readRepoFile(`.agents/skills/${skillName}/SKILL.md`);

      if (skillName === 'pullops-pr-finalize') {
        assert.match(skillText, /## Liveness/);
        assert.match(skillText, /must not run shell commands/);
        assert.match(skillText, /manual\s+heartbeats instead of `pullops step`/);
        assert.match(
          skillText,
          /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops heartbeat --summary/,
        );
        assert.match(skillText, /first tool call after reading this skill must be/);
        assert.match(skillText, /every 4 minutes/);
        assert.match(skillText, /before every fourth non-heartbeat tool call/);
        assert.match(skillText, /whichever comes\s+first/);
        assert.match(skillText, /Heartbeats must originate from this .* agent process/);
        assert.doesNotMatch(
          skillText,
          /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops step "<brief current focus>" -- <command>/,
        );
      } else {
        assert.match(skillText, /## Liveness and command execution/);
        assert.match(skillText, /Use PullOps as the command gate/);
        assert.match(
          skillText,
          /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops step "<brief current focus>" -- <command>/,
        );
        assert.match(
          skillText,
          /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops step --long "<brief current focus>" -- <command>/,
        );
        assert.match(skillText, /Do not manually count time or tool calls for shell commands/);
        assert.match(
          skillText,
          /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops heartbeat --summary/,
        );
        assert.match(skillText, /non-shell tool calls/);
        assert.match(skillText, /Heartbeats must originate from this .* agent process/);
        assert.doesNotMatch(skillText, /before every fourth non-heartbeat tool call/);
      }
      assert.match(skillText, /docs\/agents\/pullops-cli\.md/);
      assert.doesNotMatch(skillText, /npm exec pullops -- (heartbeat|step)/);
      assert.match(skillText, /not from\s+the\s+parent\s+PullOps\s+CLI/);
      assert.doesNotMatch(skillText, /PULLOPS_RUN_STATE_PATH/);
      assert.doesNotMatch(skillText, /PULLOPS_HEARTBEAT_TOKEN/);
      assert.doesNotMatch(skillText, /PULLOPS_HEARTBEAT_INTERVAL_MS/);
    }
  });

  it('keeps the repo-local issue tracker summary aligned with PullOps issue publication', async () => {
    const agentsText = await readRepoFile('AGENTS.md');

    assert.match(agentsText, /published through PullOps issue commands/i);
    assert.match(agentsText, /tracked in GitHub Issues/i);
    assert.match(agentsText, /docs\/agents\/issue-tracker\.md/);
  });

  it('keeps the repo-local issue tracker instructions routed through PullOps publish commands', async () => {
    const issueTrackerText = await readRepoFile('docs/agents/issue-tracker.md');

    assert.doesNotMatch(issueTrackerText, /gh issue create/);
    assert.match(issueTrackerText, /to-prd/);
    assert.match(issueTrackerText, /to-issues/);
    assert.match(issueTrackerText, /structured JSON/i);
    assert.match(issueTrackerText, /auditability/i);
    assert.match(issueTrackerText, /context recovery/i);
    assert.match(issueTrackerText, /pullops-cli\.md/);
    assert.match(issueTrackerText, /stdin is supported/i);
    assert.match(
      issueTrackerText,
      /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops issues publish-prd --file <path>/,
    );
    assert.match(
      issueTrackerText,
      /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops issues publish-children --file <path>/,
    );
    assert.match(
      issueTrackerText,
      /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops issues publish-issue --file <path>/,
    );
  });

  it('keeps PullOps Go supervision guidance aligned with child heartbeat liveness', async () => {
    const skillText = await readRepoFile('.agents/skills/pullops-go/SKILL.md');
    const eventSupervisionText = await readRepoFile(
      '.agents/skills/pullops-go/references/event-supervision.md',
    );
    const contractText = `${skillText}\n${eventSupervisionText}`;

    assert.match(contractText, /parent\s+`child\.heartbeat` events/);
    assert.match(contractText, /default nested-run PullOps Liveness Signal/);
    assert.match(contractText, /Child Heartbeat Events/);
    assert.match(contractText, /child\.progress[\s\S]*semantic/);
    assert.match(contractText, /must not report liveness as implementation progress/i);
    assert.match(contractText, /throttle or coalesce/);
    assert.match(contractText, /without dropping machine-readable `child\.heartbeat` JSONL events/);
    assert.match(contractText, /stream\s+interruption, sink loss, lease expiry/);
    assert.match(contractText, /postmortem inspection/);
    assert.doesNotMatch(contractText, /advanced heartbeat/);
    assert.doesNotMatch(contractText, /changed\s+child run set/);
    assert.doesNotMatch(contractText, /JSONL PullOps Progress Events plus PullOps Run State/);
    assert.match(contractText, /Progress Events[\s\S]*semantic/);
    assert.match(contractText, /5-10 minutes/);
    assert.match(contractText, /PullOps Lease/);
    assert.match(contractText, /PullOps Stall Classification/);
    assert.match(
      contractText,
      /npm_config_cache=\/tmp\/pullops-npm-cache npm exec -- pullops run prd:auto-complete/,
    );
    assert.match(contractText, /Avoid artifact, process, git, CI, or GitHub probing/i);
    assert.match(contractText, /Do not use logs, git diff, CI, or GitHub state/);
    assert.match(contractText, /Do not kill unrelated processes/);
    assert.match(contractText, /reset or discard local changes/);
    assert.match(contractText, /start\s+parallel same-branch work/);
  });

  it('keeps PullOps Go guidance aligned with external runner waiting handoffs', async () => {
    const skillText = await readRepoFile('.agents/skills/pullops-go/SKILL.md');
    const eventSupervisionText = await readRepoFile(
      '.agents/skills/pullops-go/references/event-supervision.md',
    );
    const contractText = `${skillText}\n${eventSupervisionText}`;

    assert.match(contractText, /status[\s\S]*waiting[\s\S]*runnerJob/);
    assert.match(contractText, /Local Run State[\s\S]*runnerJob/);
    assert.match(contractText, /hidden worker/i);
    assert.match(contractText, /one hidden worker at a time/i);
    assert.match(contractText, /workerPrompt/);
    assert.match(contractText, /runner_output\.json/);
    assert.match(contractText, /non-empty/);
    assert.match(contractText, /runner_result\.json/);
    assert.match(contractText, /completeCommand/);
    assert.match(contractText, /must not fake worker heartbeats/i);
    assert.match(contractText, /executable handoff/i);
    assert.doesNotMatch(contractText, /product blocker/i);
  });
});

/**
 * @param {string} skillName
 * @returns {Promise<[any, any]>}
 */
async function readSkillExamples(skillName) {
  const skillText = await readFile(
    new URL(`../../.agents/skills/${skillName}/SKILL.md`, import.meta.url),
    'utf8',
  );
  const examples = [...skillText.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match =>
    JSON.parse(match[1]),
  );

  assert.equal(examples.length, 2);
  return /** @type {[any, any]} */ (examples);
}

/**
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
async function readRepoFile(relativePath) {
  return await readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

/**
 * @param {string} text
 * @param {string} marker
 * @returns {any}
 */
function extractJsonAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  assert.notEqual(markerIndex, -1);

  const start = text.indexOf('{', markerIndex);
  assert.notEqual(start, -1);

  return JSON.parse(text.slice(start, findJsonEnd(text, start) + 1));
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error('Could not find end of JSON example.');
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function exampleShape(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [exampleShape(value[0])];
  }

  if (value !== null && typeof value === 'object') {
    const objectValue = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(objectValue)
        .sort()
        .map(key => [key, exampleShape(objectValue[key])]),
    );
  }

  return typeof value;
}

/**
 * @param {string[]} footers
 * @returns {boolean}
 */
function hasPrdFooter(footers) {
  return footers.some(footer => footer.startsWith('PRD: #'));
}
