import { UsageError } from "../lib/errors";

/**
 * `hive think` has been removed. The steward now handles all reasoning directly.
 */
export async function thinkCommand(_args: string[]): Promise<never> {
  throw new UsageError(
    "The `think` command has been removed. The steward now handles planning and reasoning directly.",
  );
}
