# Go → JavaScript Migration Report — `rakyll/hey`

**Source:** [`rakyll/hey`](https://github.com/rakyll/hey) · local clone `scraped_repos/Go/rakyll_hey/`
**Target:** `hey-js/`
**Pair:** `Go → JavaScript`
**Status:** ✅ **COMPLETE** — JS 143/143, Go baseline 9/9. Independently QC'd: exit 0.

> **Prime directive.** Optimised for **behavioural equivalence**, never for
> "files converted". The Go repo is the sole authority on functionality.

---

## Result summary

| Gate | Scope | Result |
|---|---|---|
| Go baseline | `go test ./...` on go1.26.7 darwin/arm64 | **9/9 pass** |
| Migrated suite | all 9 upstream tests, 1:1 by name | **9/9 pass** |
| Full JS suite | migrated + kernel + added coverage + fidelity regressions | **143/143 pass** |
| **Report differential** | 607 jobs / 19,725 results through the **real Go** report pipeline | **0 divergences** |
| **CLI differential** | 49 scenarios vs the **compiled Go binary** (stdout + stderr + exit code) | **0 divergences** |
| **Request differential** | 21 scenarios — method/path/headers/body as a server receives them | **0 divergences** |
| Float-format fuzz | 60,494 doubles through `%4.4f` / `%4.3f` | **0 divergences** |
| Go source integrity | 17 files unchanged, `go test` still green | ✅ |

---

## Phase map

```
PHASE 0  Inventory                        ✅ 17 files, 2 entry points
PHASE 1  Architecture / dependency map    ✅ concurrency + net + text/template
PHASE 2  Baseline the Go app              ✅ 9/9 + recorded semantic probes
PHASE 3  Go → JS migration map            ✅
PHASE 4  Target JS architecture           ✅ Node 20+ ESM, zero runtime deps
PHASE 5  Build + skeleton                 ✅ node --check green
PHASE 6  Semantics kernel                 ✅ gofmt/goduration/goregexp/gosort/
                                             goheader/goflag/gojson/gotemplate
PHASE 7  Core logic (report + requester)  ✅ report differential green
PHASE 8  CLI                              ✅ diffed against the compiled binary
PHASE 9  Test suite migration (all 9)     ✅ exact baseline parity
PHASE 10 Config, CI, docs                 ✅ ci.yml, codeql, dependabot, README
PHASE 11 Differential harnesses           ✅ report + CLI + request
PHASE 12 Retire Go implementation         ⏸ RETAINED — live verification input
PHASE 13 Adversarial review + remediation ✅ 36 findings; 6 HIGH + 19 others fixed
```

**Phase 12 deliberately not executed.** `scraped_repos/Go/rakyll_hey/` is the
input to `test/verification/gen-go-baseline.sh`, and CI re-clones upstream on every
run to re-derive the baseline. Deleting it would silently disable the strongest
equivalence gate.

---

## PHASE 0 — Inventory

| Aspect | Finding |
|---|---|
| Runtime | Go 1.24 (`go.mod`); baseline run on **go1.26.7 darwin/arm64** |
| Framework | None |
| Test framework | `testing` stdlib |
| Runtime deps | `golang.org/x/net` (for HTTP/2) |
| Network | **Yes** — this is an HTTP load generator |
| Concurrency | **Yes** — goroutines, channels, `sync.Once`, `sync.WaitGroup` |
| Filesystem | Yes — `-D` reads a request body |
| Subprocesses | None |

### File-by-file decisions — 17/17 accounted for, zero silently omitted

| Source | Target | Decision | Reason |
|---|---|---|---|
| `hey.go` | `bin/hey.js` | MIGRATE | CLI entry point |
| `requester/requester.go` | `src/requester/requester.js` | MIGRATE | Worker pool + HTTP client |
| `requester/report.go` | `src/requester/report.js` | MIGRATE | Statistics + snapshot |
| `requester/print.go` | `src/requester/print.js` | MIGRATE | Templates copied byte-identically |
| `requester/now_other.go` | `src/requester/now.js` | MIGRATE | Monotonic clock |
| `requester/now_windows.go` | — | OBSOLETE | Existed only because Go's monotonic clock lacked resolution on Windows; `process.hrtime.bigint()` is high-resolution everywhere |
| `hey_test.go` (5) | `test/hey.test.js` | MIGRATE | 1:1 |
| `requester/requester_test.go` (4) | `test/requester.test.js` | MIGRATE | 1:1 |
| — | `src/internal/gofmt.js` | RECREATE | `%4.4f` / `%4.3f` / `%d` |
| — | `src/internal/goduration.js` | RECREATE | `time.Duration` + `ParseDuration` |
| — | `src/internal/goregexp.js` | RECREATE | RE2 vs JS RegExp |
| — | `src/internal/gosort.js` | RECREATE | `sort.Float64s`, UTF-8 order, map key order |
| — | `src/internal/goheader.js` | RECREATE | `http.Header` + canonicalisation |
| — | `src/internal/goflag.js` | RECREATE | Go `flag` semantics |
| — | `src/internal/gojson.js` | RECREATE | `encoding/json` |
| — | `src/internal/gotemplate/*` | RECREATE | `text/template` subset |
| — | `src/index.js`, `src/requester/index.js` | RECREATE | ESM entry points |
| — | `test/api.test.js` (20) | RECREATE | Redirects, gzip, timeouts, h2, Stop, security |
| — | `test/internal/*.test.js` (56) | RECREATE | Pins every kernel semantic |
| — | `test/differential.test.js`, `test/cli.test.js`, `test/request-diff.test.js` | RECREATE | Equivalence gates |
| — | `test/verification/*` | RECREATE | Harness infrastructure |
| `go.mod` / `go.sum` | `package.json` | REPLACE | JS manifest, zero runtime deps |
| `.github/workflows/go.yml` | `.github/workflows/ci.yml` | RECREATE | `setup-node` matrix 20/22/24 × 3 OS + a Go equivalence job |
| — | `.github/workflows/codeql-analysis.yml` | RECREATE | `language: javascript` |
| — | `.github/dependabot.yml` | RECREATE | npm + github-actions |
| `Dockerfile` | `Dockerfile` | UPDATE | `scratch` → distroless Node; no build stage needed |
| `Makefile` | `Makefile` | UPDATE | Cross-compile targets → verification targets |
| `README.md` | `README.md` | UPDATE | JS usage, name map, equivalence section |
| `LICENSE` | `LICENSE` | KEEP AS-IS | Apache 2.0, `cmp`-verified byte-identical |
| `.gitignore` | `.gitignore` | UPDATE | `node_modules/` added |
| `.travis.yml` | — | OBSOLETE | Dead upstream (superseded by GitHub Actions) |

---

## 🔴 Semantic landmines

Every one of these was found by probing the **real Go binary**, and every one
would have produced silently wrong output if ported naively.

### G-FMT — Go's float formatting is not `toFixed`

| | |
|---|---|
| Rounding | Go rounds exact decimal ties **to even**; `toFixed` rounds away from zero. `(0.0625).toFixed(3)` = `"0.063"`, Go `%4.3f` = `"0.062"` |
| Magnitude | `toFixed` falls back to exponent notation at 1e21; Go never does |
| Non-finite | `%4.4f` of NaN is `" NaN"` — width 4 is applied, precision is not |

Implemented by decomposing the double into an exact `mantissa × 2^exp` pair and
rounding in BigInt. **Fuzz: 60,494 doubles, 0 divergences. A naive `toFixed`
implementation diverges on 4,712 of them (7.8%).**

### G-TMPL-4 — Go has two numeric types; JavaScript has one

`%v` renders the float64 `123456789` as `"1.23456789e+08"` and the int
`123456789` as `"123456789"`. The port carries the distinction in the
representation: **Go integers → `BigInt`, Go float64 → `number`**.

This is not bookkeeping. It forces Go's **integer division** at the three places
that depend on it, each of which would otherwise silently produce a fraction:

- `sizeTotal / len(lats)` → `Size/request`
- `i * 100 / len(lats)` → percentile selection
- `(count*40 + max/2) / max` → histogram bar length

### G-SORT — three different orderings

- `sort.Float64s` places **NaN first**; a `(a,b) => a-b` comparator returns NaN
  for NaN pairs, which the spec treats as "equal" (order undefined).
- `text/template` `range` over a map **sorts keys** — numerically for ints, by
  **UTF-8 bytes** for strings. `"Beta"` precedes `"alpha"`. This drives hey's
  "Status code distribution" and "Error distribution" sections.
- UTF-8 byte order ≠ UTF-16 code-unit order for astral characters.

### G-RE — RE2 vs JS RegExp

Both of hey's regexps depend on classes that differ:

| | Go RE2 | JS |
|---|---|---|
| `\s` | `[\t\n\f\r ]` (ASCII only) | also `\v`, NBSP, U+2028/9, U+3000, U+FEFF… |
| `.` | any rune except `\n` | also excludes `\r`, U+2028, U+2029 |

Verified against Go: `^\s$` **rejects** `"\u00a0"` and `"\v"`; `^.$` **matches**
`"\r"`. In `authRegexp`'s `[^\s]` the divergence *flips an accept into a
reject*, so a header value starting with NBSP would change meaning. Both
patterns are respelled with explicit classes and the `u` flag.

### G-FLAG — Go's `flag` stops at the first positional

`util.parseArgs` has no such mode. Consequences confirmed against the binary:

- `hey -n 5 http://x -o csv` → `-o` is **not** parsed; it stays positional.
- `hey -h2 true http://x` → `h2` is set and the URL becomes `"true"`, because
  boolean flags never consume the following argument.
- Every numeric/duration parse failure flattens to the literal `"parse error"`,
  because `flag`'s `Value.Set` replaces the underlying error.
- `-help` exits **0**; an unknown flag exits **2**.

### G-HDR — canonicalisation is conditional

Go rewrites a header key only when every byte is a valid token character.
`"weird_key"` → `"Weird_key"` (underscore is a token char, **not** a separator),
and `"Ключ"` is stored verbatim. A "capitalise each dash-separated part" rule
would produce `"Weird_Key"` and mangle the non-ASCII key.

### G-JSON — `JSON.stringify` is not `json.Marshal`

Go HTML-escapes `<`, `>`, `&`; switches floats to exponent form at `1e-6`
(not `1e-7`); sorts map keys; and treats NaN/Inf as an **error** — which
`jsonify` swallows into `""` rather than inventing `null`.

### G-TMPL-5 — nil vs empty (found by the differential harness)

Go distinguishes `var m map[K]V` from `map[K]V{}`. They are identical under
`%v`, `len()` and `range`, and differ **only** under `json.Marshal`
(`null` vs `{}`). `report.snapshot()` returns a **nil** `StatusCodeDist` when
there are no successful results, so `hey -o '{{ jsonify .StatusCodeDist }}'`
prints `null` on an all-error run. This caused the only 7 failures in the first
differential run.

---

## Deliberately preserved upstream defects

Not bugs to fix — hey's observable behaviour, which users may parse.

| # | Defect | Evidence |
|---|---|---|
| U1 | **`10%%` in the latency section.** The template contains `%%`, but the rendered text is passed as an *argument* to `Fprintf("%s", …)`, so nothing unescapes it | Baseline output: `10%% in 0.0001 secs` |
| U2 | **Swapped max/min.** `ConnMax` reads index 0 of the *ascending* sorted slice, `ConnMin` reads the last | `report.go:197-206` |
| U3 | **Trailing `0%% in 0.0000 secs` rows.** Integer division in the percentile loop leaves higher percentiles unassigned for small runs | `report.go:217-235` |
| U4 | **`-a` basic auth is silently discarded.** `SetBasicAuth` writes to `req.Header` at `hey.go:200`, then `hey.go:222` does `req.Header = header`, overwriting it | Confirmed by the request differential: **neither** implementation sends `Authorization` |
| U5 | **`N % C` requests are dropped.** Each worker runs `N/C`; `-n 7 -c 2` issues 6 | `requester.go:256-259` |

---

## PHASE 13 — Adversarial review findings

Two review passes were run: my own, and an independent adversarial audit that
diffed every line against the Go source and **empirically reproduced each claim
against the compiled binary**. The second pass found 36 issues my three
differentials could not see — they covered report rendering, argument handling
and request construction, but not *network behaviour under adverse conditions*
or the breadth of the `text/template` grammar.

### HIGH — all fixed, each verified against the Go binary and pinned

| # | Finding | Evidence before the fix | After |
|---|---|---|---|
| H1 | **Body-read errors were counted as failures.** `requester.go:188` discards `io.Copy`'s error, so once `c.Do` succeeds the result is a success no matter how the body ends | Server declares `Content-Length: 100`, sends 5 bytes: GO `[200] 2 responses`, JS `[2] unexpected EOF` — every average became `NaN` | both `[200] 2 responses` |
| H2 | **No retry on a closed idle keep-alive connection.** Go's Transport replays an idempotent request when a *reused* conn dies before the response | Server with a keepalive timeout, `-n 6 -c 1`: GO `[200] 6`, JS `[200] 3` + `[1] ECONNRESET` + `[2] socket hang up` — a ~50% phantom error rate against an extremely common real-world condition | both `[200] 6 responses` |
| H3 | **`-x` proxy silently ignored for HTTPS (security).** `if (proxy && !secure)` dropped the proxy and sent traffic **direct** | dead proxy + https target: GO `proxyconnect … connection refused`, JS `[200] 2 responses` — the TLS server logged both connections arriving directly | identical `proxyconnect tcp: …` message; https now tunnels via CONNECT |
| H4 | **Cross-host redirects forwarded `Authorization`/`Cookie` (security).** Go strips them via `shouldCopyHeaderOnRedirect` | attacker-controlled 302 to another host: GO strips, JS leaked `Bearer SECRET` and `sid=abc` | both strip; same-host redirects still keep them |
| H5 | **`-t` was a socket-idle timer, not `http.Client.Timeout`.** Node re-arms on every byte received | response dribbling 1 byte/600 ms, `-t 3`: GO 3.0 s, JS **11.5 s** — no bound at all against a slow trickle | GO 3048 ms, JS 3110 ms |
| H6 | **`-z` over ~24.86 days stopped immediately.** Node clamps a `setTimeout` delay above 2³¹−1 ms to 1 ms | `-z 720h`: `TimeoutOverflowWarning`, exited after 7 ms having sent 1 request | chained sub-limit timers; runs the full duration |

### MEDIUM / LOW — fixed

| # | Finding | Fix |
|---|---|---|
| F7 | Redirect cap off by one (11 requests vs Go's 10) and the error named the wrong URL | Cap checked *before* sending; error uses the raw `Location`, as Go's `url.Error` rewrite does |
| F8 | **QPS limiter burst to "catch up".** Go's ticker drops missed ticks | Fixed-grid ticker. After a 3 s stall at `-q 2`: GO `[497,500,500,500]`, JS was `[1,0,1,0]`, now `[489,500,498,502]` |
| F9 | `-h2` reported garbage for DNS+dialup — `connStart` was only set on the HTTP/1.1 path, so `connDuration` was time-since-process-start | Set on the h2 path too |
| F10 | Redirect stage timings taken from the first hop; Go re-fires its trace hooks so the **last** hop wins | Record on every hop |
| F11 | `flag.Int` is `ParseInt(s, 0, 64)` — base 0. `-n 010` meant 8 in Go, 10 in the port | Full base-0 parser (hex/binary/octal/`_`), range errors kept distinct |
| F12 | **The template tokenizer collapsed adjacent quoted operands**, so `printf "%d" 42` parsed as ONE operand. Every multi-argument `printf` was broken | `skipQuotedAt` lands *on* the closing quote and `continue` skipped the `i++`; advance explicitly |
| F13 | Missing `text/template` builtins | Added `printf`, `call`, `html`, `js`, `urlquery`, `slice`. Writing their tests against recorded Go output then found four more bugs: `%05d` space-padded, `urlquery` used `%20` not `+`, `print` ignored Go's spacing rule, and `index` on a string returned a character instead of the byte |
| F14/F15 | Transparent gunzip applied even when the **user** set `Accept-Encoding`; h2 path missed the HEAD/Range conditions | Track `addedGzip` exactly as Go's Transport does, on both paths |
| F17 | The URL argument was never parsed — `hey "://bad"` ran a full benchmark and exited 0 | `parse "://bad": missing protocol scheme`, exit 1 |
| F19 | Template parse errors: Go's `template.Must` **panics** (exit 2) before any request; the port logged and exited 0 | Template compiled up front; `panic: …` on stderr, exit 2 |
| F21 | `-h2` leaked one session `error` listener per request | Removed the per-request listener |
| F22 | `-H "__proto__: v"` was silently dropped (prototype setter on a plain object) | Headers built with `Object.create(null)` |
| F23 | `{{ .Total }}` printed a stub | Full `time.Duration.String()` — verified byte-identical on 13 values (`1h30m0s`, `1.5µs`, `-2.5s`, `0s`, …). A zero Duration is now falsy in `if`, as in Go |
| F24 | `bad flag syntax` printed nothing | Routed through `failf`: message + usage on stderr |
| F27 | Node's agent added `Connection: keep-alive`; Go sends no Connection header on HTTP/1.1 | Header set explicitly |
| F28 | SNI omitted the port; Go passes `Request.Host` including it | Use the full host |
| F29 | Proxy dial failures lacked Go's `proxyconnect tcp:` prefix | Added |
| F31 | `eq`/`lt` compared strings as UTF-16 | Uses `compareStringsUTF8` |
| F33 | `strings.ToUpper` vs `toUpperCase()` — `-m ß` became method `SS` instead of erroring | Rune-wise upcase, never one-to-many |
| F34 | `strconv.Quote` uses `\a \b \f \v`; the port emitted `\xNN` | Added those escapes |
| F35 | `results`/`resultCap` were written and never read | Removed; documented why no buffer is needed |
| F36 | `{{range 100000000}}` materialised the whole sequence → OOM | Generator-based `range` |

### Known remaining gaps — stated, not hidden

| # | Gap | Why it is acceptable |
|---|---|---|
| F16/F18 | `-x` and the URL use WHATWG `URL`, which is stricter than `net/url.Parse` (rejects bare `myproxy.local`) and normalises some paths | Error text for the common `://bad` form matches; full `net/url` is a separate port |
| F20 | `-q > 1e6`: Go panics (its ticker interval truncates to 0); the port runs | The port is *more* robust; a crash is not worth reproducing |
| F26 | `-cpus` parsed and validated identically but has no effect | Node is single-threaded; `runtime.GOMAXPROCS` has no analogue |
| F30 | Template field access on a slice/map (`{{ .Lats.length }}`) resolves where Go errors | Prototype-chain walking is blocked (F4); the residue is a wider surface, not an escape — no route to `Function` was found |
| F32 | Node's `llhttp` rejects malformed framing (e.g. duplicate `Content-Length`) that Go tolerates | Node-level strictness; the error is surfaced honestly in `ErrorDist` |

### Third pass — independent QC (`qc_migration_kit`)

Running the migration QC harness surfaced work the differentials could not:

| Finding | Action |
|---|---|
| `duration()` and `must()` were **dead code** I had written and never used | Deleted rather than tested |
| Four **no-op placeholder closures** in `requester.js` (`clearDeadlineRef.fn`, `clearDeadline`) existed only to satisfy declaration order | Restructured so the timer is declared before `fail`; the indirection is gone |
| The CLI helpers (`HeaderSlice`, `newRequest`, `setBasicAuth`, `toUpperGo`, `pathError`, `errAndExit`, `usageAndExit`, `Work.writer`, `FlagSet.NArg`, `Header.Del`) were exercised **only through a subprocess**, which skips when the Go binary is absent | 18 unit tests added in `test/cli-units.test.js` |
| `verification/` was classified as **implementation**; it is imported only by tests | Moved to `test/verification/`. Node then treated the harness `.mjs` files as tests and ran their CLI blocks — gated behind `QC_RUN_HARNESS=1` |
| The HTTP/2 error path was never executed | Test added against a closed port |

Result: **0 dead functions of 195**, function coverage **99.49%**, line **90.59%**.

### Security checks performed

- **Prototype pollution** — every Go map is a `Map` (`errorDist`, `statusCodeDist`, `Header`). Parsed keys `__proto__` / `constructor` / `toString` are exercised in the differential corpus and by a dedicated test. `Object.prototype` unpolluted.
- **Template sandbox** — F4 above; prototype-chain walking now rejected.
- **CRLF header injection** — rejected by both implementations; the port now emits Go's exact message (`net/http: invalid header field value for "X-A"`) since that string lands in the error distribution.
- **ReDoS** — both regexps run against 6 adversarial inputs up to 200 KB; worst case **1.16 ms**. Pinned with a 250 ms budget.
- **Error-text parity** — connection-refused and no-such-host messages are byte-identical to Go, since they become aggregation keys.

---

## Accepted, documented differences (class A)

Required by JavaScript mechanics; externally observable behaviour unchanged.

| Difference | Rationale |
|---|---|
| `(value, error)` → `throw` | JS has no multi-return |
| `Run()` returns a promise | No blocking primitive; `await` preserves the "one in-flight request per worker" invariant |
| Goroutines + channel → async worker loops | C concurrent requests, N total, same aggregate report |
| `httptrace` callbacks → Node socket events | Same phases, measured by the host runtime |
| No results channel buffer | The buffer only decoupled workers from a reporter goroutine; results are folded in as they complete. The *observable* 1M cap (`len(resLats) < maxRes`) **is** preserved |
| **`-cpus` has no effect** | Go calls `runtime.GOMAXPROCS`; Node is single-threaded. The flag is still parsed and validated identically so argument handling matches |
| `now_windows.go` dropped | `process.hrtime.bigint()` is high-resolution on all platforms |

### Bounded scope, stated explicitly

`-o` accepts an arbitrary Go template. The port implements the `text/template`
**subset** covering text, comments, trim markers, pipelines, parenthesised
sub-expressions, literals, field/method chains, variables, `if`/`else if`/`else`,
`range`/`else`, `with`, and the builtin function set. Anything outside it raises
a parse error rather than rendering something subtly wrong — **a wrong number is
worse than a refusal.** Both builtin templates and 16 custom templates are
exercised by the differential harness.

---

## Verification infrastructure

```
test/verification/
  build-corpus.mjs      seeded generator -> corpus.json (607 jobs, 19,725 results)
  corpus.json           shared input for both drivers
  go-driver.go.txt      compiled into a scratch clone; reaches the UNEXPORTED
                        Go `report` type, the same white-box access hey's own
                        tests use
  gen-go-baseline.sh    builds that scratch clone -> go-baseline.json
                        (upstream checkout is never modified)
  js-driver.mjs         same corpus through this port
  cli-diff.mjs          49 scenarios vs the compiled Go binary
  request-diff.mjs      21 scenarios comparing the request on the wire
```

`npm run verify` re-derives the Go baseline from source and re-runs everything.
CI additionally re-clones upstream and **fails if the committed baseline drifted**.

---

## Final checklist

- [x] `npm test` from scratch — **143/143**, zero failures
- [x] **9/9 migrated tests pass** — matches the Go baseline count exactly
- [x] All 17 source files have an explicit decision
- [x] Both builtin templates copied **byte-identically** from Go (verified programmatically)
- [x] `LICENSE` byte-identical (`cmp`)
- [x] Usage text byte-identical to the compiled binary
- [x] Report differential — 607 jobs, **0 divergences**
- [x] CLI differential — 49 scenarios, **0 divergences**
- [x] Request differential — 21 scenarios, **0 divergences**
- [x] Float fuzz — 60,494 cases, **0 divergences**
- [x] G-FMT ties round to even; no 1e21 cliff; `" NaN"` keeps its width
- [x] G-SORT NaN sorts first; map keys in UTF-8 byte order
- [x] G-RE `\s` is ASCII-only; `.` matches `\r`
- [x] G-FLAG parsing stops at the first positional; bool flags don't consume
- [x] G-TMPL int vs float64 render differently; integer division preserved
- [x] U1–U5 upstream defects preserved and documented
- [x] `-h2` verified to negotiate real HTTP/2; default verified HTTP/1.1
- [x] Proxy absolute-form request line identical to Go
- [x] No prototype pollution; no template sandbox escape; no ReDoS
- [x] Zero runtime dependencies
- [x] Go source left byte-identical (17 files, `go test` still 9/9)
- [x] README builds/tests/runs as written

---

## Decision sheet

```
Repo: rakyll/hey                     Src: Go  →  Tgt: JavaScript
Prod LOC: 1,285 (Go)                 Port LOC: 3,112 prod + 1,355 test
Baseline: 9/9 pass                   Runtime deps: 0

[x] PHASE 0    Inventory       — 17 files, 2 entry points
[x] PHASE 1    Architecture    — concurrency + net + text/template
[x] PHASE 2    Baseline        — 9/9 on go1.26.7 + recorded probes
[x] PHASE 3-11 Migration       — COMPLETE, 143/143, three differentials green
[x] PHASE 13   Review          — 36 findings (6 HIGH); all HIGH + 19 more fixed

DECISION:  [x] PROCEED   [ ] RESOLVE BLOCKERS FIRST
```

**Why the port is larger than the source.** ~1,470 LOC of `src/internal/` is Go
standard library that JavaScript does not provide — `strconv.FormatFloat`,
`time.ParseDuration`, `sort`, `flag`, `net/http.Header`, `encoding/json` and
`text/template`. hey's own logic ports to roughly its original size.

---

## Deferred

| Item | Status |
|---|---|
| npm publish automation | ⚠️ **Deferred.** Package-name ownership and credential strategy are product decisions, not migration decisions. `make release` fails loudly rather than pretending. |
