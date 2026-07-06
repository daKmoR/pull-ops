import { join } from 'node:path';

import {
  getOperationCatalogOperationLabelReferences,
  getOperationCatalogWorkflowFileName,
  getOperationCatalogWorkflowOperations,
} from '../operations/operationCatalog.js';

/**
 * @typedef {import('../operations/types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../runner/types.js').RunnerCommandCli} RunnerCommandCli
 * @typedef {{ prResolveConflictsMaxPasses: number, runnerCli: RunnerCommandCli }} WorkflowRenderOptions
 */

const WORKFLOW_ROOT = join('.github', 'workflows');
const DEFAULT_PR_RESOLVE_CONFLICTS_MAX_PASSES = 3;

/** @type {RunnerCommandCli} */
const DEFAULT_RUNNER_CLI = 'codex';

/**
 * @param {Partial<WorkflowRenderOptions>} [options]
 * @returns {Map<string, string>}
 */
export function renderPullOpsGitHubActionsWorkflowFiles({
  prResolveConflictsMaxPasses = DEFAULT_PR_RESOLVE_CONFLICTS_MAX_PASSES,
  runnerCli = DEFAULT_RUNNER_CLI,
} = {}) {
  /** @type {Map<string, string>} */
  const workflows = new Map();
  workflows.set(join(WORKFLOW_ROOT, 'pullops-dispatch.yml'), renderDispatchWorkflow());

  for (const operation of getOperationCatalogWorkflowOperations()) {
    const workflowFileName =
      getOperationCatalogWorkflowFileName(operation.name) ?? `pullops-${operation.name}.yml`;
    workflows.set(
      join(WORKFLOW_ROOT, workflowFileName),
      renderWorkflowOperation(operation.name, { prResolveConflictsMaxPasses, runnerCli }),
    );
  }

  return workflows;
}

/**
 * @param {WorkflowOperation['name']} operationName
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderWorkflowOperation(operationName, options) {
  const renderer = WORKFLOW_RENDERERS[operationName];
  if (renderer === undefined) {
    throw new Error(`No PullOps workflow renderer is registered for ${operationName}.`);
  }

  return renderer(options);
}

/**
 * @returns {string}
 */
