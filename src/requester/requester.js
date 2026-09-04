// Package requester provides commands to run load tests and display results.
//
// Port of requester.go. The concurrency model is the one structural place where
// Go and Node genuinely differ:
//
//   Go    C goroutines, each looping N/C times, blocking on a synchronous
//         client.Do. A buffered channel carries results to a reporter
//         goroutine; Stop() pushes C sentinels so each worker exits.
//   Node  C async worker loops driven by the event loop, each awaiting one
//         request at a time. There is no thread to block, so `await` provides
//         the same "one in-flight request per worker" invariant.
//
// Externally the two are equivalent: C concurrent requests, N total, the same
// per-request timings and the same aggregate report. Stop() is modelled as a
// token counter because a channel receive is just "take a token if one is
// available", which is what the Go `select`/`default` does.

import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { now } from './now.js';
import { Report } from './report.js';

const maxIdleConn = 500;

const min = (a, b) => (a < b ? a : b);

export class Work {
  constructor(options = {}) {
    // Request is the request to be made.
    this.Request = options.Request ?? null;
    this.RequestBody = options.RequestBody ?? null;
    // RequestFunc is a function to generate requests. If it is nil, then
    // Request and RequestData are cloned for each request.
    this.RequestFunc = options.RequestFunc ?? null;
    // N is the total number of requests to make.
    this.N = options.N ?? 0;
    // C is the concurrency level, the number of concurrent workers to run.
    this.C = options.C ?? 0;
    // H2 is an option to make HTTP/2 requests.
    this.H2 = options.H2 ?? false;
    // Timeout in seconds.
    this.Timeout = options.Timeout ?? 0;
    // QPS is the rate limit in queries per second.
    this.QPS = options.QPS ?? 0;
    this.DisableCompression = options.DisableCompression ?? false;
    this.DisableKeepAlives = options.DisableKeepAlives ?? false;
    this.DisableRedirects = options.DisableRedirects ?? false;
    // Output represents the output type. If "csv" is provided, the output will
    // be dumped as a csv stream.
    this.Output = options.Output ?? '';
    // ProxyAddr is the address of the HTTP proxy server. Optional.
    this.ProxyAddr = options.ProxyAddr ?? null;
    // Writer is where results will be written. If nil, results go to stdout.
    this.Writer = options.Writer ?? null;

    this.initialised = false;
    this.stopTokens = 0;
    this.start = 0n;
    this.report = null;
  }

  writer() {
    if (this.Writer === null) {
      return { write: (s) => process.stdout.write(s) };
    }
    return this.Writer;
  }

  /**
   * Init initializes internal data-structures. Idempotent, like sync.Once.
   *
   * Go also allocates `results` with capacity min(C*1000, maxResult). That
   * buffer exists purely to stop fast workers blocking on a slow reporter
   * goroutine; it changes no output. The port has no reporter thread to fall
   * behind -- results are folded in as they complete -- so there is nothing to
   * size, and maxResult is unused here. The observable 1M cap that DOES matter
   * is report.go's `if len(r.resLats) < maxRes`, which is ported in report.js.
   */
  Init() {
    if (this.initialised) return;
    this.initialised = true;
    this.stopTokens = 0;
  }

  /**
   * Run makes all the requests, prints the summary. It resolves when all work
   * is done.
   */
  async Run() {
    this.Init();
    this.start = now();
    this.report = new Report(this.writer(), this.Output, this.N);
    await this.runWorkers();
    this.Finish();
  }

  /** Send a stop signal so that workers can stop gracefully. */
  Stop() {
    this.stopTokens = this.C;
  }

  Finish() {
    const total = now() - this.start;
    this.report.finalize(total);
  }

  /** Non-blocking `case <-b.stopCh:` — take a token if one is available. */
  takeStopToken() {
    if (this.stopTokens > 0) {
      this.stopTokens--;
      return true;
    }
    return false;
  }

