import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { buildIssueImplementPrompt } from './issue-implement/prompt.js';
import { buildAddressPrReviewompt } from './pr-address-review/prompt.js';
import { buildPrFinalizePrompt } from './pr-finalize/prompt.js';
import { buildPrFixCiPrompt } from './pr-fix-ci/prompt.js';
import { buildPrResolveConflictsPrompt } from './pr-resolve-conflicts/prompt.js';
import { buildPrReviewPrompt } from './pr-review/prompt.js';

const issue = {
  number: 42,
  title: 'Implement parser',
  body: 'Issue body.',
  parent: {
    number: 7,
    title: 'Parent issue',
  },
};

const pullRequest = {
  number: 11,
  title: 'Implement parser',
  body: 'Pull request body.',
  headRefName: 'pullops/issue-42',
};

const reviewContext = {
  files: [{ path: 'src/example.js', additions: 1, deletions: 0 }],
  comments: [],
  reviews: [],
  unresolvedThreads: [],
};

const diff = {
  patch: 'diff --git a/src/example.js b/src/example.js\n+change',
};

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
      feedbackItems: [
        {
          id: 'thread:123456789',
          surface: 'unresolved_inline_thread',
          authorLogin: 'reviewer',
          location: 'src/example.js:42',
          body: 'Please change this.',
        },
      ],
    }),
  },
  {
    skillName: 'pullops-pr-fix-ci',
    prompt: buildPrFixCiPrompt({
      pullRequest,
      issue,
      reviewContext,
      diff,
      checkFailures: [
        {
          id: 'check-1',
          checkName: 'lint',
          classification: 'lint',
          actionable: true,
          reason: 'ESLint reported an unused variable.',
        },
      ],
    }),
  },
  {
    skillName: 'pullops-resolve-conflicts',
    prompt: buildPrResolveConflictsPrompt({
      pullRequest,
      issue,
      conflictContext: {
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
          },
        ],
      },
      pass: 1,
      maxPasses: 3,
    }),
  },
  {
    skillName: 'pullops-pr-finalize',
    prompt: buildPrFinalizePrompt({
      pullRequest,
      parentIssue: issue,
      closedChildIssues: [{ number: 42, title: 'Implement parser' }],
      ambiguousReason: 'Files cannot be grouped deterministically.',
      commits: [
        {
          sha: 'abc123',
          subject: 'feat(issue): implement #42',
          body: 'Refs: #42',
          files: ['src/example.js'],
        },
      ],
      reviewContext,
      changedFiles: ['src/example.js', 'src/example.test.js'],
    }),
  },
];

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
    const promptCompleted = extractJsonAfter(
      examples.find(example => example.skillName === 'pullops-pr-finalize').prompt,
      'Final response must be only JSON',
    );

    assert.ok(hasPrdFooter(skillCompleted.commitPlan.commits[0].footers));
    assert.ok(hasPrdFooter(promptCompleted.commitPlan.commits[0].footers));
  });
});

async function readSkillExamples(skillName) {
  const skillText = await readFile(
    new URL(`../../.agents/skills/${skillName}/SKILL.md`, import.meta.url),
    'utf8',
  );
  const examples = [...skillText.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match =>
    JSON.parse(match[1]),
  );

  assert.equal(examples.length, 2);
  return examples;
}

function extractJsonAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  assert.notEqual(markerIndex, -1);

  const start = text.indexOf('{', markerIndex);
  assert.notEqual(start, -1);

  return JSON.parse(text.slice(start, findJsonEnd(text, start) + 1));
}

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

function exampleShape(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [exampleShape(value[0])];
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, exampleShape(value[key])]),
    );
  }

  return typeof value;
}

function hasPrdFooter(footers) {
  return footers.some(footer => footer.startsWith('PRD: #'));
}
