export type ReviewResultStatus = 'approved' | 'changes_requested' | 'blocked';

export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewReply {
  commentId: number;
  body: string;
}

export interface ReviewFollowUpIssueProposal {
  title: string;
  body: string;
}

export interface CompletedPrReviewOutput {
  status: 'approved' | 'changes_requested';
  summary: string;
  comments: ReviewInlineComment[];
  replies: ReviewReply[];
  directChanges: string[];
  reviewFollowUpIssues: ReviewFollowUpIssueProposal[];
  followUps: string[];
}

export interface BlockedPrReviewOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrReviewOutput = CompletedPrReviewOutput | BlockedPrReviewOutput;

export type PrReviewOutputValidationResult =
  | { valid: true; value: PrReviewOutput }
  | { valid: false; reason: string };