  async makeRequest(client) {
    const s = now();
    // Go: `var size int64` / `var code int` -- both start at the ZERO value and
    // are only assigned when c.Do returns no error. A failed request therefore
    // reports size 0, not -1.
    let size = 0n;
    let code = 0n;

    const req = this.RequestFunc !== null
      ? this.RequestFunc()
      : cloneRequest(this.Request, this.RequestBody);

    const trace = {
      dnsStart: 0n,
      connStart: 0n,
      resStart: 0n,
      reqStart: 0n,
      delayStart: 0n,
      dnsDuration: 0n,
      connDuration: 0n,
      resDuration: 0n,
      reqDuration: 0n,
      delayDuration: 0n,
    };

    let err = null;
    try {
      const resp = await client.do(req, trace);
      size = resp.contentLength;
      code = BigInt(resp.statusCode);
    } catch (e) {
      err = e;
    }

    const t = now();
    trace.resDuration = t - trace.resStart;
    const finish = t - s;

    this.pushResult({
      offset: s,
      statusCode: code,
      duration: finish,
      err,
      contentLength: size,
      connDuration: trace.connDuration,
      dnsDuration: trace.dnsDuration,
      reqDuration: trace.reqDuration,
      resDuration: trace.resDuration,
      delayDuration: trace.delayDuration,
    });
  }

  pushResult(result) {
    this.report.add(result);
  }

  async runWorker(client, n) {
    // time.NewTicker(time.Duration(1e6/QPS) * time.Microsecond). Go truncates
    // the interval to whole microseconds before scaling.
    const intervalMs = this.QPS > 0 ? Math.trunc(1e6 / this.QPS) / 1000 : 0;
    const tickerStartMs = this.QPS > 0 ? Number(now()) / 1e6 : 0;
    let consumedTicks = 0;

    for (let i = 0; i < n; i++) {
      // Check if application is stopped. Do not send into a closed channel.
      if (this.takeStopToken()) return;

      if (this.QPS > 0) {
        // A Go ticker fires on a FIXED GRID and never accumulates a backlog:
        // its channel holds at most one tick, so ticks missed while a slow
        // request was in flight are DROPPED. Tracking an accumulating
        // `nextTick += interval` deadline instead makes the limiter fire a
        // burst of catch-up requests after any stall -- the exact opposite of
        // rate limiting. Measured after a 3s stall at -q 2: Go paced
        // [497, 500, 500, 500] ms, the accumulating version fired [1, 0, 1, 0].
        const nowMs = Number(now()) / 1e6;
        const fired = Math.floor((nowMs - tickerStartMs) / intervalMs);
        if (fired > consumedTicks) {
          consumedTicks = fired;
        } else {
          const target = tickerStartMs + (consumedTicks + 1) * intervalMs;
          const wait = target - nowMs;
          if (wait > 0) await sleep(wait);
          consumedTicks += 1;
        }
      }
      await this.makeRequest(client);
    }
  }

  async runWorkers() {
    const client = new Client({
      timeoutSeconds: this.Timeout,
      disableCompression: this.DisableCompression,
      disableKeepAlives: this.DisableKeepAlives,
      disableRedirects: this.DisableRedirects,
      maxIdleConnsPerHost: min(this.C, maxIdleConn),
      proxy: this.ProxyAddr,
      h2: this.H2,
      serverName: this.Request?.host ?? null,
    });

    // Ignore the case where b.N % b.C != 0.
    const per = Math.floor(this.N / this.C);
    const workers = [];
    for (let i = 0; i < this.C; i++) {
      workers.push(this.runWorker(client, per));
    }
    await Promise.all(workers);
    client.destroy();
  }
}

/** cloneRequest returns a clone of the provided request. */
export function cloneRequest(r, body) {
  const r2 = {
    method: r.method,
    url: r.url,
    host: r.host,
    header: cloneHeader(r.header),
    contentLength: r.contentLength,
    body: null,
  };
  if (body !== null && body !== undefined && body.length > 0) {
    r2.body = body;
  }
  return r2;
}

function cloneHeader(header) {
  const out = new Map();
  for (const [k, v] of header) out.set(k, [...v]);
  return out;
}

/**
 * The QPS throttle wait.
 *
 * This timer must NOT be unref'd. It is the only thing keeping the event loop
 * alive between two rate-limited requests, so unref'ing it lets Node consider
 * the program finished and exit before the run completes — `-q 10 -c 1 -n 20`
 * silently produced no report at all.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The http.Client + http.Transport pair.
 *
 * Behaviours reproduced from Go that node:http does NOT provide by default:
 *   - Redirect following. Go's default CheckRedirect follows up to 10 hops and
 *     then fails with "stopped after 10 redirects". node:http never redirects.
 *     DisableRedirects maps to http.ErrUseLastResponse: the 3xx response is
 *     returned as-is, with no error.
 *   - Transparent gzip. Go's Transport adds Accept-Encoding: gzip and
 *     decompresses, UNLESS DisableCompression is set. When it decompresses, Go
 *     sets ContentLength to -1, which hey's report treats as "no size".
 *   - InsecureSkipVerify. Go sets it unconditionally, so TLS errors never
 *     appear in a hey run.
 */
