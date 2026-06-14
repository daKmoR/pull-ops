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

export interface CompletedReviewPrOutput {
  status: 'approved' | 'changes_requested';
  summary: string;
  comments: ReviewInlineComment[];
  replies: ReviewReply[];
  directChanges: string[];
  followUps: string[];
}

export interface BlockedReviewPrOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type ReviewPrOutput = CompletedReviewPrOutput | BlockedReviewPrOutput;

export type ReviewPrOutputValidationResult =
  | { valid: true; value: ReviewPrOutput }
  | { valid: false; reason: string };
