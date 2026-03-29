#!/bin/bash
# HIVE identity loader — injects ~/.hive identity files into Claude Code context
HIVE_DIR="$HOME/.hive"

for file in SOUL.md IDENTITY.md SELF.md AGENTS.md TRUST.md; do
  path="$HIVE_DIR/$file"
  if [ -f "$path" ]; then
    cat "$path"
    echo ""
    echo "---"
    echo ""
  fi
done

# Load project memory if we can match the project
if [ -d "$HIVE_DIR/memory/projects" ]; then
  for memfile in "$HIVE_DIR"/memory/projects/*.md; do
    if [ -f "$memfile" ]; then
      cat "$memfile"
      echo ""
    fi
  done
fi