class Client {
  constructor(options) {
    this.options = options;
    const agentOptions = {
      keepAlive: !options.disableKeepAlives,
      maxSockets: Infinity,
      maxFreeSockets: options.maxIdleConnsPerHost,
      scheduling: 'fifo',
    };
    this.httpAgent = new http.Agent(agentOptions);
    this.httpsAgent = new https.Agent({
      ...agentOptions,
      rejectUnauthorized: false,
      servername: hostnameInSNI(options.serverName),
    });
    this.h2SessionsByOrigin = new Map();
    this.connectAgents = new Map();
  }

  destroy() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    for (const session of this.h2SessionsByOrigin.values()) session.close();
    this.h2SessionsByOrigin.clear();
    for (const agent of this.connectAgents.values()) agent.destroy();
    this.connectAgents.clear();
  }

  /**
   * http.Client.Do — redirect handling plus the client-wide timeout.
   *
   * Go's Client.Timeout is an ABSOLUTE deadline covering headers and body across
   * every redirect hop, and it is monotonic. Node's request.setTimeout is a
   * per-socket INACTIVITY timer that every received byte re-arms, so a server
   * dribbling one byte at a time would never trip it. The deadline is therefore
   * enforced here, over the whole exchange, using the monotonic clock.
   */
  async do(req, trace) {
    const deadlineNs = this.options.timeoutSeconds > 0
      ? now() + BigInt(Math.round(this.options.timeoutSeconds * 1e9))
      : 0n;

    let current = req;
    const maxRedirects = 10;
    const via = [];

    for (;;) {
      // Go's defaultCheckRedirect rejects BEFORE issuing the request, so a
      // redirect loop costs 10 requests, not 11. It also rewrites url.Error.URL
      // to the raw Location value of the hop it refused to follow.
      if (via.length >= maxRedirects) {
        throw new Error(`${verbFor(req.method)} ${JSON.stringify(current.rawLocation ?? current.url)}: stopped after ${maxRedirects} redirects`);
      }

      // Go builds each redirect request with the SAME context, so the trace
      // hooks fire again on every hop and the recorded stage timings are the
      // LAST hop's. Recording only hop 0 swapped the meaning of
      // Response-delay and Response-read on any redirected request.
      const resp = await this.roundTripWithRetry(current, trace, deadlineNs, true);

      const isRedirect = [301, 302, 303, 307, 308].includes(resp.statusCode);
      if (!isRedirect || this.options.disableRedirects) return resp;

      const location = resp.headers.location;
      if (location === undefined) return resp;

      via.push(current);
      const resolved = new URL(location, current.url).toString();
      current = redirectRequest(current, resp.statusCode, resolved, location);
    }
  }

  /**
   * Go's Transport retries an idempotent request when a REUSED keep-alive
   * connection is closed by the peer before any response byte arrives
   * (persistConn.shouldRetryRequest / nothingWrittenError). Node surfaces that
   * race as ECONNRESET / "socket hang up" instead.
   *
   * Without this, any server with a keepalive_timeout — i.e. almost every real
   * one — produces a large phantom error rate that Go does not report.
   */
  async roundTripWithRetry(req, trace, deadlineNs, recordTiming) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.roundTrip(req, trace, deadlineNs, recordTiming);
      } catch (err) {
        const retriable = attempt === 0
          && isIdempotent(req.method)
          && wasConnectionReusedAndClosed(err);
        if (!retriable) throw err;
      }
    }
  }

  roundTrip(req, trace, deadlineNs, recordTiming) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(req.url);
      } catch {
        reject(new Error(`Get "${req.url}": unsupported protocol scheme ""`));
        return;
      }
      const secure = target.protocol === 'https:';

      // Go: `if b.H2 { http2.ConfigureTransport(tr) } else { tr.TLSNextProto =
      // make(...) }`. The else-branch DISABLES h2, so without -h2 every request
      // is HTTP/1.1. ConfigureTransport only affects TLS, so -h2 over plain
      // http:// stays HTTP/1.1 too.
      if (this.options.h2 && secure) {
        this.roundTripH2(req, target, trace, deadlineNs, recordTiming).then(resolve, reject);
        return;
      }

      const transport = secure ? https : http;

      // Object.create(null): a header literally named `__proto__` would hit
      // Object.prototype's setter on a plain `{}` and be silently DROPPED,
      // whereas Go sends it like any other header.
      const headers = Object.create(null);
      for (const [k, values] of req.header) headers[k] = values.length === 1 ? values[0] : values;
      if (req.host) headers.Host = req.host;
      const addedGzip = wantsGzip(this.options.disableCompression, req, headers);
      if (addedGzip) headers['Accept-Encoding'] = 'gzip';
      // F27: Go emits no Connection header on HTTP/1.1 (keep-alive is the
      // default); Node's agent would add `Connection: keep-alive`.
      headers.Connection = this.options.disableKeepAlives ? 'close' : 'keep-alive';
      // Go sets req.ContentLength, so the Transport frames the body with a
      // Content-Length header. Streaming into the request instead would make
      // Node choose `Transfer-Encoding: chunked`, which changes the bytes on
      // the wire and what the server under test actually measures.
      const bodyBuffer = req.body === null || req.body === undefined || req.body.length === 0
        ? null
        : Buffer.from(req.body);
      if (bodyBuffer !== null) headers['Content-Length'] = String(bodyBuffer.length);

      const proxy = this.options.proxy;
      const requestOptions = {
        method: req.method,
        headers,
        agent: secure ? this.httpsAgent : this.httpAgent,
        // requester.go:242 `ServerName: b.Request.Host` -- Go passes the host
        // WITH its port. Only differs on non-default ports, but it changes
        // which certificate an SNI-routing server returns.
        ...(secure
          ? { rejectUnauthorized: false, servername: hostnameInSNI(this.options.serverName || target.host) }
          : {}),
      };

      if (proxy && !secure) {
        // Go's Transport sends an absolute-form request line to an HTTP proxy.
        requestOptions.host = proxy.hostname;
        requestOptions.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
        requestOptions.path = target.toString();
      } else {
        requestOptions.host = target.hostname;
        requestOptions.port = target.port || (secure ? 443 : 80);
        requestOptions.path = `${target.pathname}${target.search}`;
        if (proxy && secure) {
          // Go proxies https via CONNECT. Dropping the proxy here would send
          // the traffic DIRECTLY, defeating an inspecting/recording proxy the
          // user explicitly asked for.
          requestOptions.agent = this.connectAgent(proxy, target);
        }
      }

      if (recordTiming) trace.connStart = now();

      let clientReq;
      try {
        clientReq = transport.request(requestOptions);
      } catch (err) {
        // Node validates header names/values when the request is constructed and
        // throws synchronously; Go rejects them at write time inside Transport.
        // Both refuse CRLF injection -- only the message differs, and that
        // message is user-visible in hey's error distribution.
        reject(wrapHeaderError(req, err));
        return;
      }

      let settled = false;
      let deadlineTimer = null;
      const clearDeadline = () => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        clientReq.destroy();
        reject(err);
      };

      if (deadlineNs > 0n) {
        const remainingMs = Number(deadlineNs - now()) / 1e6;
        if (remainingMs <= 0) {
          fail(timeoutError(req.url));
          return;
        }
        deadlineTimer = setTimeout(() => fail(timeoutError(req.url)), remainingMs);
      }


      clientReq.on('socket', (socket) => {
        if (!recordTiming) return;
        if (!socket.connecting) {
          // Reused connection: Go's GotConn reports Reused, so connDuration and
          // dnsDuration stay zero and only reqStart is taken.
          //
          // Listeners must NOT be attached here. A keep-alive socket is shared
          // across every request a worker makes, so a 'lookup'/'connect'
          // listener registered per request would accumulate without ever
          // firing -- an unbounded leak over a long run, and the source of
          // Node's MaxListenersExceededWarning.
          trace.reqStart = now();
          return;
        }
        trace.dnsStart = now();
        socket.once('lookup', () => {
          trace.dnsDuration = now() - trace.dnsStart;
        });
        socket.once('connect', () => {
          trace.connDuration = now() - trace.connStart;
          trace.reqStart = now();
        });
      });

      clientReq.on('finish', () => {
        if (!recordTiming) return;
        trace.reqDuration = now() - trace.reqStart;
        trace.delayStart = now();
      });

      clientReq.on('error', (err) => fail(wrapTransportError(req, err)));

      clientReq.on('response', (res) => {
        if (recordTiming) {
          trace.delayDuration = now() - trace.delayStart;
          trace.resStart = now();
        }

        const encoding = res.headers['content-encoding'];
        let stream = res;
        // Go only decompresses when the TRANSPORT added Accept-Encoding. If the
        // user set it via -H, Go hands back the raw compressed bytes and keeps
        // the real Content-Length.
        const decompressed = addedGzip && encoding === 'gzip';
        if (decompressed) stream = res.pipe(zlib.createGunzip());

        const raw = res.headers['content-length'];
        const contentLength = decompressed || raw === undefined || !/^\d+$/u.test(raw)
          ? -1n
          : BigInt(raw);
        const succeed = () => {
          if (settled) return;
          settled = true;
          clearDeadline();
          resolve({ statusCode: res.statusCode, headers: res.headers, contentLength });
        };

        // requester.go:188 `io.Copy(io.Discard, resp.Body)` DISCARDS its error.
        // Once c.Do has returned without error the result is a success no
        // matter how the body ends -- truncated, reset, or corrupt gzip. The
        // port must classify these the same way or a flaky server inverts the
        // whole report into NaNs.
        stream.on('data', () => {});
        stream.on('end', succeed);
        stream.on('error', succeed);
        res.on('aborted', succeed);
        res.on('error', succeed);
      });

      if (bodyBuffer !== null) clientReq.end(bodyBuffer);
      else clientReq.end();
    });
  }
}

