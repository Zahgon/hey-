import { newTemplate } from './print.js';
import { sortFloat64s } from '../internal/gosort.js';
import { GoDuration, nilMap, nilSlice } from '../internal/gotemplate/value.js';
import { seconds } from '../internal/goduration.js';

// We report for max 1M results.
const maxRes = 1000000;

export class Report {
  constructor(w, output, n) {
    this.avgTotal = 0;
    this.fastest = 0;
    this.slowest = 0;
    this.average = 0;
    this.rps = 0;

    this.avgConn = 0;
    this.avgDNS = 0;
    this.avgReq = 0;
    this.avgRes = 0;
    this.avgDelay = 0;
    this.connLats = [];
    this.dnsLats = [];
    this.reqLats = [];
    this.resLats = [];
    this.delayLats = [];
    this.offsets = [];
    this.statusCodes = [];

    this.total = 0n;
    this.errorDist = new Map();
    this.lats = [];
    this.sizeTotal = 0n;
    this.numRes = 0n;
    this.output = output;
    this.w = w;
    void n;
  }

  /**
   * One iteration of runReporter's `for res := range r.results` loop.
   *
   * Go runs this on a dedicated goroutine draining a channel; here it is called
   * directly as each result completes. The accumulation is order-independent
   * apart from the per-request slices, whose order is request-completion order
   * in both implementations.
   */
  add(res) {
    this.numRes += 1n;
    if (res.err !== null && res.err !== undefined) {
      const key = res.err.message;
      this.errorDist.set(key, (this.errorDist.get(key) ?? 0n) + 1n);
      return;
    }
    this.avgTotal += seconds(res.duration);
    this.avgConn += seconds(res.connDuration);
    this.avgDelay += seconds(res.delayDuration);
    this.avgDNS += seconds(res.dnsDuration);
    this.avgReq += seconds(res.reqDuration);
    this.avgRes += seconds(res.resDuration);
    if (this.resLats.length < maxRes) {
      this.lats.push(seconds(res.duration));
      this.connLats.push(seconds(res.connDuration));
      this.dnsLats.push(seconds(res.dnsDuration));
      this.reqLats.push(seconds(res.reqDuration));
      this.delayLats.push(seconds(res.delayDuration));
      this.resLats.push(seconds(res.resDuration));
      this.statusCodes.push(res.statusCode);
      this.offsets.push(seconds(res.offset));
    }
    if (res.contentLength > 0n) {
      this.sizeTotal += res.contentLength;
    }
  }

  /**
   * With zero successful results every average below is 0/0. Go yields NaN and
   * prints it as " NaN"; JavaScript produces the same NaN, and gofmt renders it
   * identically. This is upstream behaviour and is deliberately not "fixed".
   */
  finalize(total) {
    this.total = total;
    this.rps = Number(this.numRes) / seconds(this.total);
    const n = this.lats.length;
    this.average = this.avgTotal / n;
    this.avgConn /= n;
    this.avgDelay /= n;
    this.avgDNS /= n;
    this.avgReq /= n;
    this.avgRes /= n;
    this.print();
  }

  print() {
    let buf;
    try {
      buf = newTemplate(this.output).execute(this.snapshot());
    } catch (err) {
      this.logError(`error: ${err.message}`);
      return;
    }
    this.printf(buf);
    this.printf('\n');
  }

