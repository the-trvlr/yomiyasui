#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="$ROOT/site"
WORK="$(mktemp -d)"
JM_VERSION="${JM_VERSION:-3.6.2+20261012204142}"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$SITE/vendor/kuromoji/build" "$SITE/vendor/kuromoji/dict" "$SITE/vendor/jszip/dist" "$SITE/data"
mkdir -p "$WORK/kuromoji" "$WORK/jszip"

echo "Preparing Kuromoji 0.1.2..."
cd "$WORK"
npm pack --silent kuromoji@0.1.2 >/dev/null
tar -xzf kuromoji-0.1.2.tgz -C "$WORK/kuromoji" --strip-components=1
cp "$WORK/kuromoji/build/kuromoji.js" "$SITE/vendor/kuromoji/build/kuromoji.js"
cp -R "$WORK/kuromoji/dict/." "$SITE/vendor/kuromoji/dict/"
find "$WORK/kuromoji" -maxdepth 1 -type f -iname 'license*' -exec cp {} "$SITE/vendor/kuromoji/" \;

echo "Preparing JSZip 3.10.1..."
npm pack --silent jszip@3.10.1 >/dev/null
tar -xzf jszip-3.10.1.tgz -C "$WORK/jszip" --strip-components=1
cp "$WORK/jszip/dist/jszip.min.js" "$SITE/vendor/jszip/dist/jszip.min.js"
find "$WORK/jszip" -maxdepth 1 -type f -iname 'license*' -exec cp {} "$SITE/vendor/jszip/" \;

encoded_version="${JM_VERSION/+/%2B}"
release_base="https://github.com/scriptin/jmdict-simplified/releases/download/$encoded_version"

echo "Preparing JMdict archives $JM_VERSION..."
curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 240 \
  "$release_base/jmdict-eng-$JM_VERSION.json.zip" \
  --output "$SITE/data/jmdict-eng-$JM_VERSION.json.zip"
curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 180 \
  "$release_base/jmdict-rus-$JM_VERSION.json.zip" \
  --output "$SITE/data/jmdict-rus-$JM_VERSION.json.zip"
curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 60 \
  "https://www.edrdg.org/edrdg/licence.html" \
  --output "$SITE/data/EDRDG-LICENSE.html"

test -s "$SITE/vendor/kuromoji/build/kuromoji.js"
test -s "$SITE/vendor/jszip/dist/jszip.min.js"
test -s "$SITE/data/jmdict-eng-$JM_VERSION.json.zip"
test -s "$SITE/data/jmdict-rus-$JM_VERSION.json.zip"
test -s "$SITE/data/EDRDG-LICENSE.html"
test "$(find "$SITE/vendor/kuromoji/dict" -type f | wc -l)" -gt 10

echo "Prepared local app assets:"
du -sh "$SITE/vendor" "$SITE/data"
