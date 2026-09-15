#!/bin/sh
set -eu

PROJECT_FILE=".gstudio/project.json"

if [ ! -f "$PROJECT_FILE" ]; then
  echo "Error: $PROJECT_FILE not found." >&2
  exit 1
fi

TEMPLATE_NAME=""

if command -v jq >/dev/null 2>&1; then
  TEMPLATE_NAME=$(jq -r '.template.name // empty' "$PROJECT_FILE" 2>/dev/null) || {
    echo "Error: failed to parse $PROJECT_FILE as JSON." >&2
    exit 1
  }
elif command -v node >/dev/null 2>&1; then
  TEMPLATE_NAME=$(node -e '
    const fs = require("fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((data && data.template && data.template.name) ? data.template.name : "");
    } catch (e) {
      process.exit(1);
    }
  ' "$PROJECT_FILE") || {
    echo "Error: failed to parse $PROJECT_FILE as JSON." >&2
    exit 1
  }
elif command -v python3 >/dev/null 2>&1; then
  TEMPLATE_NAME=$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print(data.get("template", {}).get("name", ""))
except Exception:
    sys.exit(1)
' "$PROJECT_FILE") || {
    echo "Error: failed to parse $PROJECT_FILE as JSON." >&2
    exit 1
  }
else
  echo "Error: no JSON parser available (jq, node, or python3 required)." >&2
  exit 1
fi

if [ "$TEMPLATE_NAME" != "ts" ]; then
  echo "Error: $PROJECT_FILE has template.name '$TEMPLATE_NAME', expected 'ts'." >&2
  exit 1
fi

exit 0
