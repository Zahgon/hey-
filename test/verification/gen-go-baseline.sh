#!/usr/bin/env bash
# Regenerates the Go side of the report differential.
#
# Builds a scratch clone of the Go repo with the driver added, so the upstream
# checkout stays byte-identical. Reads verification/corpus.json, writes
# verification/go-baseline.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${HEY_GO_SRC:-$here/../../../scraped_repos/Go/rakyll_hey}"

if [ ! -f "$src/requester/report.go" ]; then
  echo "Go source not found at $src (set HEY_GO_SRC)" >&2
  exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

cp -R "$src/." "$scratch/"
rm -f "$scratch"/*_test.go "$scratch"/requester/*_test.go
rm -f "$scratch/hey.go"
cp "$here/go-driver.go.txt" "$scratch/requester/zz_driver.go"

# The driver is `package main`; move the requester package up so it can see the
# unexported report internals.
cd "$scratch/requester"
sed -i.bak 's/^package requester$/package main/' *.go && rm -f ./*.bak

go build -o "$scratch/report-driver" .
"$scratch/report-driver" < "$here/corpus.json" > "$here/go-baseline.json"

echo "wrote $here/go-baseline.json ($(wc -c < "$here/go-baseline.json") bytes)"
