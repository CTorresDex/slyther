#!/bin/sh
set -eu

search_term="${1:-}"
commands_dir="src/src/commands"

if [ ! -d "$commands_dir" ]; then
    exit 0
fi

find "$commands_dir" -type f -name '*.command.ts' | sort | while IFS= read -r file; do
    rel="${file#"$commands_dir"/}"
    command_path="${rel%.command.ts}"

    if [ -n "$search_term" ] && ! grep -qF -- "$search_term" "$file"; then
        continue
    fi

    echo "[$command_path]: [$file]"
done
