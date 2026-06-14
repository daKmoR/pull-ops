import type { CheckFailureClassification } from './classification.types.js';

export interface FixCiOutputClassification {
  checkId: string;
  classification: CheckFailureClassification;
  rationale: string;
}

export interface FixCiSafetyChecks {
  weakenedTests: boolean;
  deletedAssertions: boolean;
  bypassedChecks: boolean;
  secretOrInfrastructureWorkaround: boolean;
}

export interface CompletedFixCiOutput {
  status: 'fixed';
  summary: string;
  classifications: FixCiOutputClassification[];
  safetyChecks: FixCiSafetyChecks;
  changes: string[];
  testPlan: string[];
  followUps: string[];
}

export interface BlockedFixCiOutput {
  status: 'blocked';
  summary: string;
  failureReason: string;
}

export type FixCiOutput = CompletedFixCiOutput | BlockedFixCiOutput;

export type FixCiOutputValidationResult =
  | { valid: true; value: FixCiOutput }
  | { valid: false; reason: string };
