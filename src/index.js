// Public entry point, mirroring `import "github.com/rakyll/hey/requester"`.
export { Work, cloneRequest, Report, newTemplate, now } from './requester/index.js';
export { Header, canonicalHeaderKey } from './internal/goheader.js';
export { headerRegexp, authRegexp, findStringSubmatch } from './internal/goregexp.js';
export { parseDuration, seconds } from './internal/goduration.js';
