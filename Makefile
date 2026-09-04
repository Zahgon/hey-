binary = hey

# The Go Makefile cross-compiled three static binaries and pushed them to a GCS
# bucket. JavaScript has no cross-compilation step: the same source runs on
# every platform Node supports, so `release` would be `npm publish`.
#
# That is deliberately NOT wired up. Publishing requires an npm package name and
# a credential strategy, both of which are product decisions rather than
# migration decisions. See MIGRATION-REPORT-GO-JS.md.

.PHONY: test check baseline corpus cli-diff verify release

test:
	npm test

check:
	npm run check

corpus:
	npm run test:corpus

baseline:
	npm run test:baseline

cli-diff:
	npm run test:cli-diff

# Full equivalence run: rebuild the corpus, re-derive the Go baseline from the
# upstream source, then diff everything.
verify: corpus baseline test

release:
	@echo "release is intentionally not automated; see MIGRATION-REPORT-GO-JS.md"
	@exit 1