/**
 * Go's Transport only asks for gzip when it will be the one to decompress:
 *   !DisableCompression && Accept-Encoding == "" && Range == "" && method != HEAD
 * (net/http/transport.go). Omitting the HEAD and Range conditions makes hey
 * send an Accept-Encoding header that real hey does not.
 */
function wantsGzip(disableCompression, req, headers) {
  if (disableCompression) return false;
  if (headers['Accept-Encoding'] !== undefined) return false;
  if (headers.Range !== undefined) return false;
  return req.method !== 'HEAD';
}

/**
 * An https.Agent that reaches the target through an HTTP CONNECT tunnel, which
 * is how Go's Transport proxies https.
 */
Client.prototype.connectAgent = function connectAgent(proxy, target) {
  const key = `${proxy.href}|${target.host}`;
  const cached = this.connectAgents.get(key);
  if (cached !== undefined) return cached;

  const port = Number(target.port || 443);
  const agent = new https.Agent({
    keepAlive: !this.options.disableKeepAlives,
    maxSockets: Infinity,
    maxFreeSockets: this.options.maxIdleConnsPerHost,
    rejectUnauthorized: false,
  });
  agent.createConnection = (opts, callback) => {
    const tunnel = http.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      agent: false,
    });
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`proxyconnect tcp: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      callback(null, tls.connect({
        socket,
        servername: hostnameInSNI(this.options.serverName || target.host),
        rejectUnauthorized: false,
      }));
    });
    tunnel.on('error', (err) => callback(proxyConnectError(err)));
    tunnel.end();
  };
  this.connectAgents.set(key, agent);
  return agent;
};

Client.prototype.h2Session = function h2Session(origin, trace, recordTiming) {
  const existing = this.h2SessionsByOrigin.get(origin);
  if (existing !== undefined && !existing.closed && !existing.destroyed) {
    return existing;
  }
  const session = http2.connect(origin, {
    rejectUnauthorized: false,
    servername: hostnameInSNI(this.options.serverName),
  });
  session.on('error', () => {
    this.h2SessionsByOrigin.delete(origin);
  });
  session.once('close', () => {
    if (this.h2SessionsByOrigin.get(origin) === session) {
      this.h2SessionsByOrigin.delete(origin);
    }
  });
  if (recordTiming) {
    session.socket?.once('lookup', () => {
      trace.dnsDuration = now() - trace.dnsStart;
    });
    session.once('connect', () => {
      trace.connDuration = now() - trace.connStart;
    });
  }
  this.h2SessionsByOrigin.set(origin, session);
  return session;
};

/** The HTTP/2 equivalent of roundTrip, used when -h2 is set on an https URL. */
Client.prototype.roundTripH2 = function roundTripH2(req, target, trace, deadlineNs, recordTiming) {
  return new Promise((resolve, reject) => {
    const origin = `${target.protocol}//${target.host}`;
    if (recordTiming) {
      // F9: connStart is only assigned in the HTTP/1.1 branch, which this path
      // returns before reaching. Leaving it at 0n makes connDuration read
      // "time since process start" and poisons AvgConn/ConnMax/ConnMin and the
      // CSV DNS+dialup column for every -h2 run.
      trace.connStart = now();
      trace.dnsStart = now();
    }
    const session = this.h2Session(origin, trace, recordTiming);

    const headers = {
      [http2.constants.HTTP2_HEADER_METHOD]: req.method,
      [http2.constants.HTTP2_HEADER_PATH]: `${target.pathname}${target.search}`,
      [http2.constants.HTTP2_HEADER_AUTHORITY]: req.host || target.host,
    };
    for (const [k, values] of req.header) {
      // HTTP/2 requires lowercase field names and forbids connection-specific
      // headers; Go's http2 transport performs the same normalisation.
      const name = k.toLowerCase();
      if (name === 'connection' || name === 'host') continue;
      headers[name] = values.length === 1 ? values[0] : values;
    }
    const addedGzip = wantsGzip(this.options.disableCompression, req, {
      'Accept-Encoding': headers['accept-encoding'],
      Range: headers.range,
    });
    if (addedGzip) headers['accept-encoding'] = 'gzip';

    let settled = false;
    let deadlineTimer = null;
    const clearDeadline = () => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(err instanceof Error ? wrapTransportError(req, err) : new Error(String(err)));
    };

    let stream;
    try {
      stream = session.request(headers);
    } catch (err) {
      fail(err);
      return;
    }

    if (deadlineNs > 0n) {
      const remainingMs = Number(deadlineNs - now()) / 1e6;
      if (remainingMs <= 0) {
        fail(timeoutError(req.url));
        return;
      }
      deadlineTimer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        if (!settled) {
          settled = true;
          reject(timeoutError(req.url));
        }
      }, remainingMs);
    }

    if (recordTiming) trace.reqStart = now();
    stream.on('error', fail);

    stream.on('response', (responseHeaders) => {
      if (recordTiming) {
        trace.delayDuration = now() - trace.delayStart;
        trace.resStart = now();
      }
      const encoding = responseHeaders['content-encoding'];
      const decompressed = addedGzip && encoding === 'gzip';
      const body = decompressed ? stream.pipe(zlib.createGunzip()) : stream;
      const raw = responseHeaders['content-length'];
      const contentLength = decompressed || raw === undefined || !/^\d+$/u.test(raw)
        ? -1n
        : BigInt(raw);
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearDeadline();
        resolve({
          statusCode: Number(responseHeaders[http2.constants.HTTP2_HEADER_STATUS]),
          headers: responseHeaders,
          contentLength,
        });
      };
      // Go discards the body-read error (see roundTrip).
      body.on('data', () => {});
      body.on('end', succeed);
      body.on('error', succeed);
    });

    if (req.body !== null && req.body !== undefined && req.body.length > 0) {
      stream.end(Buffer.from(req.body));
    } else {
      stream.end();
    }
    if (recordTiming) {
      trace.reqDuration = now() - trace.reqStart;
      trace.delayStart = now();
    }
  });
};

