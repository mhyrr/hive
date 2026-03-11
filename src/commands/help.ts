export async function helpCommand(): Promise<string> {
  return `HIVE

Usage:
  hive run [--interval <seconds>] [--max-parallel <count>]
  hive say <message>
  hive ask [question]
  hive watch [count] [--interval <seconds>] [--once]
  hive stop <agent-id|run-id>

  hive init
  hive project add <project> <path>
  hive work [project]
  hive status
  hive feed [count]
  hive ps

  hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]
  hive supervise status
  hive supervise stop
  hive supervise logs
  hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]
  hive console [--runtime <runtime>] [--model <model>]
                                # Interactive session with the hive
  hive chat [--runtime <runtime>] [--model <model>] [--dry-run] <message>
  hive launch [--runtime <runtime>] [--model <model>] [--dry-run] <agent-id> [goal]
  hive inbox [agent]
  hive log <message>
  hive memory                         # Show project memory
  hive memory fact|convention|decision|question <text>
                                      # Append to project memory
  hive msg [--type <type>] <from> <to> <body>
  hive msg show <message>
  hive msg resolve <message> <actor> <answer>
  hive msg close <message> <actor> [note]
  hive nudge <message>
  hive prompt <agent-id>
  hive runtimes                        # List available runtimes
  hive gateway [--port <port>] [--open] # Start the Gateway server
  hive gateway status                   # Show Gateway state
  hive gateway stop                     # Stop the Gateway server
  hive archive
  hive sync
  hive help

Notes:
  - HIVE stores state in ~/.hive/ by default.
  - Set HIVE_HOME to point the CLI at a different hive root.
  - Project names are normalized to lowercase slugs on disk.`;
}
