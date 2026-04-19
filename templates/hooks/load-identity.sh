#!/bin/bash
# HIVE identity loader — injects ~/.hive identity files into Claude Code context.
# Order matters: soul stack → project memory → reflection protocol → overrides.
# Later instructions get more weight in the system prompt, so OVERRIDES.md is last.
HIVE_DIR="$HOME/.hive"

# 1. Soul stack — who we are, who Greg is, operational doctrine, trust boundaries
for file in SOUL.md IDENTITY.md SELF.md AGENTS.md TRUST.md; do
  path="$HIVE_DIR/$file"
  if [ -f "$path" ]; then
    cat "$path"
    echo ""
    echo "---"
    echo ""
  fi
done

# 2. Project context — resolve project by PWD, load its memory index
MATCHED_PROJECT=""
if [ -d "$HIVE_DIR/projects" ]; then
  for projdir in "$HIVE_DIR"/projects/*/; do
    config="$projdir/config.md"
    if [ -f "$config" ]; then
      projpath=$(grep '^path:' "$config" | sed 's/^path:[[:space:]]*//')
      if [ -n "$projpath" ] && echo "$PWD" | grep -q "^$projpath"; then
        MATCHED_PROJECT=$(basename "$projdir")
        break
      fi
    fi
  done
fi

if [ -n "$MATCHED_PROJECT" ]; then
  indexfile="$HIVE_DIR/memory/projects/$MATCHED_PROJECT/_index.md"
  knowledgefile="$HIVE_DIR/memory/projects/$MATCHED_PROJECT/knowledge.md"
  if [ -f "$indexfile" ]; then
    cat "$indexfile"
    echo ""
  elif [ -f "$knowledgefile" ]; then
    cat "$knowledgefile"
    echo ""
  fi
fi

# 3. Reflection protocol — session-end discipline
cat <<'REFLECT'

## Session Reflection Protocol
Before ending any substantive session, review what you learned and call
reflect_session (or individual write_hive_memory calls) for:
- New durable facts about the project (architecture, constraints, gotchas)
- Conventions discovered or established
- Decisions made with their rationale
- Open questions that remain unresolved
Only record genuinely durable, non-obvious information.
Skip if the session was trivial (quick question, no new learnings).
REFLECT

# 4. Platform counter-weights — loudest because they come last
if [ -f "$HIVE_DIR/OVERRIDES.md" ]; then
  echo ""
  echo "---"
  echo ""
  cat "$HIVE_DIR/OVERRIDES.md"
fi
