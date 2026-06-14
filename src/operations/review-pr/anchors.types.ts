import type { ReviewInlineComment } from './output.types.js';

export interface DroppedReviewComment {
  comment: ReviewInlineComment;
  reason: string;
}
