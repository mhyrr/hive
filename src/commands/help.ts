export async function helpCommand(): Promise<string> {
  return `HIVE

Usage:
  hive init
  hive project add <project> <path>
  hive work [project]
  hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]
  hive inbox [agent]
  hive status
  hive log <message>
  hive msg [--type <type>] <from> <to> <body>
  hive msg show <message>
  hive msg resolve <message> <actor> <answer>
  hive msg close <message> <actor> [note]
  hive nudge <message>
  hive prompt <agent-id>
  hive archive
  hive sync
  hive help

Notes:
  - HIVE stores state in ~/.hive/ by default.
  - Set HIVE_HOME to point the CLI at a different hive root.
  - Project names are normalized to lowercase slugs on disk.`;
}
