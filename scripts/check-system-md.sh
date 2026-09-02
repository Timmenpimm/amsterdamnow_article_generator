#!/usr/bin/env bash
# Poort: elk backtick-pad in docs/SYSTEM.md dat op een bestand of map lijkt, moet bestaan.
# Dode paden = verouderde werkingskaart = fout.
set -u
cd "$(dirname "$0")/.."
f=docs/SYSTEM.md
[ -f "$f" ] || { echo "ONTBREEKT: $f"; exit 1; }
lines=$(wc -l < "$f" | tr -d ' ')
[ "$lines" -le 160 ] || { echo "TE LANG: $f heeft $lines regels (max 160)"; exit 1; }
rc=0
while IFS= read -r p; do
  case "$p" in
    http*|*' '*|*'<'*|*'>'*|*'*'*|*'$'*|*'#'*) continue;;
  esac
  case "$p" in
    */*|*.md|*.ts|*.tsx|*.py|*.sh|*.json|*.sql|*.yml|*.yaml|*.toml|*.js|*.mjs|*.cjs|*.env*) ;;
    *) continue;;
  esac
  [ -e "$p" ] || { echo "DOOD PAD in $f: $p"; rc=1; }
done < <(grep -o '`[^`]*`' "$f" | tr -d '`' | sort -u)
[ $rc -eq 0 ] && echo "OK: $f ($lines regels, paden bestaan)"
exit $rc
