/*
Hey supports two output formats: summary and CSV

The summary output presents a number of statistics about the requests in a
human-readable format, including:
- general statistics: requests/second, total runtime, and average, fastest, and slowest requests.
- a response time histogram.
- a percentile latency distribution.
- statistics (average, fastest, slowest) on the stages of the requests.

The comma-separated CSV format is proceeded by a header, and consists of the following columns:
1. response-time:	Total time taken for request (in seconds)
2. DNS+dialup:		Time taken to establish the TCP connection (in seconds)
3. DNS:				Time taken to do the DNS lookup (in seconds)
4. Request-write:	Time taken to write full request (in seconds)
5. Response-delay: 	Time taken to first byte received (in seconds)
6. Response-read:	Time taken to read full response (in seconds)
7. status-code:		HTTP status code of the response (e.g. 200)
8. offset:			The time since the start of the benchmark when the request was started. (in seconds)
*/

import { newTemplate as newGoTemplate } from '../internal/gotemplate/index.js';
import { formatNumber, formatNumber3, formatNumberInt } from '../internal/gofmt.js';
import { marshalJSON } from '../internal/gojson.js';

const barChar = '\u25a0';

export function newTemplate(output) {
  let outputTmpl = output;
  switch (outputTmpl) {
    case '':
      outputTmpl = defaultTmpl;
      break;
    case 'csv':
      outputTmpl = csvTmpl;
      break;
    default:
      break;
  }
  return newGoTemplate('tmpl', outputTmpl, tmplFuncMap);
}

function jsonify(v) {
  return marshalJSON(v);
}

/**
 * Renders the bar chart. Every division here is Go INTEGER division on `int`,
 * which is why counts are BigInt: `(count*40 + max/2) / max` truncates twice,
 * and doing it in floating point would change bar lengths by one character.
 */
function histogram(buckets) {
  let max = 0n;
  for (const b of buckets) {
    if (b.Count > max) max = b.Count;
  }
  let res = '';
  for (let i = 0; i < buckets.length; i++) {
    let barLen = 0n;
    if (max > 0n) {
      barLen = (buckets[i].Count * 40n + max / 2n) / max;
    }
    res += `  ${formatNumber3(buckets[i].Mark)} [${buckets[i].Count}]\t|${barChar.repeat(Number(barLen))}\n`;
  }
  return res;
}

export const tmplFuncMap = {
  formatNumber,
  formatNumberInt,
  histogram,
  jsonify,
};

// NOTE: the `%%` sequences below are copied verbatim from hey's Go source.
// They are NOT printf escapes here: report.print() renders the template first
// and then passes the result as an ARGUMENT to Fprintf("%s", ...), so nothing
// ever interprets them. Real hey prints a literal "10%% in 0.0001 secs", which
// this port reproduces rather than silently "fixing".
export const defaultTmpl = `
Summary:
  Total:	{{ formatNumber .Total.Seconds }} secs
  Slowest:	{{ formatNumber .Slowest }} secs
  Fastest:	{{ formatNumber .Fastest }} secs
  Average:	{{ formatNumber .Average }} secs
  Requests/sec:	{{ formatNumber .Rps }}
  {{ if gt .SizeTotal 0 }}
  Total data:	{{ .SizeTotal }} bytes
  Size/request:	{{ .SizeReq }} bytes{{ end }}

Response time histogram:
{{ histogram .Histogram }}

Latency distribution:{{ range .LatencyDistribution }}
  {{ .Percentage }}%% in {{ formatNumber .Latency }} secs{{ end }}

Details (average, fastest, slowest):
  DNS+dialup:	{{ formatNumber .AvgConn }} secs, {{ formatNumber .ConnMax }} secs, {{ formatNumber .ConnMin }} secs
  DNS-lookup:	{{ formatNumber .AvgDNS }} secs, {{ formatNumber .DnsMax }} secs, {{ formatNumber .DnsMin }} secs
  req write:	{{ formatNumber .AvgReq }} secs, {{ formatNumber .ReqMax }} secs, {{ formatNumber .ReqMin }} secs
  resp wait:	{{ formatNumber .AvgDelay }} secs, {{ formatNumber .DelayMax }} secs, {{ formatNumber .DelayMin }} secs
  resp read:	{{ formatNumber .AvgRes }} secs, {{ formatNumber .ResMax }} secs, {{ formatNumber .ResMin }} secs

Status code distribution:{{ range $code, $num := .StatusCodeDist }}
  [{{ $code }}]	{{ $num }} responses{{ end }}

{{ if gt (len .ErrorDist) 0 }}Error distribution:{{ range $err, $num := .ErrorDist }}
  [{{ $num }}]	{{ $err }}{{ end }}{{ end }}
`;

export const csvTmpl = `{{ $connLats := .ConnLats }}{{ $dnsLats := .DnsLats }}{{ $dnsLats := .DnsLats }}{{ $reqLats := .ReqLats }}{{ $delayLats := .DelayLats }}{{ $resLats := .ResLats }}{{ $statusCodeLats := .StatusCodes }}{{ $offsets := .Offsets}}response-time,DNS+dialup,DNS,Request-write,Response-delay,Response-read,status-code,offset{{ range $i, $v := .Lats }}
{{ formatNumber $v }},{{ formatNumber (index $connLats $i) }},{{ formatNumber (index $dnsLats $i) }},{{ formatNumber (index $reqLats $i) }},{{ formatNumber (index $delayLats $i) }},{{ formatNumber (index $resLats $i) }},{{ formatNumberInt (index $statusCodeLats $i) }},{{ formatNumber (index $offsets $i) }}{{ end }}`;