function renderDispatchWorkflow() {
  const issueLabelReferences = getOperationCatalogOperationLabelReferences().filter(
    operation => operation.target === 'issue',
  );
  const pullRequestLabelReferences = getOperationCatalogOperationLabelReferences().filter(
    operation => operation.target === 'pr',
  );
  const issueConditions = issueLabelReferences
    .map(operation => `        github.event.label.name == '${operation.label}'`)
    .join(' ||\n');
  const pullRequestConditions = pullRequestLabelReferences
    .map(operation => `        github.event.label.name == '${operation.label}'`)
    .join(' ||\n');
  const issueDispatchMappings = issueLabelReferences
    .map(
      operation =>
        `              '${operation.label}': '${
          getOperationCatalogWorkflowFileName(operation.workflowOperationName) ??
          `pullops-${operation.workflowOperationName}.yml`
        }',`,
    )
    .join('\n');
  const pullRequestDispatchMappings = pullRequestLabelReferences
    .map(
      operation =>
        `              '${operation.label}': '${
          getOperationCatalogWorkflowFileName(operation.workflowOperationName) ??
          `pullops-${operation.workflowOperationName}.yml`
        }',`,
    )
    .join('\n');

  return renderWorkflow(`name: PullOps Dispatch

on:
  issues:
    types:
      - labeled
  pull_request_target:
    types:
      - labeled

permissions:
  actions: write
  issues: read
  pull-requests: read

jobs:
  dispatch-issue:
    if: >-
      github.event_name == 'issues' &&
      (
${issueConditions}
      )
    runs-on: ubuntu-latest
    steps:
      - name: Verify trigger actor can run PullOps operations
        uses: actions/github-script@v8
        env:
          TRIGGER_ACTOR: @@{{ github.actor }}
        with:
          github-token: @@{{ github.token }}
          script: |
            const { owner, repo } = context.repo;
            const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
              owner,
              repo,
              username: process.env.TRIGGER_ACTOR,
            });

            if (!['admin', 'maintain', 'write'].includes(data.permission)) {
              core.setFailed(
                \`Actor '@@{process.env.TRIGGER_ACTOR}' must have write access to run PullOps workflows. Detected permission: '@@{data.permission}'.\`,
              );
            }

      - name: Dispatch issue operation workflow
        uses: actions/github-script@v8
        env:
          LABEL: @@{{ github.event.label.name }}
          ISSUE: @@{{ github.event.issue.number }}
          TRIGGER_ACTOR: @@{{ github.actor }}
        with:
          github-token: @@{{ github.token }}
          script: |
            const workflows = {
${issueDispatchMappings}
            };
            const workflow_id = workflows[process.env.LABEL];
            if (workflow_id === undefined) {
              core.setFailed(\`Unsupported PullOps label '@@{process.env.LABEL}'.\`);
              return;
            }

            const { owner, repo } = context.repo;
            await github.rest.actions.createWorkflowDispatch({
              owner,
              repo,
              workflow_id,
              ref: process.env.GITHUB_REF_NAME,
              inputs: {
                issue: process.env.ISSUE,
                trigger_actor: process.env.TRIGGER_ACTOR,
              },
            });

  dispatch-pull-request:
    if: >-
      github.event_name == 'pull_request_target' &&
      (
${pullRequestConditions}
      ) &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Verify trigger actor can run PullOps operations
        uses: actions/github-script@v8
        env:
          TRIGGER_ACTOR: @@{{ github.actor }}
        with:
          github-token: @@{{ github.token }}
          script: |
            const { owner, repo } = context.repo;
            const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
              owner,
              repo,
              username: process.env.TRIGGER_ACTOR,
            });

            if (!['admin', 'maintain', 'write'].includes(data.permission)) {
              core.setFailed(
                \`Actor '@@{process.env.TRIGGER_ACTOR}' must have write access to run PullOps workflows. Detected permission: '@@{data.permission}'.\`,
              );
            }

      - name: Dispatch pull request operation workflow
        uses: actions/github-script@v8
        env:
          LABEL: @@{{ github.event.label.name }}
          PR: @@{{ github.event.pull_request.number }}
          HEAD_REF: @@{{ github.event.pull_request.head.ref }}
          TRIGGER_ACTOR: @@{{ github.actor }}
        with:
          github-token: @@{{ github.token }}
          script: |
            const workflows = {
${pullRequestDispatchMappings}
            };
            const workflow_id = workflows[process.env.LABEL];
            if (workflow_id === undefined) {
              core.setFailed(\`Unsupported PullOps label '@@{process.env.LABEL}'.\`);
              return;
            }

            const { owner, repo } = context.repo;
            await github.rest.actions.createWorkflowDispatch({
              owner,
              repo,
              workflow_id,
              ref: process.env.GITHUB_REF_NAME,
              inputs: {
                pr: process.env.PR,
                head_ref: process.env.HEAD_REF,
                trigger_actor: process.env.TRIGGER_ACTOR,
              },
            });
`);
}

/**
 * @returns {string}
 */
