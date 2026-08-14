// /watches/<name> — one watch, its prompts, and its invocation history (TK-138).
//
// Answers two questions the fleet table can't: what exactly is this job asking
// the model right now, and what did it ask on any given night. The top of the
// page builds the prompt live (same code path the runner uses, so it can't
// drift); the history below replays the exact prompts from the invocation log.

import { type HivePaths } from "../paths";
import { now as hiveNow } from "../time";
import {
  discoverWatches,
  findWatch,
  formatCadence,
  type WatchAutonomy,
  type WatchDef,
} from "../watch";
import { readInvocations, type WatchInvocation } from "../watch-log";
import { resolveWatchModel } from "../watch-model";
import { buildWatchSystemPrompt, clampAutonomy, readAutonomyCeiling } from "../watch-run";
import { freshEntry, loadWatchState, usageSince, type WatchStateEntry } from "../watch-state";
import { escapeHtml, md } from "./html";
import { DASHBOARD_CSS } from "./styles";
import {
  DROPPED_NOTE,
  formatDuration,
  isDropped,
  isSilence,
  renderWatchesNav,
} from "./watches-page";

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

/** How many past invocations to replay. Enough to see a pattern, not the year. */
const HISTORY_LIMIT = 10;

export type WatchDetailData = {
  generatedAt: string;
  watch: WatchDef;
  ceiling: WatchAutonomy;
  effectiveAutonomy: WatchAutonomy;
  /** The tier alias resolved to the model ID that would actually be called. */
  modelId: string;
  /** Built now, by the runner's own builder — what the next tick would send. */
  systemPrompt: string;
  state: WatchStateEntry;
  calls7d: number;
  tokens7d: number;
  invocations: WatchInvocation[];
  warnings: string[];
};