/**
 * Go drops the body and downgrades to GET for 301/302/303, and preserves both
 * for 307/308.
 */
function redirectRequest(req, statusCode, url, rawLocation) {
  const dropsBody = statusCode === 301 || statusCode === 302 || statusCode === 303;
  const method = dropsBody && req.method !== 'HEAD' ? 'GET' : req.method;
  return {
    method,
    url,
    // Go only resets Host when the redirect leaves the original host.
    host: sameHost(req.url, url) ? req.host : '',
    header: redirectHeader(req.header, req.url, url),
    contentLength: dropsBody ? 0 : req.contentLength,
    body: dropsBody ? null : req.body,
    rawLocation,
  };
}

// Go's Client.shouldCopyHeaderOnRedirect drops these when a redirect leaves the
// original host. Copying them unconditionally lets an attacker-controlled 302
// exfiltrate credentials to a domain of their choosing.
const SENSITIVE_ON_REDIRECT = new Set(['Authorization', 'Www-Authenticate', 'Cookie', 'Cookie2']);

function redirectHeader(header, fromUrl, toUrl) {
  const copied = cloneHeader(header);
  if (sameHost(fromUrl, toUrl)) return copied;
  for (const name of SENSITIVE_ON_REDIRECT) copied.delete(name);
  return copied;
}