function renderPrdPrepareWorkflow() {
  return renderWorkflow(`name: PullOps PRD Prepare

on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: pullops-prd-prepare-@@{{ inputs.issue }}
  cancel-in-progress: false

jobs:
  prd-prepare:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run PullOps prepare PRD
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run prd-prepare --issue @@{{ inputs.issue }}
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
`);
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderIssueImplementWorkflow(options) {
  return renderWorkflow(`name: PullOps Issue Implement

on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: pullops-issue-implement-@@{{ inputs.issue }}
  cancel-in-progress: false

jobs:
  issue-implement:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare PullOps implement issue
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          npm exec pullops -- run issue-implement \\
            --phase prepare \\
            --runner external \\
            --issue "@@{{ inputs.issue }}" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}

${renderExternalRunnerSteps(options, { gateIf: "steps.prepare.outputs.run_runner == 'true'" })}

      - name: Restore Node for PullOps complete
        if: always()
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Record successful runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome == 'success'
        run: npm exec pullops -- runner-result --status success --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record failed runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome != 'success' && steps.runner.outcome != 'cancelled'
        run: npm exec pullops -- runner-result --status failed --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record cancelled runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome == 'cancelled'
        run: npm exec pullops -- runner-result --status cancelled --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record skipped runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner != 'true'
        run: npm exec pullops -- runner-result --status skipped --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Complete PullOps implement issue
        if: always() && steps.prepare.outcome == 'success'
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run issue-implement \\
            --phase complete \\
            --runner external \\
            --issue "@@{{ inputs.issue }}"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
`);
}

/**
 * @returns {string}
 */
function renderPrdAutoAdvanceWorkflow() {
  return renderWorkflow(`name: PullOps PRD Auto Advance

on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: pullops-prd-auto-advance-@@{{ inputs.issue }}
  cancel-in-progress: false

jobs:
  prd-auto-advance:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run PullOps PRD auto-advance
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run prd-auto-advance --issue @@{{ inputs.issue }}
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
`);
}

/**
 * @returns {string}
 */
function renderPrdAutoCompleteWorkflow() {
  return renderWorkflow(`name: PullOps PRD Auto Complete

on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: pullops-prd-auto-complete-@@{{ inputs.issue }}
  cancel-in-progress: false

jobs:
  prd-auto-complete:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run PullOps PRD auto-complete
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run prd-auto-complete --issue @@{{ inputs.issue }}
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
`);
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrReviewWorkflow(options) {
  return renderWorkflow(`name: PullOps PR Review

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: pullops-pr-review-@@{{ inputs.pr }}
  cancel-in-progress: false

jobs:
  pr-review:
    runs-on: ubuntu-latest

    steps:
      - name: Verify same-repository pull request
        uses: actions/github-script@v8
        env:
          PR: @@{{ inputs.pr }}
          HEAD_REF: @@{{ inputs.head_ref }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only reviews same-repository PRs.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ inputs.head_ref }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare PullOps review PR
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          npm exec pullops -- run pr-review \\
            --phase prepare \\
            --runner external \\
            --pr "@@{{ inputs.pr }}" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob, model, modelTier } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model ?? model}\`,
                  \`model_tier=\${modelTier ?? ""}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}

${renderExternalRunnerSteps(options, { gateIf: "steps.prepare.outputs.run_runner == 'true'" })}

      - name: Restore Node for PullOps complete
        if: always()
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Complete PullOps review PR
        if: always()
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          runner_outcome="$PULLOPS_EXTERNAL_RUNNER_OUTCOME"
          if [ -z "$runner_outcome" ]; then
            runner_outcome=skipped
          fi
          case "$runner_outcome" in
            success) runner_status=success ;;
            failure) runner_status=failed ;;
            cancelled) runner_status=cancelled ;;
            skipped) runner_status=skipped ;;
            *) runner_status=failed ;;
          esac
          npm exec pullops -- runner-result --status "$runner_status" --file "@@{{ steps.prepare.outputs.result_file }}"
          npm exec pullops -- run pr-review \\
            --phase complete \\
            --runner external \\
            --pr "@@{{ inputs.pr }}"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
          PULLOPS_EXTERNAL_RUNNER_OUTCOME: @@{{ steps.runner.outcome }}
`);
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrAddressReviewWorkflow(options) {
  return renderWorkflow(`name: PullOps PR Address Review

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string
  pull_request_review:
    types:
      - submitted

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: pullops-pr-address-review-@@{{ github.event_name == 'workflow_dispatch' && inputs.pr || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  pr-address-review:
    runs-on: ubuntu-latest
    env:
      PR: @@{{ github.event_name == 'workflow_dispatch' && inputs.pr || github.event.pull_request.number }}
      HEAD_REF: @@{{ github.event_name == 'workflow_dispatch' && inputs.head_ref || github.event.pull_request.head.ref }}
      TRIGGER_ACTOR: @@{{ github.event_name == 'workflow_dispatch' && inputs.trigger_actor || github.event.review.user.login }}
      REVIEW_ID: @@{{ github.event_name == 'workflow_dispatch' && '' || github.event.review.node_id }}

    steps:
      - name: Evaluate PullOps review trigger
        id: gate
        uses: actions/github-script@v8
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            if (context.eventName === 'workflow_dispatch') {
              core.setOutput('run_operation', 'true');
              return;
            }

            const review = context.payload.review;
            const pullRequest = context.payload.pull_request;
            const reviewState = String(review?.state ?? '').toLowerCase();

            if (reviewState !== 'changes_requested') {
              core.info(\`Ignoring pull_request_review state '@@{reviewState}'.\`);
              core.setOutput('run_operation', 'false');
              return;
            }

            const { owner, repo } = context.repo;
            if (pullRequest?.head?.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.info('Ignoring requested-change review on a cross-repository pull request.');
              core.setOutput('run_operation', 'false');
              return;
            }

            const reviewer = review?.user?.login;
            if (typeof reviewer !== 'string' || reviewer.trim() === '') {
              core.info('Ignoring requested-change review without a reviewer login.');
              core.setOutput('run_operation', 'false');
              return;
            }

            const { data: tokenUser } = await github.rest.users.getAuthenticated();
            if (reviewer === tokenUser.login) {
              core.info(\`Ignoring requested-change review authored by the PullOps token login '@@{reviewer}'.\`);
              core.setOutput('run_operation', 'false');
              return;
            }

            let permission = 'none';
            try {
              const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
                owner,
                repo,
                username: reviewer,
              });
              permission = data.permission;
            } catch (error) {
              if (error.status !== 404) {
                throw error;
              }
            }

            if (!['admin', 'maintain', 'write'].includes(permission)) {
              core.info(
                \`Ignoring requested-change review from '@@{reviewer}' with permission '@@{permission}'.\`,
              );
              core.setOutput('run_operation', 'false');
              return;
            }

            core.setOutput('run_operation', 'true');

      - name: Verify same-repository pull request
        if: steps.gate.outputs.run_operation == 'true'
        uses: actions/github-script@v8
        env:
          PR: @@{{ env.PR }}
          HEAD_REF: @@{{ env.HEAD_REF }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only addresses review feedback on same-repository PRs.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        if: steps.gate.outputs.run_operation == 'true'
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ env.HEAD_REF }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        if: steps.gate.outputs.run_operation == 'true'
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        if: steps.gate.outputs.run_operation == 'true'
        run: npm ci

      - name: Prepare PullOps address review
        if: steps.gate.outputs.run_operation == 'true'
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          review_id_args=()
          if [ -n "$REVIEW_ID" ]; then
            review_id_args=(--review-id "$REVIEW_ID")
          fi
          npm exec pullops -- run pr-address-review \\
            --phase prepare \\
            --runner external \\
            --pr "$PR" \\
            "@@{review_id_args[@]}" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob, model, modelTier } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model ?? model}\`,
                  \`model_tier=\${modelTier ?? ""}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ env.TRIGGER_ACTOR }}

${renderExternalRunnerSteps(options, { gateIf: "steps.gate.outputs.run_operation == 'true' && steps.prepare.outputs.run_runner == 'true'" })}

      - name: Restore Node for PullOps complete
        if: always() && steps.gate.outputs.run_operation == 'true'
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Complete PullOps address review
        if: always() && steps.gate.outputs.run_operation == 'true'
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          runner_outcome="$PULLOPS_EXTERNAL_RUNNER_OUTCOME"
          if [ -z "$runner_outcome" ]; then
            runner_outcome=skipped
          fi
          case "$runner_outcome" in
            success) runner_status=success ;;
            failure) runner_status=failed ;;
            cancelled) runner_status=cancelled ;;
            skipped) runner_status=skipped ;;
            *) runner_status=failed ;;
          esac
          npm exec pullops -- runner-result --status "$runner_status" --file "@@{{ steps.prepare.outputs.result_file }}"
          review_id_args=()
          if [ -n "$REVIEW_ID" ]; then
            review_id_args=(--review-id "$REVIEW_ID")
          fi
          npm exec pullops -- run pr-address-review \\
            --phase complete \\
            --runner external \\
            --pr "$PR" \\
            "@@{review_id_args[@]}"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ env.TRIGGER_ACTOR }}
          PULLOPS_EXTERNAL_RUNNER_OUTCOME: @@{{ steps.runner.outcome }}
`);
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrFixCiWorkflow(options) {
  return renderWorkflow(`name: PullOps PR Fix CI

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string
  check_suite:
    types:
      - completed

permissions:
  checks: read
  contents: read
  pull-requests: read

concurrency:
  group: pullops-pr-fix-ci-@@{{ github.event_name == 'workflow_dispatch' && inputs.pr || github.event.check_suite.pull_requests[0].number }}
  cancel-in-progress: false

jobs:
  pr-fix-ci:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'check_suite' &&
        github.event.check_suite.conclusion == 'failure' &&
        github.event.check_suite.pull_requests[0] != null &&
        github.event.check_suite.pull_requests[0].head.repo.full_name == github.repository
      )
    runs-on: ubuntu-latest
    env:
      PR: @@{{ github.event_name == 'workflow_dispatch' && inputs.pr || github.event.check_suite.pull_requests[0].number }}
      HEAD_REF: @@{{ github.event_name == 'workflow_dispatch' && inputs.head_ref || github.event.check_suite.pull_requests[0].head.ref }}
      TRIGGER_ACTOR: @@{{ github.event_name == 'workflow_dispatch' && inputs.trigger_actor || github.event.sender.login }}

    steps:
      - name: Verify same-repository pull request
        uses: actions/github-script@v8
        env:
          PR: @@{{ env.PR }}
          HEAD_REF: @@{{ env.HEAD_REF }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only fixes CI on same-repository PRs.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ env.HEAD_REF }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare PullOps fix CI
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          npm exec pullops -- run pr-fix-ci \\
            --phase prepare \\
            --runner external \\
            --pr "$PR" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ env.TRIGGER_ACTOR }}

${renderExternalRunnerSteps(options, { gateIf: "steps.prepare.outputs.run_runner == 'true'" })}

      - name: Restore Node for PullOps complete
        if: always()
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Record successful runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome == 'success'
        run: npm exec pullops -- runner-result --status success --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record failed runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome != 'success' && steps.runner.outcome != 'cancelled'
        run: npm exec pullops -- runner-result --status failed --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record cancelled runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true' && steps.runner.outcome == 'cancelled'
        run: npm exec pullops -- runner-result --status cancelled --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Record skipped runner result
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner != 'true'
        run: npm exec pullops -- runner-result --status skipped --file "@@{{ steps.prepare.outputs.result_file }}"

      - name: Complete PullOps fix CI
        if: always() && steps.prepare.outcome == 'success'
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run pr-fix-ci \\
            --phase complete \\
            --runner external \\
            --pr "$PR"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ env.TRIGGER_ACTOR }}
`);
}

/**
 * @returns {string}
 */
function renderPrUpdateBranchWorkflow() {
  return renderWorkflow(`name: PullOps PR Update Branch

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: pullops-pr-update-branch-@@{{ inputs.pr }}
  cancel-in-progress: false

jobs:
  pr-update-branch:
    runs-on: ubuntu-latest

    steps:
      - name: Verify same-repository pull request
        uses: actions/github-script@v8
        env:
          PR: @@{{ inputs.pr }}
          HEAD_REF: @@{{ inputs.head_ref }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only updates same-repository PR branches.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ inputs.head_ref }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Configure Git committer
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run PullOps update branch
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run pr-update-branch --pr "@@{{ inputs.pr }}"
        env:
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
`);
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrResolveConflictsWorkflow(options) {
  const { prResolveConflictsMaxPasses } = options;
  assertPositiveInteger(prResolveConflictsMaxPasses, 'prResolveConflictsMaxPasses');
  const conflictPassSteps = Array.from({ length: prResolveConflictsMaxPasses }, (_, index) =>
    renderPrResolveConflictsPass(index + 1, options),
  ).join('\n\n');

  return renderWorkflow(`name: PullOps PR Resolve Conflicts

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: pullops-pr-resolve-conflicts-@@{{ inputs.pr }}
  cancel-in-progress: false

jobs:
  pr-resolve-conflicts:
    runs-on: ubuntu-latest

    steps:
      - name: Verify same-repository pull request
        uses: actions/github-script@v8
        env:
          PR: @@{{ inputs.pr }}
          HEAD_REF: @@{{ inputs.head_ref }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only resolves conflicts on same-repository PRs.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ inputs.head_ref }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Configure Git committer
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare PullOps resolve conflicts
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          npm exec pullops -- run pr-resolve-conflicts \\
            --phase prepare \\
            --runner external \\
            --pr "@@{{ inputs.pr }}" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}

${renderRunnerApiKeyStep(options, { runIf: "steps.prepare.outputs.run_runner == 'true'" })}

${conflictPassSteps}

      - name: Refuse unresolved conflict pass beyond generated limit
        if: always() && steps.complete_${prResolveConflictsMaxPasses}.outputs.run_runner == 'true'
        run: |
          echo "PullOps returned another conflict runner job after ${prResolveConflictsMaxPasses} generated conflict passes." >&2
          echo "Rerun pullops setup github-actions so the workflow matches operations.prResolveConflicts.maxConflictResolutionPasses." >&2
          exit 1
`);
}

/**
 * @param {number} pass
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrResolveConflictsPass(pass, options) {
  const handoffStep = pass === 1 ? 'prepare' : `complete_${pass - 1}`;
  const runnerCondition =
    pass === 1
      ? "steps.prepare.outputs.run_runner == 'true' && steps.runner_key.outcome == 'success'"
      : `steps.${handoffStep}.outputs.run_runner == 'true' && steps.runner_key.outcome == 'success'`;
  const restoreCondition =
    pass === 1 ? 'always()' : `always() && steps.${handoffStep}.outputs.run_runner == 'true'`;
  const recordCondition =
    pass === 1
      ? "always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner == 'true'"
      : `always() && steps.${handoffStep}.outputs.run_runner == 'true'`;
  const completeCondition =
    pass === 1
      ? "always() && steps.prepare.outcome == 'success'"
      : `always() && steps.${handoffStep}.outputs.run_runner == 'true'`;
  const skippedResultStep =
    pass === 1
      ? `

      - name: Record skipped runner result for conflict pass 1
        if: always() && steps.prepare.outcome == 'success' && steps.prepare.outputs.run_runner != 'true'
        run: npm exec pullops -- runner-result --status skipped --file "@@{{ steps.prepare.outputs.result_file }}"`
      : '';

  return `${renderRunnerRunStep(options, {
    runIf: runnerCondition,
    stepId: `runner_${pass}`,
    stepNameSuffix: ` conflict pass ${pass}`,
    handoffStep,
  })}

      - name: Restore Node after conflict pass ${pass}
        if: ${restoreCondition}
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Record successful runner result for conflict pass ${pass}
        if: ${recordCondition} && steps.runner_${pass}.outcome == 'success'
        run: npm exec pullops -- runner-result --status success --file "@@{{ steps.${handoffStep}.outputs.result_file }}"

      - name: Record failed runner result for conflict pass ${pass}
        if: ${recordCondition} && steps.runner_${pass}.outcome != 'success' && steps.runner_${pass}.outcome != 'cancelled'
        run: npm exec pullops -- runner-result --status failed --file "@@{{ steps.${handoffStep}.outputs.result_file }}"

      - name: Record cancelled runner result for conflict pass ${pass}
        if: ${recordCondition} && steps.runner_${pass}.outcome == 'cancelled'
        run: npm exec pullops -- runner-result --status cancelled --file "@@{{ steps.${handoffStep}.outputs.result_file }}"${skippedResultStep}

      - name: Complete PullOps resolve conflicts pass ${pass}
        if: ${completeCondition}
        id: complete_${pass}
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run pr-resolve-conflicts \\
            --phase complete \\
            --runner external \\
            --pr "@@{{ inputs.pr }}" \\
            > "$COMPLETE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob } = JSON.parse(fs.readFileSync(process.env.COMPLETE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          COMPLETE_JSON: @@{{ runner.temp }}/pullops-output/complete-${pass}.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}`;
}

/**
 * Render the API key verification and runner steps for one external runner
 * handoff. The Runner Command CLI decides whether the workflow runs the
 * Codex Action or the Claude Code Action.
 *
 * @param {WorkflowRenderOptions} options
 * @param {{ gateIf: string }} step
 * @returns {string}
 */
function renderExternalRunnerSteps(options, { gateIf }) {
  return [
    renderRunnerApiKeyStep(options, { runIf: gateIf }),
    '',
    renderRunnerRunStep(options, {
      runIf: `${gateIf} && steps.runner_key.outcome == 'success'`,
    }),
  ].join('\n');
}

/**
 * @param {WorkflowRenderOptions} options
 * @param {{ runIf: string }} step
 * @returns {string}
 */
function renderRunnerApiKeyStep({ runnerCli }, { runIf }) {
  if (runnerCli === 'claude') {
    return `      - name: Verify Anthropic API key
        if: ${runIf}
        id: runner_key
        continue-on-error: true
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "ANTHROPIC_API_KEY repository Actions secret is required to run anthropics/claude-code-action." >&2
            exit 1
          fi
        env:
          ANTHROPIC_API_KEY: @@{{ secrets.ANTHROPIC_API_KEY }}`;
  }

  return `      - name: Verify OpenAI API key
        if: ${runIf}
        id: runner_key
        continue-on-error: true
        run: |
          if [ -z "$OPENAI_API_KEY" ]; then
            echo "OPENAI_API_KEY repository Actions secret is required to run openai/codex-action." >&2
            exit 1
          fi
        env:
          OPENAI_API_KEY: @@{{ secrets.OPENAI_API_KEY }}`;
}

/**
 * @param {WorkflowRenderOptions} options
 * @param {{ runIf: string, stepId?: string, stepNameSuffix?: string, handoffStep?: string }} step
 * @returns {string}
 */
function renderRunnerRunStep(
  { runnerCli },
  { runIf, stepId = 'runner', stepNameSuffix = '', handoffStep = 'prepare' },
) {
  if (runnerCli === 'claude') {
    return `      - name: Run Claude Code${stepNameSuffix}
        if: ${runIf}
        id: ${stepId}
        uses: anthropics/claude-code-action@v1
        continue-on-error: true
        with:
          anthropic_api_key: @@{{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Read the file @@{{ steps.${handoffStep}.outputs.prompt_file }} and follow the instructions in it exactly.
          claude_args: |
            --model @@{{ steps.${handoffStep}.outputs.model }}
            --dangerously-skip-permissions
          allowed_bots: '*'`;
  }

  return `      - name: Run Codex${stepNameSuffix}
        if: ${runIf}
        id: ${stepId}
        uses: openai/codex-action@v1
        continue-on-error: true
        with:
          openai-api-key: @@{{ secrets.OPENAI_API_KEY }}
          prompt-file: @@{{ steps.${handoffStep}.outputs.prompt_file }}
          output-file: @@{{ steps.${handoffStep}.outputs.output_file }}
          model: @@{{ steps.${handoffStep}.outputs.model }}
          sandbox: workspace-write
          codex-args: '["--config","approval_policy=\\"never\\"","--ephemeral"]'
          allow-bots: true`;
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

/**
 * @param {WorkflowRenderOptions} options
 * @returns {string}
 */
function renderPrFinalizeWorkflow(options) {
  return renderWorkflow(`name: PullOps PR Finalize

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: string
      head_ref:
        description: Same-repository pull request head branch
        required: true
        type: string
      trigger_actor:
        description: GitHub actor that requested the operation
        required: true
        type: string

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: pullops-pr-finalize-@@{{ inputs.pr }}
  cancel-in-progress: false

jobs:
  pr-finalize:
    runs-on: ubuntu-latest

    steps:
      - name: Verify same-repository pull request
        uses: actions/github-script@v8
        env:
          PR: @@{{ inputs.pr }}
          HEAD_REF: @@{{ inputs.head_ref }}
        with:
          github-token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          script: |
            const { owner, repo } = context.repo;
            const { data: pullRequest } = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: Number(process.env.PR),
            });

            if (pullRequest.head.repo?.full_name !== \`@@{owner}/@@{repo}\`) {
              core.setFailed('PullOps only finalizes same-repository PRs for merge.');
              return;
            }

            if (pullRequest.head.ref !== process.env.HEAD_REF) {
              core.setFailed('Dispatched head_ref does not match PR head branch.');
            }

      - name: Check out pull request branch
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: @@{{ inputs.head_ref }}
          persist-credentials: false
          token: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare PullOps PR Finalize
        id: prepare
        run: |
          mkdir -p "$OUTPUT_DIR"
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          npm exec pullops -- run pr-finalize \\
            --phase prepare \\
            --runner external \\
            --pr "@@{{ inputs.pr }}" \\
            > "$PREPARE_JSON"

          node --input-type=module -e '
            import fs from "node:fs";
            const { runnerJob } = JSON.parse(fs.readFileSync(process.env.PREPARE_JSON, "utf8"));
            if (runnerJob === undefined) {
              process.stdout.write(\`result_file=\${process.env.OUTPUT_DIR}/runner_result.json\\nrun_runner=false\\n\`);
            } else {
              process.stdout.write(
                [
                  \`prompt_file=\${runnerJob.promptFile}\`,
                  \`output_file=\${runnerJob.outputFile}\`,
                  \`result_file=\${runnerJob.resultFile}\`,
                  \`model=\${runnerJob.model}\`,
                  "run_runner=true",
                ].join("\\n") + "\\n",
              );
            }
          ' >> "$GITHUB_OUTPUT"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          PREPARE_JSON: @@{{ runner.temp }}/pullops-output/prepare.json
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}

${renderExternalRunnerSteps(options, { gateIf: "steps.prepare.outputs.run_runner == 'true'" })}

      - name: Restore Node for PullOps complete
        if: always()
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Complete PullOps PR Finalize
        if: always()
        run: |
          git remote set-url origin "https://x-access-token:@@{PULLOPS_GITHUB_TOKEN}@github.com/@@{GITHUB_REPOSITORY}.git"
          runner_outcome="$PULLOPS_EXTERNAL_RUNNER_OUTCOME"
          if [ -z "$runner_outcome" ]; then
            runner_outcome=skipped
          fi
          case "$runner_outcome" in
            success) runner_status=success ;;
            failure) runner_status=failed ;;
            cancelled) runner_status=cancelled ;;
            skipped) runner_status=skipped ;;
            *) runner_status=failed ;;
          esac
          npm exec pullops -- runner-result --status "$runner_status" --file "@@{{ steps.prepare.outputs.result_file }}"
          npm exec pullops -- run pr-finalize \\
            --phase complete \\
            --runner external \\
            --pr "@@{{ inputs.pr }}"
        env:
          # PULLOPS_GITHUB_TOKEN is the install-facing secret; expose it under
          # the standard token name used by GitHub-aware tools.
          OUTPUT_DIR: @@{{ runner.temp }}/pullops-output
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          GITHUB_ACTOR: @@{{ inputs.trigger_actor }}
          PULLOPS_EXTERNAL_RUNNER_OUTCOME: @@{{ steps.runner.outcome }}
`);
}

/**
 * @returns {string}
 */
function renderPrCloseChildIssueWorkflow() {
  return renderWorkflow(`name: PullOps PR Close Child Issue

on:
  pull_request:
    types: [closed]

permissions:
  contents: read
  pull-requests: read
  issues: write

concurrency:
  group: pullops-pr-close-child-issue-@@{{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  pr-close-child-issue:
    if: >-
      github.event.pull_request.merged == true &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest

    steps:
      - name: Validate merged child PR shape
        id: child_pr
        env:
          BASE_REF: @@{{ github.event.pull_request.base.ref }}
          HEAD_REF: @@{{ github.event.pull_request.head.ref }}
        run: |
          base_pattern='^pullops/prd-([0-9]+)$'
          head_pattern='^pullops/prd-([0-9]+)-issue-([0-9]+)$'

          if [[ "$BASE_REF" =~ $base_pattern ]]; then
            base_prd="@@{BASH_REMATCH[1]}"
          else
            echo "PullOps pr-close-child-issue skipped: base branch '$BASE_REF' is not a PRD branch."
            echo "should_run=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          if [[ "$HEAD_REF" =~ $head_pattern ]]; then
            head_prd="@@{BASH_REMATCH[1]}"
            child_issue="@@{BASH_REMATCH[2]}"
          else
            echo "PullOps pr-close-child-issue skipped: head branch '$HEAD_REF' is not a child issue branch."
            echo "should_run=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          if [ "$base_prd" != "$head_prd" ]; then
            echo "PullOps pr-close-child-issue skipped: head PRD '$head_prd' does not match base PRD '$base_prd'."
            echo "should_run=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "PullOps pr-close-child-issue accepted for child issue #$child_issue in PRD #$base_prd."
          echo "should_run=true" >> "$GITHUB_OUTPUT"

      - name: Check out repository
        if: steps.child_pr.outputs.should_run == 'true'
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Set up Node
        if: steps.child_pr.outputs.should_run == 'true'
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        if: steps.child_pr.outputs.should_run == 'true'
        run: npm ci

      - name: Run PullOps close child issue
        if: steps.child_pr.outputs.should_run == 'true'
        run: npm exec pullops -- run pr-close-child-issue --pr "@@{{ github.event.pull_request.number }}"
        env:
          GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
          PULLOPS_GITHUB_TOKEN: @@{{ secrets.PULLOPS_GITHUB_TOKEN }}
`);
}

/**
 * @param {string} template
 * @returns {string}
 */
function renderWorkflow(template) {
  return `${template.replaceAll('@@', '$').trim()}\n`;
}

/** @type {Record<WorkflowOperation['name'], (options: WorkflowRenderOptions) => string>} */
const WORKFLOW_RENDERERS = {
  'prd-prepare': renderPrdPrepareWorkflow,
  'issue-implement': renderIssueImplementWorkflow,
  'prd-auto-advance': renderPrdAutoAdvanceWorkflow,
  'prd-auto-complete': renderPrdAutoCompleteWorkflow,
  'pr-review': renderPrReviewWorkflow,
  'pr-address-review': renderPrAddressReviewWorkflow,
  'pr-fix-ci': renderPrFixCiWorkflow,
  'pr-update-branch': renderPrUpdateBranchWorkflow,
  'pr-resolve-conflicts': renderPrResolveConflictsWorkflow,
  'pr-finalize': renderPrFinalizeWorkflow,
  'pr-close-child-issue': renderPrCloseChildIssueWorkflow,
};
