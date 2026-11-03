// Integrity check for the frozen corpus: re-renders the scenario into a
// temp dir and verifies the committed corpus/ and gold/ match byte-for-byte
// (which also re-runs every scenario consistency check inside render.ts,
// and re-imports the git stream so commit SHAs are re-verified).
//
//   bun run loam/benchmark/tools/validate.ts

import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const BENCH_ROOT = join(import.meta.dir, "..");

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

const tmp = mkdtempSync(join(tmpdir(), "loam-bench-"));
try {
  const render = spawnSync("bun", ["run", join(import.meta.dir, "render.ts"), "--out", tmp], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (render.status !== 0) {
    console.error("RENDER FAILED (scenario consistency check tripped):");
    console.error(String(render.stderr));
    process.exit(1);
  }

  let bad = 0;
  for (const sub of ["corpus", "gold"]) {
    const frozen = join(BENCH_ROOT, sub);
    const fresh = join(tmp, sub);
    const a = listFiles(frozen);
    const b = listFiles(fresh);
    for (const f of b) if (!a.includes(f)) (bad++, console.error(`MISSING from frozen ${sub}/: ${f}`));
    for (const f of a) if (!b.includes(f)) (bad++, console.error(`STALE in frozen ${sub}/ (not rendered): ${f}`));
    for (const f of a) {
      if (!b.includes(f)) continue;
      if (!readFileSync(join(frozen, f)).equals(readFileSync(join(fresh, f))))
        (bad++, console.error(`DRIFT: ${sub}/${f} differs from scenario render — re-run render.ts`));
    }
  }
  if (bad) {
    console.error(`\n${bad} problem(s). The frozen corpus is out of sync with scenario/.`);
    process.exit(1);
  }
  const stats = JSON.parse(readFileSync(join(BENCH_ROOT, "gold", "stats.json"), "utf8"));
  console.log("OK — frozen corpus matches scenario render, all consistency checks pass.");
  console.log(
    `   ${stats.exhaust_events.total} exhaust events, ${Object.values(stats.gold_artifacts as Record<string, number>).reduce((x, y) => x + y, 0)} gold artifacts, ${stats.reference_events.total} gold reference events.`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
