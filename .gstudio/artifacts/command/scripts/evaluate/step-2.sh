#!/bin/sh
set -e

path="$1"

if [ -z "$path" ]; then
  echo "Error: command path is required" >&2
  exit 1
fi

file="src/src/commands/${path}.command.ts"

if [ ! -f "$file" ]; then
  echo "Error: command file does not exist: $file" >&2
  exit 1
fi

tmpfile=$(mktemp)
awktmp=$(mktemp)
trap 'rm -f "$tmpfile" "$awktmp"' EXIT

awk '
{
  line = $0
  trimmed = line
  gsub(/^[ \t]+/, "", trimmed)
  gsub(/[ \t]+$/, "", trimmed)

  if (instmt == 0) {
    if (incomment == 1) {
      if (trimmed ~ /\*\//) incomment = 0
    } else if (trimmed == "") {
      # blank line, not a statement
    } else if (trimmed ~ /^\/\//) {
      # line comment, not a statement
    } else if (trimmed ~ /^\/\*/) {
      if (trimmed !~ /\*\//) incomment = 1
    } else if (trimmed ~ /^import /) {
      instmt = 1
      isdef = 0
    } else {
      instmt = 1
      isdef = 1
      count++
      startline[count] = NR
      text[count] = trimmed
    }
  } else {
    if (isdef == 1) {
      text[count] = text[count] " " trimmed
    }
  }

  if (incomment == 0) {
    n = length(line)
    for (k = 1; k <= n; k++) {
      c = substr(line, k, 1)
      if (c == "{") depth++
      else if (c == "}") depth--
    }
  }

  if (instmt == 1 && depth == 0) instmt = 0
}
END {
  for (j = 1; j <= count; j++) {
    print startline[j] "\t" text[j]
  }
}
' "$file" > "$tmpfile"

cat <<'AWK_EOF' > "$awktmp"
function find_matching_paren(s, start,    depth, i, c, n, q) {
  n = length(s)
  depth = 1
  i = start + 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "'" || c == "\"" || c == "`") {
      q = c
      i++
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\\") { i += 2; continue }
        if (c == q) { i++; break }
        i++
      }
      continue
    }
    if (c == "(") { depth++ }
    else if (c == ")") { depth--; if (depth == 0) return i }
    i++
  }
  return 0
}