  logError(message) {
    // log.Println writes to stderr with a timestamp prefix.
    const now = new Date();
    const p2 = (v) => String(v).padStart(2, '0');
    const stamp = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} `
      + `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    process.stderr.write(`${stamp} ${message}\n`);
  }

  printf(s) {
    this.w.write(s);
  }

  /**
   * Mirrors report.snapshot(). Two upstream quirks are preserved verbatim:
   *
   *  1. ConnMax/DnsMax/ReqMax/DelayMax/ResMax read index 0 of the ASCENDING
   *     sorted slice and the *Min fields read the last index. The names are
   *     therefore swapped relative to their meaning. Real hey prints the
   *     smallest value under "fastest" in the Details section because of this;
   *     changing it would change hey's output.
   *  2. The Lats/ConnLats/... copies are taken BEFORE the in-place sort, so the
   *     snapshot slices stay in completion order (which is what the CSV output
   *     depends on) while the percentile/histogram maths sees sorted data.
   */
  snapshot() {
    const n = this.lats.length;
    const snapshot = {
      AvgTotal: this.avgTotal,
      Fastest: 0,
      Slowest: 0,
      Average: this.average,
      Rps: this.rps,
      SizeTotal: this.sizeTotal,
      AvgConn: this.avgConn,
      AvgDNS: this.avgDNS,
      AvgReq: this.avgReq,
      AvgRes: this.avgRes,
      AvgDelay: this.avgDelay,
      ConnMax: 0,
      ConnMin: 0,
      DnsMax: 0,
      DnsMin: 0,
      ReqMax: 0,
      ReqMin: 0,
      ResMax: 0,
      ResMin: 0,
      DelayMax: 0,
      DelayMin: 0,
      Total: new GoDuration(this.total),
      ErrorDist: this.errorDist,
      StatusCodeDist: nilMap(),
      NumRes: this.numRes,
      SizeReq: 0n,
      Lats: new Array(n).fill(0),
      ConnLats: new Array(n).fill(0),
      DnsLats: new Array(n).fill(0),
      ReqLats: new Array(n).fill(0),
      ResLats: new Array(n).fill(0),
      DelayLats: new Array(n).fill(0),
      Offsets: new Array(n).fill(0),
      StatusCodes: new Array(n).fill(0n),
      LatencyDistribution: nilSlice(),
      Histogram: nilSlice(),
    };

    if (n === 0) {
      return snapshot;
    }

    snapshot.SizeReq = this.sizeTotal / BigInt(n);

    copyInto(snapshot.Lats, this.lats);
    copyInto(snapshot.ConnLats, this.connLats);
    copyInto(snapshot.DnsLats, this.dnsLats);
    copyInto(snapshot.ReqLats, this.reqLats);
    copyInto(snapshot.ResLats, this.resLats);
    copyInto(snapshot.DelayLats, this.delayLats);
    copyInto(snapshot.StatusCodes, this.statusCodes);
    copyInto(snapshot.Offsets, this.offsets);

    sortFloat64s(this.lats);
    this.fastest = this.lats[0];
    this.slowest = this.lats[this.lats.length - 1];

    sortFloat64s(this.connLats);
    sortFloat64s(this.dnsLats);
    sortFloat64s(this.reqLats);
    sortFloat64s(this.resLats);
    sortFloat64s(this.delayLats);

    snapshot.Histogram = this.histogram();
    snapshot.LatencyDistribution = this.latencies();

    snapshot.Fastest = this.fastest;
    snapshot.Slowest = this.slowest;
    snapshot.ConnMax = this.connLats[0];
    snapshot.ConnMin = this.connLats[this.connLats.length - 1];
    snapshot.DnsMax = this.dnsLats[0];
    snapshot.DnsMin = this.dnsLats[this.dnsLats.length - 1];
    snapshot.ReqMax = this.reqLats[0];
    snapshot.ReqMin = this.reqLats[this.reqLats.length - 1];
    snapshot.DelayMax = this.delayLats[0];
    snapshot.DelayMin = this.delayLats[this.delayLats.length - 1];
    snapshot.ResMax = this.resLats[0];
    snapshot.ResMin = this.resLats[this.resLats.length - 1];

    const statusCodeDist = new Map();
    for (const statusCode of snapshot.StatusCodes) {
      const key = Number(statusCode);
      statusCodeDist.set(key, (statusCodeDist.get(key) ?? 0n) + 1n);
    }
    snapshot.StatusCodeDist = statusCodeDist;

    return snapshot;
  }

  /**
   * Percentile table. `i * 100 / len(lats)` is Go INTEGER division, so `current`
   * advances in whole percent steps; with few samples several percentiles are
   * never reached and stay as the zero LatencyDistribution{} — which is why
   * real hey prints trailing "0%% in 0.0000 secs" rows for small runs.
   */
  latencies() {
    const pctls = [10n, 25n, 50n, 75n, 90n, 95n, 99n];
    const data = new Array(pctls.length).fill(0);
    let j = 0;
    const total = BigInt(this.lats.length);
    for (let i = 0; i < this.lats.length && j < pctls.length; i++) {
      const current = (BigInt(i) * 100n) / total;
      if (current >= pctls[j]) {
        data[j] = this.lats[i];
        j++;
      }
    }
    const res = new Array(pctls.length);
    for (let i = 0; i < pctls.length; i++) {
      res[i] = data[i] > 0
        ? { Percentage: pctls[i], Latency: data[i] }
        : { Percentage: 0n, Latency: 0 };
    }
    return res;
  }

  histogram() {
    const bc = 10;
    const buckets = new Array(bc + 1).fill(0);
    const counts = new Array(bc + 1).fill(0n);
    const bs = (this.slowest - this.fastest) / bc;
    for (let i = 0; i < bc; i++) {
      buckets[i] = this.fastest + bs * i;
    }
    buckets[bc] = this.slowest;
    let bi = 0;
    let max = 0n;
    for (let i = 0; i < this.lats.length;) {
      if (this.lats[i] <= buckets[bi]) {
        i++;
        counts[bi] += 1n;
        if (max < counts[bi]) max = counts[bi];
      } else if (bi < buckets.length - 1) {
        bi++;
      }
    }
    const res = new Array(buckets.length);
    for (let i = 0; i < buckets.length; i++) {
      res[i] = {
        Mark: buckets[i],
        Count: counts[i],
        Frequency: Number(counts[i]) / this.lats.length,
      };
    }
    return res;
  }
}

function copyInto(dst, src) {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = src[i];
}
