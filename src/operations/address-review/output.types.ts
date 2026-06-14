export interface AddressedFeedback {
  feedbackId: string;
  response: string;
}

export interface ReasonedFeedback {
  feedbackId: string;
  reason: string;
}

export interface CompletedAddressReviewOutput {
  status: 'addressed';
  summary: string;
  addressed: AddressedFeedback[];
  declined: ReasonedFeedback[];
  deferred: ReasonedFeedback[];
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedAddressReviewOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type AddressReviewOutput = CompletedAddressReviewOutput | BlockedAddressReviewOutput;

export type AddressReviewOutputValidationResult =
  | { valid: true; value: AddressReviewOutput }
  | { valid: false; reason: string };
