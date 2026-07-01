import type { LocalRunRunLink } from '../local-run-state/types.js';

export interface PullOpsParentEventSinkChildEnvironment extends NodeJS.ProcessEnv {
  PULLOPS_PARENT_EVENT_SINK_URL: string;
  PULLOPS_PARENT_EVENT_SINK_TOKEN: string;
  PULLOPS_PARENT_RUN_ID: string;
  PULLOPS_CHILD_RUN_ID: string;
  PULLOPS_CHILD_ISSUE_NUMBER: string;
  PULLOPS_CHILD_LOCAL_RUN_RECORD: string;
  PULLOPS_CHILD_RUN_STATE_PATH: string;
}

export interface PullOpsParentEventSinkChildRoute {
  childRunLink: LocalRunRunLink;
  childIssueNumber: number;
  localRunRecord: string;
}

export interface PullOpsParentEventSink {
  endpoint: string;
  token: string;
  createChildEnvironment(
    route: PullOpsParentEventSinkChildRoute,
  ): PullOpsParentEventSinkChildEnvironment;
  close(): Promise<void>;
}
