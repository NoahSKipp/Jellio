#!/usr/bin/env bash
# Compares the shared test vectors with the Jellio TV copy.
#
# Both repos run the same tests/vectors/*.json: this one from tests/vectors,
# Jellio TV from app/src/test/resources/vectors. To change a rule, edit the
# file here, bump its "version", copy it over with --sync, and make both
# clients pass (node --test tests/frontend/vectors.test.mjs here, VectorsTest
# there). CI in each repo only sees its own copy, so run this with both
# checked out side by side.
#
# Usage: scripts/check-vectors.sh [--sync] [path to jellio-tv]
# The TV path defaults to $JELLIO_TV_DIR, then ../jellio-tv.
set -euo pipefail

sync=false
if [ "${1:-}" = "--sync" ]; then
  sync=true
  shift
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
tv="${1:-${JELLIO_TV_DIR:-$here/../jellio-tv}}"
ours="$here/tests/vectors"
theirs="$tv/app/src/test/resources/vectors"

if [ ! -d "$theirs" ]; then
  echo "No Jellio TV vectors at $theirs (pass the jellio-tv checkout as an argument or set JELLIO_TV_DIR)." >&2
  exit 2
fi

if $sync; then
  rm -f "$theirs"/*.json
  cp "$ours"/*.json "$theirs"/
  echo "Copied $(ls "$ours"/*.json | wc -l) vector files to $theirs"
  exit 0
fi

version() { sed -n 's/^  "version": \([0-9]*\),$/\1/p' "$1"; }

status=0
for file in "$ours"/*.json "$theirs"/*.json; do
  name="$(basename "$file")"
  if [ ! -f "$ours/$name" ] || [ ! -f "$theirs/$name" ]; then
    echo "only on one side: $name" >&2
    status=1
    continue
  fi
  [ "$file" = "$ours/$name" ] || continue
  if [ "$(version "$ours/$name")" != "$(version "$theirs/$name")" ]; then
    echo "version differs: $name (web $(version "$ours/$name"), tv $(version "$theirs/$name"))" >&2
    status=1
  elif ! cmp -s "$ours/$name" "$theirs/$name"; then
    echo "content differs at the same version: $name" >&2
    status=1
  fi
done

if [ $status -eq 0 ]; then
  echo "Vectors match ($(ls "$ours"/*.json | wc -l) files)."
else
  echo "Vectors differ. Bump the version of each changed file and run scripts/check-vectors.sh --sync." >&2
fi
exit $status
