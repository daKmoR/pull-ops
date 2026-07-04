export interface GitHubRepository {
  owner: string;
  repo: string;
}

export type ReadRemoteOriginUrl = () => string | undefined;
export type ReadGitHubCliToken = () => string | undefined;

export type OctokitEndpoint = (parameters: Record<string, unknown>) => Promise<{ data: unknown }>;

export interface GitHubThrottleRequestOptions {
  method?: string;
  url?: string;
  request?: {
    retryCount?: number;
  };
}

export interface GitHubThrottleOctokit {
  log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export type GitHubThrottleCallback = (
  retryAfter: number,
  options: GitHubThrottleRequestOptions,
  octokit: GitHubThrottleOctokit,
) => boolean | undefined | Promise<boolean | undefined>;

export interface CreateOctokitOptions {
  auth?: string;
  throttle?: {
    onRateLimit: GitHubThrottleCallback;
    onSecondaryRateLimit: GitHubThrottleCallback;
  };
}

export interface GitHubApiClient {
  paginate(endpoint: OctokitEndpoint, parameters: Record<string, unknown>): Promise<unknown[]>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
  rest: {
    actions: {
      listRepoSecrets: OctokitEndpoint;
    };
    checks: { listForRef: OctokitEndpoint };
    issues: {
      addLabels: OctokitEndpoint;
      createComment: OctokitEndpoint;
      create: OctokitEndpoint;
      createLabel: OctokitEndpoint;
      listLabelsForRepo: OctokitEndpoint;
      removeLabel: OctokitEndpoint;
      update: OctokitEndpoint;
      updateLabel: OctokitEndpoint;
    };
    pulls: {
      create: OctokitEndpoint;
      createReplyForReviewComment: OctokitEndpoint;
      createReview: OctokitEndpoint;
      get: OctokitEndpoint;
      getReviewComment: OctokitEndpoint;
      list: OctokitEndpoint;
      merge: OctokitEndpoint;
      update: OctokitEndpoint;
    };
    repos: { getCombinedStatusForRef: OctokitEndpoint };
  };
}

export type CreateOctokit = (options: CreateOctokitOptions) => GitHubApiClient;
