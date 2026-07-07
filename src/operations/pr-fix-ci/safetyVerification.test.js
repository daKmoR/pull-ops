import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyPrFixCiWorkingTreeSafety } from './safetyVerification.js';

/**
 * @param {{ path: string, removed?: string[], added?: string[], deleted?: boolean }[]} files
 * @returns {string}
 */
function createPatch(files) {
  return files
    .map(({ path, removed = [], added = [], deleted = false }) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ ${deleted ? '/dev/null' : `b/${path}`}`,
        '@@ -1,1 +1,1 @@',
        ...removed.map(line => `-${line}`),
        ...added.map(line => `+${line}`),
      ].join('\n'),
    )
    .join('\n');
}

describe('verifyPrFixCiWorkingTreeSafety', () => {
  it('01: accepts focused source repairs', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: 'src/example.js',
          removed: ['const unused = 1;'],
          added: ['const total = left + right;'],
        },
      ]),
    );

    assert.deepEqual(verification, { safe: true });
  });

  it('02: accepts test repairs that keep test cases and assertions', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: 'src/example.test.js',
          removed: ["    assert.equal(actual, 'old');"],
          added: ["    assert.equal(actual, 'new');"],
        },
      ]),
    );

    assert.deepEqual(verification, { safe: true });
  });

  it('03: refuses changes to check and workflow configuration', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: '.github/workflows/test.yml',
          removed: ['      - run: npm test'],
          added: ['      - run: echo skipped'],
        },
      ]),
    );

    assert.equal(verification.safe, false);
    assert.match(
      verification.safe === false ? verification.violations.join(' ') : '',
      /alters check or workflow configuration/,
    );
  });

  it('04: refuses skipped or focused tests', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: 'src/example.test.js',
          removed: ["  it('01: verifies behavior', () => {"],
          added: ["  it.skip('01: verifies behavior', () => {"],
        },
      ]),
    );

    assert.equal(verification.safe, false);
    assert.match(
      verification.safe === false ? verification.violations.join(' ') : '',
      /Skips or focuses tests/,
    );
  });

  it('05: refuses net test case and assertion removal', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: 'src/example.test.js',
          removed: [
            "  it('02: verifies the edge case', () => {",
            '    assert.equal(actual, expected);',
            '  });',
          ],
          added: [],
        },
      ]),
    );

    assert.equal(verification.safe, false);
    const violations = verification.safe === false ? verification.violations.join(' ') : '';
    assert.match(violations, /Removes 1 test case/);
    assert.match(violations, /Removes 1 assertion/);
  });

  it('06: refuses deleted test files', () => {
    const verification = verifyPrFixCiWorkingTreeSafety(
      createPatch([
        {
          path: 'src/example.test.js',
          removed: ["  it('01: verifies behavior', () => {"],
          deleted: true,
        },
      ]),
    );

    assert.equal(verification.safe, false);
    assert.match(
      verification.safe === false ? verification.violations.join(' ') : '',
      /Deletes test file/,
    );
  });

  it('07: accepts new untracked source files from /dev/null patches', () => {
    const patch = [
      'diff --git a/src/newHelper.js b/src/newHelper.js',
      '--- /dev/null',
      '+++ b/src/newHelper.js',
      '@@ -0,0 +1,1 @@',
      '+export const helper = () => 1;',
    ].join('\n');

    assert.deepEqual(verifyPrFixCiWorkingTreeSafety(patch), { safe: true });
  });

  it('08: accepts an empty patch', () => {
    assert.deepEqual(verifyPrFixCiWorkingTreeSafety(''), { safe: true });
  });
});