export async function collectWatchDetailPage(
  paths: HivePaths,
  ref: string,
): Promise<WatchDetailData | null> {
  const now = hiveNow();
  const { watches, warnings } = await discoverWatches(paths);
  const watch = findWatch(watches, ref);
  if (!watch) return null;

  const ceiling = readAutonomyCeiling(paths);
  const effectiveAutonomy = clampAutonomy(watch.autonomy, ceiling);
  const state = await loadWatchState(paths);
  const entry = state.watches[watch.qualifiedName] ?? freshEntry();
  const spend = usageSince(entry, now.getTime() - 7 * 86_400_000);

  const { invocations, warnings: logWarnings } = await readInvocations(paths, {
    watch: watch.qualifiedName,
    limit: HISTORY_LIMIT,
  });

  return {
    generatedAt: now.toISOString(),
    watch,
    ceiling,
    effectiveAutonomy,
    modelId: resolveWatchModel(watch.model, watch.name),
    systemPrompt: buildWatchSystemPrompt(watch, effectiveAutonomy),
    state: entry,
    calls7d: spend.calls,
    tokens7d: spend.inputTokens + spend.outputTokens,
    invocations,
    warnings: [...warnings, ...logWarnings],
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Digests run to tens of thousands of characters; past this the page is
 * unreadable and the file on disk is the better artifact. */
const PROMPT_DISPLAY_CAP = 40_000;

function verbatim(text: string, sourcePath?: string): string {
  const capped = text.length > PROMPT_DISPLAY_CAP;
  const shown = capped ? text.slice(0, PROMPT_DISPLAY_CAP) : text;
  const note = capped
    ? `<p class="watch-truncated mono">truncated at ${PROMPT_DISPLAY_CAP.toLocaleString()} of ${text.length.toLocaleString()} chars${
        sourcePath ? ` — full text: ${escapeHtml(sourcePath)}` : ""
      }</p>`
    : "";
  return `<pre class="watch-prompt">${escapeHtml(shown)}</pre>${note}`;
}

function specRows(data: WatchDetailData): string {
  const w = data.watch;
  const autonomy =
    data.effectiveAutonomy === w.autonomy
      ? escapeHtml(w.autonomy)
      : `${escapeHtml(w.autonomy)} → ${escapeHtml(data.effectiveAutonomy)} <span class="muted">(ceiling: ${escapeHtml(data.ceiling)})</span>`;
  const pairs: Array<[string, string]> = [
    ["State", w.enabled ? "on" : "off"],
    ["Cadence", `<span class="mono">${escapeHtml(formatCadence(w.cadence))}</span>`],
    ["Scope", `<span class="mono">${escapeHtml(w.scope.join(", "))}</span> · previous settled tick → current tick`],
    ["Autonomy", autonomy],
    ["Tier", `${escapeHtml(w.model)} → <span class="mono">${escapeHtml(data.modelId)}</span>`],
    ["Venue", escapeHtml(w.venue)],
    ["Project", w.project ? escapeHtml(w.project) : "cross-project"],
    ["Last tick", `<span class="mono">${escapeHtml(data.state.lastRun ?? "never")}</span>`],
    [
      "Last outcome",
      data.state.lastOutcome
        ? `${escapeHtml(data.state.lastOutcome)}${data.state.lastError ? ` <span class="mono">(${escapeHtml(data.state.lastError.slice(0, 120))})</span>` : ""}`
        : "—",
    ],
    ["7d logged", `<span class="mono">${data.calls7d} call(s) · ${data.tokens7d} tok</span>`],
    ["File", `<span class="mono">${escapeHtml(w.filePath)}</span>`],
  ];
  return pairs
    .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${v}</td></tr>`)
    .join("\n");
}

function renderInvocation(inv: WatchInvocation): string {
  const meta = [
    escapeHtml(inv.at),
    escapeHtml(inv.outcome),
    inv.model ? escapeHtml(inv.model) : null,
    formatDuration(inv.durationMs) || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const reasons = inv.reasons.length
    ? `<p class="watch-reasons mono">woke on: ${escapeHtml(inv.reasons.join(" | "))}</p>`
    : "";

  let body: string;
  if (inv.error != null) {
    body = `<pre class="watch-error">${escapeHtml(inv.error)}</pre>`;
  } else if (isSilence(inv.output)) {
    body = `<p class="watch-silence">Chose silence — nothing cleared the bar.</p>`;
  } else {
    const dropped = isDropped(inv.outcome) ? `<p class="watch-dropped">${escapeHtml(DROPPED_NOTE)}</p>` : "";
    body = `${dropped}<div class="watch-out">${md(inv.output ?? "")}</div>`;
  }

  return `<article class="watch-card">
    <div class="head">
      <span class="watch-name">${escapeHtml(inv.at.slice(0, 10))}</span>
      <span class="meta mono">${meta}</span>
    </div>
    ${reasons}
    ${body}
    <details class="watch-detail"><summary>System prompt sent</summary>${verbatim(inv.systemPrompt)}</details>
    <details class="watch-detail"><summary>User content sent (digest + standing question)</summary>${verbatim(inv.userContent, inv.path)}</details>
    <div class="watch-source mono">log: ${escapeHtml(inv.path)}</div>
  </article>`;
}

export function renderWatchDetailDocument(data: WatchDetailData): string {
  const w = data.watch;
  const nav = renderWatchesNav("/watches");

  const history =
    data.invocations.length === 0
      ? `<p>No model calls logged yet. The delta gate may simply have found nothing to look at — run it now with <code class="mono">hive watch run ${escapeHtml(w.qualifiedName)}</code>.</p>`
      : data.invocations.map(renderInvocation).join("\n");

  const warningsBlock =
    data.warnings.length === 0
      ? ""
      : `<section class="section">
    <h2>Warnings</h2>
    <hr class="amber"/>
    <ul>${data.warnings.map((x) => `<li class="mono">${escapeHtml(x)}</li>`).join("\n")}</ul>
  </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Watch · ${escapeHtml(w.qualifiedName)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${nav}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline">
      <span>Watch · ${escapeHtml(w.qualifiedName)}</span>
      <span class="sep">·</span>
      <span><a href="/watches">← Fleet</a></span>
    </div>
  </header>
  <section class="section">
    <h2>Spec</h2>
    <hr class="amber"/>
    <table class="watch-spec"><tbody>${specRows(data)}</tbody></table>
  </section>
  <section class="section">
    <h2>Prompt as it fires now</h2>
    <hr class="amber"/>
    <h3 class="watch-sub">System prompt</h3>
    ${verbatim(data.systemPrompt)}
    <h3 class="watch-sub">Standing question (the watch file body, verbatim)</h3>
    ${verbatim(w.question)}
    <p class="watch-note">The digest is assembled per tick from ${escapeHtml(w.scope.join(", "))} and appended above the standing question — see any invocation below for the exact text sent.</p>
  </section>
  <section class="section">
    <h2>Invocations</h2>
    <hr class="amber"/>
    ${history}
  </section>
  ${warningsBlock}
</div>
</body>
</html>`;
}

/** Broadsheet 404 for an unknown watch ref. */
export function renderWatchNotFound(ref: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Watch not found</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${renderWatchesNav("/watches")}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline"><span>404 — Not Found</span></div>
  </header>
  <section class="section">
    <hr class="amber"/>
    <p class="error-message">No watch named <code class="mono">${escapeHtml(ref || "(empty)")}</code>.</p>
    <p><a href="/watches">← Back to the fleet</a></p>
  </section>
</div>
</body>
</html>`;
}
