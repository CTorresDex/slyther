#!/bin/sh
set -e

id="$1"

if [ -z "$id" ]; then
    echo "Error: missing required argument <id>" >&2
    exit 1
fi

# Convert id to camelCase, as defined at the artifact rules (rule 1).
function_name=$(printf '%s' "$id" | awk '{
    n = split($0, parts, /[^a-zA-Z0-9]+/);
    result = "";
    for (i = 1; i <= n; i++) {
        if (parts[i] != "") {
            if (result == "") {
                result = tolower(substr(parts[i], 1, 1)) substr(parts[i], 2);
            } else {
                result = result toupper(substr(parts[i], 1, 1)) substr(parts[i], 2);
            }
        }
    }
    print result;
}')

if [ -z "$function_name" ]; then
    echo "Error: could not derive a function name from id '$id'" >&2
    exit 1
fi

grep -rnw \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    -e "$function_name" \
    . 2>/dev/null | awk -F: '{print $1":"$2}'

exit 0
