export type AddressReviewFeedbackSurface =
  | 'unresolved_inline_thread'
  | 'requested_change_summary'
  | 'pullops_review_output'
  | 'top_level_comment';

export interface AddressReviewFeedbackItem {
  id: string;
  surface: AddressReviewFeedbackSurface;
  body: string;
  authorLogin: string | null;
  replyCommentId?: number;
  location?: string;
  url?: string;
}
