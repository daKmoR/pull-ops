export interface GitHubRepository {
  owner: string;
  repo: string;
}

export type ReadRemoteOriginUrl = () => string | undefined;
export type ReadGitHubCliToken = () => string | undefined;

export type OctokitEndpoint = (parameters: Record<string, unknown>) => Promise<{ data: unknown }>;

export interface GitHubApiClient {
  paginate(endpoint: OctokitEndpoint, parameters: Record<string, unknown>): Promise<unknown[]>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
  rest: {
    checks: { listForRef: OctokitEndpoint };
    issues: {
      addLabels: OctokitEndpoint;
      createComment: OctokitEndpoint;
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
      update: OctokitEndpoint;
    };
    repos: { getCombinedStatusForRef: OctokitEndpoint };
  };
}

export type CreateOctokit = (options: { auth?: string }) => GitHubApiClient;
