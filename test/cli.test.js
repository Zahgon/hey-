// PHASE 8 gate, run as a test: diff this CLI against the COMPILED Go binary.
// Skipped when the reference binary is absent (e.g. a machine without Go), so
// the suite stays runnable, but CI builds it first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { compareAll } from './verification/cli-diff.mjs';

const goBin = process.env.HEY_REF ?? '/tmp/hey-ref';

test('CLI matches the compiled Go binary', { skip: !existsSync(goBin) && `reference binary ${goBin} not built` }, () => {
  const { total, diffs } = compareAll();
  if (diffs.length > 0) {
    const d = diffs[0];
    assert.fail(
      `${diffs.length}/${total} CLI scenarios diverged. First: ${JSON.stringify(d.args)}\n`
      + `GO exit=${d.go.status} stderr=${JSON.stringify(d.go.stderr)}\n`
      + `JS exit=${d.js.status} stderr=${JSON.stringify(d.js.stderr)}`,
    );
  }
  assert.ok(total >= 30, 'scenario list should be broad');
});
