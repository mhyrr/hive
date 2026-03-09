export async function helpCommand(): Promise<string> {
  return `HIVE

Usage:
  hive init <project> <path>
  hive work [project]
  hive status
  hive log <message>
  hive msg [--type <type>] <from> <to> <body>
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
