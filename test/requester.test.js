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

// 1:1 migration of requester_test.go: TestN, TestQps, TestRequest, TestBody.
// httptest.NewServer becomes a node:http server bound to port 0; the counters
// need no atomics because the event loop is single-threaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Work } from '../src/requester/requester.js';
import { Header } from '../src/internal/goheader.js';

/** httptest.NewServer — returns { url, close() }. */
function newServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(done);
        }),
      });
    });
  });
}

/** http.NewRequest, in the shape requester.Work consumes. */
function newRequest(method, url, body = null) {
  return {
    method,
    url,
    host: '',
    header: new Header(),
    contentLength: body === null ? 0 : body.length,
    body,
  };
}

/** Results are written to a sink instead of stdout so tests stay quiet. */
const discard = { write() {} };

test('TestN', async () => {
  let count = 0;
  const handler = (req, res) => {
    count++;
    res.end();
  };
  const server = await newServer(handler);
  try {
    const req = newRequest('GET', server.url);
    const w = new Work({ Request: req, N: 20, C: 2, Writer: discard });
    await w.Run();
    assert.equal(count, 20, `Expected to send 20 requests, found ${count}`);
  } finally {
    await server.close();
  }
});

test('TestQps', async () => {
  let count = 0;
  const handler = (req, res) => {
    count++;
    res.end();
  };
  const server = await newServer(handler);
  try {
    const req = newRequest('GET', server.url);
    const w = new Work({ Request: req, N: 20, C: 2, QPS: 1, Writer: discard });
    const run = w.Run();

    // time.AfterFunc(time.Second, ...): with QPS 1 per worker and 2 workers,
    // at most 2 requests may have completed after one second.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(count <= 2, `Expected to work at most 2 times, found ${count}`);

    w.Stop();
    await run;
  } finally {
    await server.close();
  }
});

test('TestRequest', async () => {
  let uri = '';
  let contentType = '';
  let some = '';
  let auth = '';
  const handler = (req, res) => {
    uri = req.url;
    contentType = req.headers['content-type'] ?? '';
    some = req.headers['x-some'] ?? '';
    auth = req.headers.authorization ?? '';
    res.end();
  };
  const server = await newServer(handler);
  try {
    const header = new Header();
    header.Add('Content-type', 'text/html');
    header.Add('X-some', 'value');
    const req = newRequest('GET', server.url);
    req.header = header;
    // req.SetBasicAuth("username", "password")
    const token = Buffer.from('username:password', 'utf8').toString('base64');
    req.header.Set('Authorization', `Basic ${token}`);

    const w = new Work({ Request: req, N: 1, C: 1, Writer: discard });
    await w.Run();

    assert.equal(uri, '/', `Uri is expected to be /, ${uri} is found`);
    assert.equal(contentType, 'text/html', `Content type is expected to be text/html, ${contentType} is found`);
    assert.equal(some, 'value', `X-some header is expected to be value, ${some} is found`);
    assert.equal(auth, 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=', 'Basic authorization is not properly set');
  } finally {
    await server.close();
  }
});

test('TestBody', async () => {
  let count = 0;
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (Buffer.concat(chunks).toString() === 'Body') count++;
      res.end();
    });
  };
  const server = await newServer(handler);
  try {
    const req = newRequest('POST', server.url, Buffer.from('Body'));
    const w = new Work({
      Request: req,
      RequestBody: Buffer.from('Body'),
      N: 10,
      C: 1,
      Writer: discard,
    });
    await w.Run();
    assert.equal(count, 10, `Expected to work 10 times, found ${count}`);
  } finally {
    await server.close();
  }
});
