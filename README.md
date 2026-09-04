![hey](http://i.imgur.com/szzD9q0.png)

hey is a tiny program that sends some load to a web application.

This is a **JavaScript port of [rakyll/hey](https://github.com/rakyll/hey)**. It
is not a reimplementation "in the spirit of" hey — it is a behavioural port,
verified by diffing against the real Go implementation. See
[Equivalence](#equivalence-with-the-go-implementation).

hey was originally called boom and was influenced from Tarek Ziade's
tool at [tarekziade/boom](https://github.com/tarekziade/boom). Using the same name was a mistake as it resulted in cases
where binary name conflicts created confusion.
To preserve the name for its original owner, we renamed this project to hey.

## Installation

Requires **Node.js 20 or newer**. There are **zero runtime dependencies**,
matching the Go original's dependency-light design.

```
npm install -g hey-js
```

Or run it straight from a clone:

```
node bin/hey.js https://google.com
```

## Usage

hey runs provided number of requests in the provided concurrency level and prints stats.

It also supports HTTP2 endpoints.

```
Usage: hey [options...] <url>

Options:
  -n  Number of requests to run. Default is 200.
  -c  Number of workers to run concurrently. Total number of requests cannot
      be smaller than the concurrency level. Default is 50.
  -q  Rate limit, in queries per second (QPS) per worker. Default is no rate limit.
  -z  Duration of application to send requests. When duration is reached,
      application stops and exits. If duration is specified, n is ignored.
      Examples: -z 10s -z 3m.
  -o  Output type. If none provided, a summary is printed.
      "csv" is the only supported alternative. Dumps the response
      metrics in comma-separated values format.

  -m  HTTP method, one of GET, POST, PUT, DELETE, HEAD, OPTIONS.
  -H  Custom HTTP header. You can specify as many as needed by repeating the flag.
      For example, -H "Accept: text/html" -H "Content-Type: application/xml" .
  -t  Timeout for each request in seconds. Default is 20, use 0 for infinite.
  -A  HTTP Accept header.
  -d  HTTP request body.
  -D  HTTP request body from file. For example, /home/user/file.txt or ./file.txt.
  -T  Content-type, defaults to "text/html".
  -U  User-Agent, defaults to version "hey/0.0.1".
  -a  Basic authentication, username:password.
  -x  HTTP Proxy address as host:port.
  -h2 Enable HTTP/2.

  -host	HTTP Host header.

  -disable-compression  Disable compression.
  -disable-keepalive    Disable keep-alive, prevents re-use of TCP
                        connections between different HTTP requests.
  -disable-redirects    Disable following of HTTP redirects
  -cpus                 Number of used cpu cores.
                        (default for current machine is 8 cores)
```

## Examples

Make requests with default settings:
```
hey https://google.com
```

Make 1000 requests with 100 concurrent workers:
```
hey -n 1000 -c 100 https://google.com
```

Run load test for 30 seconds:
```
hey -z 30s https://google.com
```

Make POST request with custom body:
```
hey \
    -m POST \
    -d "param1=value1&param2=value2" \
    https://google.com
```

Add custom headers:
```
hey \
    -H "Accept: application/json" \
    -H "Authorization: Bearer token" \
    https://google.com
```

Test with HTTP/2:
```
hey -h2 https://google.com
```

Rate limit to 10 queries per second per worker:
```
hey -q 10 -c 5 -z 30s https://google.com
```

## Library usage

The Go package `github.com/rakyll/hey/requester` maps to `hey-js/requester`.

```js
import { Work } from 'hey-js/requester';
import { Header } from 'hey-js';

const header = new Header();
header.Set('Content-Type', 'application/json');

const w = new Work({
  Request: {
    method: 'POST',
    url: 'https://example.com/api',
    host: '',
    header,
    contentLength: 2,
    body: Buffer.from('{}'),
  },
  RequestBody: Buffer.from('{}'),
  N: 200,
  C: 50,
  Timeout: 20,
  Output: '',       // '' for the summary, 'csv', or any Go template
});

await w.Run();      // Go's Run() blocks; here it returns a promise
```

### Go → JavaScript name map

| Go | JavaScript |
|---|---|
| `requester.Work` | `Work` (constructor takes an options object) |
| `w.Init()` / `w.Run()` / `w.Stop()` | same names; `Run()` returns a promise |
| `Work.Writer io.Writer` | any object with `.write(string)` |
| `*http.Request` | a plain object `{ method, url, host, header, contentLength, body }` |
| `http.Header` | `Header` (a `Map` subclass with `Set`/`Add`/`Get`/`Del`) |
| `time.Duration` | `BigInt` nanoseconds |
| Go `int` / `int64` | `BigInt` |
| Go `float64` | `number` |

## Equivalence with the Go implementation

Behavioural equivalence is enforced by two harnesses that run in CI against the
**real Go code**, not against expectations written by hand:

| Gate | What it does | Result |
|---|---|---|
| Report differential | Replays 607 jobs / 19,725 synthetic results through Go's actual `report`+`print`+`text/template` pipeline and through this port, then compares the rendered bytes | **0 divergences** |
| CLI differential | Runs 49 argument combinations against the **compiled Go binary** and compares stdout, stderr and exit code | **0 divergences** |
| Request differential | Compares the method, path, headers and body a server actually receives, over 21 flag combinations | **0 divergences** |
| Float formatting fuzz | 60,494 doubles through `%4.4f` / `%4.3f` | **0 divergences** |
| Migrated test suite | All 9 upstream tests, 1:1 by name | **9/9**, matching the Go baseline exactly |
| Full suite | migrated + semantics kernel + added coverage + fidelity regressions | **143/143** |

`npm run verify` re-derives the Go baseline from source and re-runs everything.

### Deliberately preserved upstream quirks

These look like bugs. They are hey's observable behaviour, so the port keeps
them rather than silently "fixing" output that users may parse:

- **`10%%` in the latency section.** The template contains `%%`, but the
  rendered text is passed as an *argument* to `Fprintf("%s", ...)`, so nothing
  ever unescapes it. Real hey prints `10%% in 0.0012 secs`.
- **Swapped max/min labels.** `ConnMax` reads index 0 of the ascending sorted
  slice and `ConnMin` reads the last, so the "Details" section's fastest and
  slowest columns are reversed relative to their names.
- **Trailing `0%% in 0.0000 secs` rows.** The percentile loop uses integer
  division, so with few samples the higher percentiles are never assigned.
- **`-h2 true <url>`** sets `h2` and makes `"true"` the URL, because Go's `flag`
  stops at the first positional and boolean flags never consume the next
  argument.
- **`-a user:pass` never sends `Authorization`.** `hey.go` calls `SetBasicAuth`
  and then overwrites `req.Header` two statements later, discarding it. Both
  implementations send no credentials — confirmed by the request differential.
- **A truncated or corrupt response body still counts as a success**, because
  `io.Copy(io.Discard, resp.Body)`'s error is discarded.
- **`-n 010` means 8 requests**, not 10: Go's `flag.Int` parses with base 0.

### Accepted, documented differences

Required by JavaScript mechanics; externally observable behaviour is unchanged:

- Go returns `(value, error)`; the port throws instead.
- `Run()` returns a promise rather than blocking.
- Per-request timing hooks map Go's `httptrace` callbacks onto Node socket
  events, so the phase breakdown is Node's measurement of the same phases.
- `now_windows.go` has no counterpart: `process.hrtime.bigint()` is already
  high-resolution on every platform, so the port needs one clock, not two.
- **`-cpus` is parsed and validated exactly as Go does, but has no effect.**
  Go calls `runtime.GOMAXPROCS(*cpus)` to cap OS threads. Node runs JavaScript
  on a single thread and its I/O concurrency is governed by the event loop, so
  there is no equivalent knob. The flag is kept so that argument handling stays
  identical; concurrency is controlled with `-c`.
- Go buffers results in a channel of capacity `min(c*1000, 1000000)` to decouple
  workers from a reporter goroutine. The port folds each result in as it
  completes, so no buffer is needed. The 1,000,000-sample cap that *is*
  observable (`report.go`'s `len(resLats) < maxRes`) is preserved.

## License

Apache 2.0 — see [LICENSE](./LICENSE). Byte-identical to the upstream file.