function sameHost(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    // Go compares the host with a subdomain allowance ("sub.example.com" keeps
    // credentials for "example.com"); anything else is treated as cross-host.
    if (ua.host === ub.host) return true;
    const base = ua.hostname;
    return ub.hostname === base || ub.hostname.endsWith(`.${base}`) || base.endsWith(`.${ub.hostname}`);
  } catch {
    return false;
  }
}

/** Go retries only requests it can safely replay. */
function isIdempotent(method) {
  return ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE'].includes(method);
}

/**
 * True for the "peer closed a pooled connection before answering" race that
 * Go's Transport silently retries.
 */
function wasConnectionReusedAndClosed(err) {
  const cause = err?.cause ?? err;
  const code = cause?.code;
  const message = String(cause?.message ?? err?.message ?? '');
  return code === 'ECONNRESET'
    || code === 'EPIPE'
    || /socket hang up/u.test(message)
    || /ECONNRESET/u.test(message);
}

/**
 * crypto/tls.hostnameInSNI. Go drops the SNI extension entirely when the name
 * is an IP literal (RFC 6066 forbids it) and Node throws outright on one, so
 * the value has to be filtered before it reaches either stack.
 *
 * The PORT is deliberately kept for non-IP names: hey assigns
 * `ServerName: b.Request.Host` directly (requester.go:242), bypassing the
 * transport's own host/port split, and a Go run against https://localhost:18443
 * really does send `sni=localhost:18443`.
 */
