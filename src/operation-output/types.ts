export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export type FieldSpec = FieldType | readonly unknown[] | { type: FieldType };

export interface OperationOutputContract {
  required?: Record<string, FieldSpec>;
}

export interface ValidOperationOutput {
  valid: true;
  value: Record<string, unknown>;
}

export interface ParsedOperationOutput {
  valid: true;
  value: unknown;
}

export interface ValidField {
  valid: true;
}

export interface InvalidOperationOutput {
  valid: false;
  reason: string;
}

export type OperationOutputValidationResult = ValidOperationOutput | InvalidOperationOutput;

export type ParsedOperationOutputResult = ParsedOperationOutput | InvalidOperationOutput;

export type FieldValidationResult = ValidField | InvalidOperationOutput;
