export type PrAddressReviewFeedbackSurface =
  | 'unresolved_inline_thread'
  | 'requested_change_summary'
  | 'pullops_review_output'
  | 'top_level_comment';

export interface PrAddressReviewFeedbackItem {
  id: string;
  surface: PrAddressReviewFeedbackSurface;
  body: string;
  authorLogin: string | null;
  replyCommentId?: number;
  location?: string;
  url?: string;
}
