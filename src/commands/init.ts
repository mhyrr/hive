import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";

export async function initCommand(args: string[]): Promise<string> {
  if (args.length > 0) {
    throw new UsageError(
      "Usage: hive init\nRegister a project with `hive project add <project> <path>`.",
    );
  }

  const paths = await ensureHiveScaffold();

  return `Initialized hive home
Hive home: ${paths.home}

Next:
- Customize ${paths.soul}
- Customize ${paths.self}
- Register a project with: hive project add <project> <path>`;
}
