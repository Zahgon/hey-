// Third equivalence gate: the REQUEST this port puts on the wire, compared
// against the compiled Go binary's. The report differential covers output and
// cli-diff covers argument handling; this covers method, path, headers and body
// as a server actually receives them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { compareRequests } from './verification/request-diff.mjs';

const goBin = process.env.HEY_REF ?? '/tmp/hey-ref';

test('the wire request matches the compiled Go binary', {
  skip: !existsSync(goBin) && `reference binary ${goBin} not built`,
}, async () => {
  const { total, diffs } = await compareRequests();
  if (diffs.length > 0) {
    const d = diffs[0];
    assert.fail(
      `${diffs.length}/${total} request scenarios diverged. First: ${JSON.stringify(d.args)}\n`
      + `GO: ${JSON.stringify(d.go)}\nJS: ${JSON.stringify(d.js)}`,
    );
  }
  assert.ok(total >= 20);
});
