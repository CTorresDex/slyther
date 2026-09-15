#!/bin/sh
set -e

path="$1"

if [ -z "$path" ]; then
    echo "Error: command path is required" >&2
    exit 1
fi

content="$2"

file="src/src/commands/${path}.command.ts"

if [ -e "$file" ]; then
    echo "Error: command file already exists at ${file}" >&2
    exit 1
fi

dir=$(dirname "$file")
mkdir -p "$dir"

if [ -n "$content" ]; then
    printf '%s' "$content" > "$file"
else
    segments=$(printf '%s' "$path" | awk -F'/' '{print NF}')
    relative=""
    i=0
    while [ "$i" -lt "$segments" ]; do
        relative="${relative}../"
        i=$((i + 1))
    done
    relative="${relative}classes"

    cat > "$file" <<EOF
import { Progress } from '${relative}/Progress.class.ts'

export const help = {
    short: 'TODO: describe what ${path} does',
    long: \`Usage: gstudio ${path} <args> [--flags]

TODO: describe what this command does.

Arguments:
  <args>     TODO

Flags:
  --flag     TODO\`,
}

export default async function (args: string[], context: { flags: Record<string, string | boolean> }) {
    const outcome = await Progress.of('Running').run(() => Promise.resolve())

    console.log(outcome)
}
EOF
fi

echo "Created ${file}"
