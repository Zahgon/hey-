// PHASE 11 equivalence gate.
//
// Replays test/verification/corpus.json through this port's report pipeline and
// compares the rendered bytes against test/verification/go-baseline.json, which was
// produced by the REAL Go report/print/template code (see gen-go-baseline.sh).
// A green unit suite does not prove equivalence; this does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runCorpus } from './verification/js-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, 'verification', 'corpus.json');
const baselinePath = join(here, 'verification', 'go-baseline.json');

test('report output is byte-identical to the Go baseline', { skip: !existsSync(baselinePath) && 'baseline not generated' }, () => {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const got = runCorpus(corpusPath);

  assert.equal(got.length, baseline.length, 'job count must match the baseline');

  const divergences = [];
  for (let i = 0; i < baseline.length; i++) {
    if (got[i].output !== baseline[i].output) {
      divergences.push({
        job: i,
        template: corpus[i].output,
        results: corpus[i].results.length,
        go: baseline[i].output,
        js: got[i].output,
      });
    }
  }

  if (divergences.length > 0) {
    const d = divergences[0];
    assert.fail(
      `${divergences.length}/${baseline.length} jobs diverged. First: job ${d.job} `
      + `template=${JSON.stringify(d.template)} results=${d.results}\n`
      + `GO: ${JSON.stringify(d.go)}\nJS: ${JSON.stringify(d.js)}`,
    );
  }

  const totalResults = corpus.reduce((a, j) => a + j.results.length, 0);
  assert.ok(totalResults > 15000, 'corpus should be substantial');
});

test('the baseline covers the summary, csv and custom template paths', () => {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const outputs = new Set(corpus.map((j) => j.output));
  assert.ok(outputs.has(''), 'default summary template exercised');
  assert.ok(outputs.has('csv'), 'csv template exercised');
  assert.ok(outputs.size > 10, 'custom templates exercised');
  assert.ok(corpus.some((j) => j.results.length === 0), 'empty-result jobs exercised');
  assert.ok(
    corpus.some((j) => j.results.length > 0 && j.results.every((r) => r.err !== '')),
    'all-error jobs exercised (the NaN path)',
  );
});