{
  body = $0
  n = length(body)
  i = 1
  numSafeZones = 0
  numAwaitSafe = 0
  discrepancyFound = 0

  while (1) {
    rest = substr(body, i)
    p = index(rest, "Progress.of(")
    if (p == 0) break
    idx = i + p - 1
    openIdx = idx + 11

    closeIdx = find_matching_paren(body, openIdx)
    if (closeIdx == 0) {
      print "Discrepancy: \"Progress.of(\" call has no matching closing parenthesis near: ..." substr(body, idx, 60) "..."
      discrepancyFound = 1
      i = openIdx + 1
      continue
    }

    label = substr(body, openIdx + 1, closeIdx - openIdx - 1)
    trimmed = label
    gsub(/^ +/, "", trimmed)
    gsub(/ +$/, "", trimmed)

    ok = 0
    if (trimmed ~ /^'([^'\\]|\\.)+'$/) ok = 1
    else if (trimmed ~ /^"([^"\\]|\\.)+"$/) ok = 1
    else if (trimmed ~ /^`([^`\\]|\\.)+`$/) ok = 1

    if (!ok) {
      print "Discrepancy: Progress.of(" label ") is not given a single non-empty string or template literal."
      discrepancyFound = 1
    }

    restAfter = substr(body, closeIdx + 1)
    if (match(restAfter, /^ *\.run\(/)) {
      runOpenIdx = closeIdx + RSTART + RLENGTH - 1
      runCloseIdx = find_matching_paren(body, runOpenIdx)
      if (runCloseIdx == 0) {
        print "Discrepancy: \".run(\" following Progress.of(" label ") has no matching closing parenthesis."
        discrepancyFound = 1
      } else {
        numSafeZones++
        safeStart[numSafeZones] = runOpenIdx
        safeEnd[numSafeZones] = runCloseIdx
        if (idx > 6 && substr(body, idx - 6, 6) == "await ") {
          numAwaitSafe++
          awaitSafeIdx[numAwaitSafe] = idx - 6
        }
      }
    } else {
      print "Discrepancy: Progress.of(" label ") is not followed by '.run(...)'."
      discrepancyFound = 1
    }

    i = closeIdx + 1
  }

  pos = 1
  while (1) {
    rest = substr(body, pos)
    p = index(rest, "await")
    if (p == 0) break
    idx = pos + p - 1
    before = (idx == 1) ? "" : substr(body, idx - 1, 1)
    after = substr(body, idx + 5, 1)

    if (before !~ /[A-Za-z0-9_$]/ && after !~ /[A-Za-z0-9_$]/) {
      safe = 0
      for (k = 1; k <= numAwaitSafe; k++) {
        if (awaitSafeIdx[k] == idx) { safe = 1; break }
      }
      if (!safe) {
        for (k = 1; k <= numSafeZones; k++) {
          if (idx >= safeStart[k] && idx <= safeEnd[k]) { safe = 1; break }
        }
      }
      if (!safe) {
        ctxStart = (idx - 30 < 1 ? 1 : idx - 30)
        print "Discrepancy: an 'await' is not inside a Progress.of({label}).run(...) call, near: ..." substr(body, ctxStart, 80) "..."
        discrepancyFound = 1
      }
    }

    pos = idx + 1
  }

  if (discrepancyFound == 1) exit 1
  exit 0
}
AWK_EOF

total=$(wc -l < "$tmpfile" | tr -d ' ')
discrepancy_found=0
position=0
help_position=0
default_position=0
help_count=0
default_count=0

while IFS='	' read -r lineno snippet; do
  position=$((position + 1))
  normalized=$(printf '%s' "$snippet" | tr -s '[:space:]' ' ')

  case "$normalized" in
    "export const help"*)
      help_count=$((help_count + 1))
      help_position=$position
      if ! printf '%s' "$normalized" | grep -Eq '^export const help[[:space:]]*=[[:space:]]*\{'; then
        echo "Discrepancy: 'help' at line $lineno is not an object literal assigned via 'export const help'. Found: $snippet"
        discrepancy_found=1
      fi
      if ! printf '%s' "$normalized" | grep -Eq "short:[[:space:]]*('[^']*'|\"[^\"]*\")"; then
        echo "Discrepancy: 'help' at line $lineno is missing a 'short' string property."
        discrepancy_found=1
      fi
      if ! printf '%s' "$normalized" | grep -Eq "long:[[:space:]]*('[^']*'|\"[^\"]*\"|\`[^\`]*\`)"; then
        echo "Discrepancy: 'help' at line $lineno is missing a 'long' string property."
        discrepancy_found=1
      fi
      ;;
    "export default"*)
      default_count=$((default_count + 1))
      default_position=$position
      if ! printf '%s' "$normalized" | grep -Eq '^export default async function[[:space:]]*\(args: string\[\], context: \{ flags: Record<string, string \| boolean> \}\)'; then
        echo "Discrepancy: default export at line $lineno does not match the required template signature 'export default async function (args: string[], context: { flags: Record<string, string | boolean> })'. Found: $snippet"
        discrepancy_found=1
      fi

      if awk_output=$(printf '%s\n' "$normalized" | awk -f "$awktmp"); then
        :
      else
        if [ -n "$awk_output" ]; then
          printf '%s\n' "$awk_output"
        fi
        discrepancy_found=1
      fi
      ;;
    *)
      echo "Discrepancy: unexpected top-level definition at line $lineno (only 'export const help' and the anonymous default exported async function are allowed): $snippet"
      discrepancy_found=1
      ;;
  esac
done < "$tmpfile"

if [ "$total" -ne 2 ]; then
  echo "Discrepancy: expected exactly 2 top-level definitions in $file, found $total."
  discrepancy_found=1
fi

if [ "$help_count" -eq 0 ]; then
  echo "Discrepancy: no 'export const help' object literal found in $file."
  discrepancy_found=1
elif [ "$help_count" -gt 1 ]; then
  echo "Discrepancy: 'export const help' is defined $help_count times in $file; it must be defined exactly once."
  discrepancy_found=1
fi

if [ "$default_count" -eq 0 ]; then
  echo "Discrepancy: no default export function found in $file; expected 'export default async function (args: string[], context: { flags: Record<string, string | boolean> })'."
  discrepancy_found=1
elif [ "$default_count" -gt 1 ]; then
  echo "Discrepancy: the default export is defined $default_count times in $file; it must be defined exactly once."
  discrepancy_found=1
fi

if [ "$help_count" -eq 1 ] && [ "$default_count" -eq 1 ] && [ "$help_position" -gt "$default_position" ]; then
  echo "Discrepancy: 'export const help' must be defined before the default export, but it appears after it in $file."
  discrepancy_found=1
fi

if [ "$discrepancy_found" -eq 1 ]; then
  exit 1
fi

exit 0
