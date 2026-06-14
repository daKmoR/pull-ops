export interface AddressedFeedback {
  feedbackId: string;
  response: string;
}

export interface ReasonedFeedback {
  feedbackId: string;
  reason: string;
}

export interface CompletedPrAddressReviewOutput {
  status: 'addressed';
  summary: string;
  addressed: AddressedFeedback[];
  declined: ReasonedFeedback[];
  deferred: ReasonedFeedback[];
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedPrAddressReviewOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type PrAddressReviewOutput = CompletedPrAddressReviewOutput | BlockedPrAddressReviewOutput;

export type PrAddressReviewOutputValidationResult =
  | { valid: true; value: PrAddressReviewOutput }
  | { valid: false; reason: string };
