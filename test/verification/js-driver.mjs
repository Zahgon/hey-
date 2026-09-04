// JS side of the report differential. Consumes the same corpus.json the Go
// driver does and emits the same JSON envelope, so the two are diffable byte
// for byte.
import { readFileSync } from 'node:fs';
import { Report } from '../../src/requester/report.js';

class StringWriter {
  constructor() {
    this.chunks = [];
  }

  write(s) {
    this.chunks.push(s);
  }

  toString() {
    return this.chunks.join('');
  }
}

function runJob(job) {
  const w = new StringWriter();
  const report = new Report(w, job.output, job.n);
  for (const r of job.results) {
    report.add({
      err: r.err === '' ? null : new Error(r.err),
      statusCode: BigInt(r.statusCode),
      offset: BigInt(r.offsetNs),
      duration: BigInt(r.durationNs),
      connDuration: BigInt(r.connNs),
      dnsDuration: BigInt(r.dnsNs),
      reqDuration: BigInt(r.reqNs),
      resDuration: BigInt(r.resNs),
      delayDuration: BigInt(r.delayNs),
      contentLength: BigInt(r.contentLength),
    });
  }
  report.finalize(BigInt(job.totalNs));
  return w.toString();
}

export function runCorpus(corpusPath) {
  const jobs = JSON.parse(readFileSync(corpusPath, 'utf8'));
  return jobs.map((job) => ({ output: runJob(job) }));
}

if (process.env.QC_RUN_HARNESS === '1' && process.argv[2]) {
  process.stdout.write(`${JSON.stringify(runCorpus(process.argv[2]))}\n`);
}
