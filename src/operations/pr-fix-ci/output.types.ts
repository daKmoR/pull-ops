import type { CheckFailureClassification } from './classification.types.js';

export interface PrFixCiOutputClassification {
  checkId: string;
  classification: CheckFailureClassification;
  rationale: string;
}

export interface PrFixCiSafetyChecks {
  weakenedTests: boolean;
  deletedAssertions: boolean;
  bypassedChecks: boolean;
  secretOrInfrastructureWorkaround: boolean;
}

export interface CompletedPrFixCiOutput {
  status: 'fixed';
  summary: string;
  classifications: PrFixCiOutputClassification[];
  safetyChecks: PrFixCiSafetyChecks;
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedPrFixCiOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
  classifications?: PrFixCiOutputClassification[];
}

export type PrFixCiOutput = CompletedPrFixCiOutput | BlockedPrFixCiOutput;

export type PrFixCiOutputValidationResult =
  | { valid: true; value: PrFixCiOutput }
  | { valid: false; reason: string };
