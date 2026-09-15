#!/bin/sh

id="$1"
if [ -z "$id" ]; then
  echo "Error: missing required argument <id>" >&2
  exit 1
fi

spaced=$(printf '%s' "$id" | sed -E 's/([a-z0-9])([A-Z])/\1 \2/g; s/[^a-zA-Z0-9]+/ /g')

name=$(printf '%s' "$spaced" | awk '{
  result = ""
  for (i = 1; i <= NF; i++) {
    word = $i
    first = toupper(substr(word, 1, 1))
    rest = substr(word, 2)
    result = result first rest
  }
  print result
}')

if [ -z "$name" ]; then
  echo "Error: could not derive a valid enum name from id '$id'" >&2
  exit 1
fi

enum_file="src/enums/${name}.enum.ts"

matches=$(grep -rn -E "\<${name}\>" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build \
  . 2>/dev/null | grep -v -E "^\./?${enum_file}:")

if [ -n "$matches" ]; then
  printf '%s\n' "$matches" | while IFS=: read -r filepath line rest; do
    filepath=$(printf '%s' "$filepath" | sed 's#^\./##')
    echo "${filepath}:${line}"
  done
fi

exit 0
