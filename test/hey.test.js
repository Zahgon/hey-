// Copyright 2014 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 1:1 migration of hey_test.go. Test names, inputs and assertions are
// unchanged; only the (value, error) return becomes a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputWithRegexp, headerRegexp, authRegexp } from '../bin/hey.js';

test('TestParseValidHeaderFlag', () => {
  const match = parseInputWithRegexp('X-Something: !Y10K:;(He@poverflow?)', headerRegexp);
  assert.equal(match[1], 'X-Something');
  assert.equal(match[2], '!Y10K:;(He@poverflow?)');
});

test('TestParseInvalidHeaderFlag', () => {
  assert.throws(
    () => parseInputWithRegexp('X|oh|bad-input: badbadbad', headerRegexp),
    /could not parse the provided input/u,
    'Header parsing errored; want no errors',
  );
});

test('TestParseValidAuthFlag', () => {
  const match = parseInputWithRegexp('_coo-kie_:!!bigmonster@1969sid', authRegexp);
  assert.equal(match[1], '_coo-kie_');
  assert.equal(match[2], '!!bigmonster@1969sid');
});

test('TestParseInvalidAuthFlag', () => {
  assert.throws(
    () => parseInputWithRegexp('X|oh|bad-input: badbadbad', authRegexp),
    /could not parse the provided input/u,
    'Header parsing errored; want no errors',
  );
});

test('TestParseAuthMetaCharacters', () => {
  // A plus sign in the user name must not error.
  assert.doesNotThrow(() => parseInputWithRegexp('plus+$*{:boom', authRegexp));
});
