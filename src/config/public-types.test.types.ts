import type { PullOpsConfig } from './public-types.js';

type AssertAssignable<T extends PullOpsConfig> = T;

export type TinyInitConfigIsValid = AssertAssignable<{
  issueStore: {
    provider: 'github';
  };
}>;