function hostnameInSNI(name) {
  if (!name) return undefined;
  let host = name;
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  const bare = host.replace(/:\d+$/u, '');
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/u.test(bare);
  const isIPv6 = host.includes(':') && /^[0-9a-fA-F:]+$/u.test(host);
  if (isIPv4 || isIPv6) return undefined;
  return host.replace(/\.$/u, '') || undefined;
}

/** Go wraps a failed proxy dial as `proxyconnect tcp: <dial error>`. */
function proxyConnectError(err) {
  const detail = err.code === 'ECONNREFUSED'
    ? `dial tcp ${err.address ?? ''}:${err.port ?? ''}: connect: connection refused`
    : err.message;
  // `code` is deliberately NOT copied: wrapTransportError would then rebuild
  // the detail from address/port fields this synthetic error does not carry,
  // discarding the `proxyconnect tcp:` prefix Go emits.
  return new Error(`proxyconnect tcp: ${detail}`);
}

function timeoutError(url) {
  return new Error(
    `Get "${url}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
  );
}

/**
 * Translate Node's header-validation errors into Go's wording, since the text
 * is aggregated and printed in hey's "Error distribution" section.
 *   Go: net/http: invalid header field value for "X-A"
 *   Go: net/http: invalid header field name "Bad Name"
 */
function wrapHeaderError(req, err) {
  const named = /\["?([^"\]]+)"?\]/u.exec(err.message);
  const field = named === null ? '' : named[1];
  let detail;
  if (err.code === 'ERR_INVALID_CHAR') {
    detail = `net/http: invalid header field value for ${JSON.stringify(field)}`;
  } else if (err.code === 'ERR_INVALID_HTTP_TOKEN') {
    detail = `net/http: invalid header field name ${JSON.stringify(field)}`;
  } else {
    return wrapTransportError(req, err);
  }
  return new Error(`${verbFor(req.method)} ${JSON.stringify(req.url)}: ${detail}`);
}

function verbFor(method) {
  return method === 'GET' ? 'Get' : method[0] + method.slice(1).toLowerCase();
}

/** Render a transport failure the way Go's *url.Error does. */
function wrapTransportError(req, err) {
  const verb = verbFor(req.method);
  const detail = err.code === 'ECONNREFUSED'
    ? `dial tcp ${err.address ?? ''}:${err.port ?? ''}: connect: connection refused`
    : err.code === 'ENOTFOUND'
      ? `dial tcp: lookup ${err.hostname ?? ''}: no such host`
      : err.message;
  const wrapped = new Error(`${verb} "${req.url}": ${detail}`);
  wrapped.cause = err;
  return wrapped;
}

export { Client };
