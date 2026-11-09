// While `hv` runs beside `hive`, a few commands would overwrite what `hive` owns:
// the nightly memory pipeline and the static dashboard. Remove this at cutover.

const PIPELINE_STEPS = new Set([
  "nightly",
  "condition",
  "extract-project",
  "extract-reflections",
  "verify",
  "apply",
]);

/** The reason this command must stay with `hive`, or null when `hv` can run it. */
export function hiveOwnedReason(args: string[]): string | null {
  const [command, subcommand] = args;
  if (command === "memory" && subcommand && PIPELINE_STEPS.has(subcommand)) {
    return `memory ${subcommand} belongs to hive until cutover: the nightly job already runs it.`;
  }
  if (command === "dashboard" && subcommand === "build") {
    return "dashboard build would overwrite hive's static dashboard. Use: hv dashboard serve";
  }
  return null;
}
