#!/bin/sh
set -e

path="$1"

if [ -z "$path" ]; then
    echo "Error: missing required argument <path>" >&2
    exit 1
fi

grep -rnw \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    -e "$path" \
    . 2>/dev/null | awk -F: '{print $1":"$2}'

exit 0
