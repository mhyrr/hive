/**
 * Render `hive context` output to a standalone HTML page for screenshotting
 * into img/hive-context.png.
 *
 * The command's whole point is that color carries meaning, so the README
 * wants a picture rather than a fenced code block. Generating the page from
 * real output keeps the asset honest — rerun this and recapture instead of
 * pasting a fresh screenshot when the render changes.
 *
 *   bun run scripts/render-context-screenshot.ts
 *   # then open the printed path and screenshot the <pre>, saving to
 *   # img/hive-context.png
 *
 * No dependencies on purpose: a headless browser is a heavy thing to install
 * for one README asset, and every machine already has one.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(tmpdir(), "hive-context-shot.html");

// Approximates the terminal this is normally read in: dark ground, soft
// off-white default ink. The command's own hues arrive via the ANSI codes.
const BG = "#1e1e2e";
const FG = "#cdd6f4";

/** Translate the SGR subset the renderer emits — truecolor, bold, reset. */
export function ansiToHtml(raw: string): string {
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let open = 0;
  const html = escaped.replace(/\x1b\[([0-9;]*)m/g, (_match, codes: string) => {
    if (codes === "0" || codes === "") {
      const close = "</span>".repeat(open);
      open = 0;
      return close;
    }
    const rgb = codes.match(/^38;2;(\d+);(\d+);(\d+)$/);
    if (rgb) {
      open++;
      return `<span style="color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})">`;
    }
    if (codes === "1") {
      open++;
      return `<span style="font-weight:700">`;
    }
    return "";
  });

  // Terminals give ⛁ and ⛶ one cell each; browsers fall back to a symbol font
  // where their advance widths differ, which shears the grid away from the
  // legend beside it. Pin both to a single character width.
  return (html + "</span>".repeat(open)).replace(/[⛁⛶]/g, (g) => `<i class="g">${g}</i>`);
}

if (import.meta.main) {
  const run = spawnSync("bun", ["run", join(ROOT, "src", "cli.ts"), "context"], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "1" },
    encoding: "utf-8",
  });

  // The command exits 1 when something is over budget — expected, and the
  // more informative picture. Only missing stdout is a real failure.
  const output = run.stdout;
  if (!output?.trim()) {
    console.error("hive context produced no output");
    console.error(run.stderr);
    process.exit(1);
  }

  writeFileSync(
    OUT,
    `<!doctype html>
<html><head><meta charset="utf-8"><title>hive context</title><style>
  html, body { margin: 0; background: ${BG}; }
  pre {
    margin: 0;
    padding: 28px 34px;
    display: inline-block;
    background: ${BG};
    color: ${FG};
    font: 15px/1.55 "JetBrains Mono", "SF Mono", "Menlo", "DejaVu Sans Mono", monospace;
    font-variant-ligatures: none;
    white-space: pre;
  }
  .g { display: inline-block; width: 1ch; font-style: normal; }
</style></head>
<body><pre id="out">${ansiToHtml(output)}</pre></body></html>
`,
  );

  console.log(OUT);
}
