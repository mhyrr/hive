/**
 * Pure render: DashboardData -> single HTML string.
 *
 * No I/O. Tests assert on structural properties of the output.
 *
 * Section renderers are exported individually so the server can produce
 * per-section HTML fragments for optimistic UI updates.
 */

import { marked } from "marked";

import type {
  DashboardData,
  HealthEntry,
  ProjectCard,
  InboxEntry,
  BriefingEntry,
  RunEntry,
  TicketBuckets,
  TicketCitation,
  OpenQuestion,
  RecentMemoryEntry,
  RunUsageSnapshot,
} from "./collect";
import { DASHBOARD_CSS } from "./styles";
import { DASHBOARD_JS } from "./script";
import type { TicketPriority } from "../ticket";

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

export type RenderOptions = {
  /**
   * When `false`, emit a frozen snapshot: no `<script>` block, no
   * action buttons, no interactive affordances. Defaults to `true`
   * (full interactive page, for the `serve` command).
   */
  interactive?: boolean;
};

export type RenderContext = {
  interactive: boolean;
};

function ctx(opts: RenderOptions = {}): RenderContext {
  return { interactive: opts.interactive !== false };
}

// ---------------------------------------------------------------------------
// Helpers (escape + format)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render markdown → HTML. `marked` is fine for our local-only use case. */
function md(source: string): string {
  if (!source || !source.trim()) return "";
  return marked.parse(source, { async: false, breaks: false, gfm: true }) as string;
}

/**
 * Post-process rendered briefing HTML so per-project subsections participate
 * in the project filter. Any `<hN>` whose text matches a known project id is
 * wrapped with everything that follows (up to the next heading of same or
 * higher level) in a `<section data-project="...">`.
 */
function tagProjectSections(html: string, projectIds: string[]): string {
  if (!html || projectIds.length === 0) return html;
  const idSet = new Set(projectIds.map((p) => p.toLowerCase()));
  const tokens = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  const out: string[] = [];
  let wrap: { id: string; level: number; buf: string[] } | null = null;
  const flush = () => {
    if (!wrap) return;
    out.push(`<section class="briefing-project-section" data-project="${wrap.id}">${wrap.buf.join("")}</section>`);
    wrap = null;
  };
  for (const tok of tokens) {
    const hm = tok.match(/^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>$/i);
    if (hm) {
      const level = parseInt(hm[1]!, 10);
      const text = hm[2]!.replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (wrap && level <= wrap.level) flush();
      if (idSet.has(text)) {
        wrap = { id: text, level, buf: [tok] };
      } else if (wrap) {
        wrap.buf.push(tok);
      } else {
        out.push(tok);
      }
    } else if (wrap) {
      wrap.buf.push(tok);
    } else {
      out.push(tok);
    }
  }
  flush();
  return out.join("");
}

function longDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]!;
  const months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  return `${weekday}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function shortDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function weekdayDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[d.getDay()]} · ${months[d.getMonth()]} ${d.getDate()}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m${rem}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
};

/** Emit an inline `[ label ]` action button, only in interactive mode. */
function actionButton(
  c: RenderContext,
  label: string,
  attrs: Record<string, string>,
): string {
  if (!c.interactive) return "";
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
    .join(" ");
  return `<button type="button" class="action" ${attrStr}>[ ${escapeHtml(label)} ]</button>`;
}

// ---------------------------------------------------------------------------
// Section renderers (exported for fragment use)
// ---------------------------------------------------------------------------

export function renderMasthead(data: DashboardData): string {
  const tickerItems = data.health
    .map((h: HealthEntry) => {
      const when = h.mtime ? relativeTime(h.mtime) : "—";
      return `<span class="item"><span class="label">${escapeHtml(h.label)}</span>${escapeHtml(when)}</span>`;
    })
    .join("");

  return `
<header class="masthead">
  <h1>HIVE</h1>
  <div class="dateline">
    <span>${escapeHtml(longDate(data.today))}</span>
    <span class="sep">·</span>
    <span>Vol. ${data.volumeNumber}</span>
    <span class="sep">·</span>
    <span>The Morning Edition</span>
  </div>
</header>
<div class="ticker">${tickerItems}</div>`;
}

/**
 * Sticky top navigation: HIVE label, section jump links, project filter
 * pills, needs-action toggle, and the filter-active banner. Pinned to the
 * viewport top so it stays visible while the reader scrolls through the
 * long-form sections below.
 */
export function renderStickyNav(data: DashboardData, c: RenderContext): string {
  if (!c.interactive) return "";

  const pills = data.projects.length === 0
    ? ""
    : [
        `<button type="button" class="pill pill--active" data-project-filter="ALL">ALL</button>`,
        ...data.projects.map(
          (p) =>
            `<button type="button" class="pill" data-project-filter="${escapeHtml(p.id)}">${escapeHtml(p.id)}</button>`,
        ),
      ].join("");

  const jumpLinks = [
    ["#section-briefing", "Briefing"],
    ["#section-projects", "Projects"],
    ["#section-inboxes", "Inbox"],
    ["#section-tickets", "Tickets"],
    ["#section-runs", "Dispatch"],
    ["#section-archive", "Archive"],
  ]
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join("");

  const filterGroup = pills
    ? `<div class="sticky-filter">
         <div class="pills">${pills}</div>
         <button type="button" class="needs-action-toggle" data-needs-action-toggle aria-pressed="false">[ needs action ]</button>
       </div>`
    : "";

  return `
<nav class="sticky-nav" aria-label="Dashboard navigation">
  <div class="sticky-row">
    <div class="sticky-title">HIVE <span class="sep">·</span> ${escapeHtml(weekdayDate(data.today))}</div>
    <div class="jump-links">${jumpLinks}</div>
    ${filterGroup}
  </div>
  <div id="filter-banner" class="filter-banner" aria-live="polite"></div>
</nav>`;
}

/**
 * Today's Three Things card. Sources in order:
 *   (a) `## Top Three` section in today's briefing
 *   (b) first 3 `-` bullets of the briefing's first `## Priorities` section
 *   (c) first 3 blocked/high-priority tickets
 */
export function renderTopThree(data: DashboardData): string {
  const { items, sourceLabel } = selectTopThree(data);
  if (items.length === 0) return "";

  const body = items
    .map((line) => `<li>${md(line).replace(/^<p>|<\/p>\s*$/g, "")}</li>`)
    .join("");

  return `
<section class="top-three" id="section-top-three">
  <div class="top-three-head">
    <h2>Today&rsquo;s Three Things</h2>
    <span class="kicker">— ${escapeHtml(sourceLabel)}</span>
  </div>
  <ol class="top-three-list">${body}</ol>
</section>`;
}

/** Public for the fragment endpoint and unit testing. */
export function selectTopThree(data: DashboardData): {
  items: string[];
  sourceLabel: string;
} {
  const body = data.todayBriefing?.body ?? "";

  // (a) Explicit ## Top Three section
  const explicit = extractBullets(body, /^##\s+Top\s+Three\s*$/im);
  if (explicit.length > 0) {
    return { items: explicit.slice(0, 3), sourceLabel: "from briefing" };
  }

  // (b) First 3 bullets of the first ## Priorities section
  const priorities = extractBullets(body, /^##\s+Priorities\b.*$/im);
  if (priorities.length > 0) {
    return { items: priorities.slice(0, 3), sourceLabel: "from briefing priorities" };
  }

  // (c) Fallback to blocked + high-priority tickets
  const fallback = [
    ...data.tickets.blocked,
    ...data.tickets.inProgress,
    ...data.tickets.ready,
  ]
    .filter((t) => t.priority <= 1)
    .slice(0, 3)
    .map(
      (t) =>
        `**${t.id}** — ${t.title} _(${t.projectId})_`,
    );
  if (fallback.length === 0) return { items: [], sourceLabel: "" };
  return { items: fallback, sourceLabel: "auto-selected" };
}

function extractBullets(body: string, headingRe: RegExp): string[] {
  const lines = body.split("\n");
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    if (headingRe.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    // Stop at next heading at the same or higher level.
    if (/^#{1,6}\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(.*?)\s*$/);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

export function renderBriefings(data: DashboardData): string {
  if (data.briefings.length === 0) {
    return `
<section class="section" id="section-briefing">
  <div class="section-head"><h2>Today&rsquo;s Briefing</h2><span class="kicker">No briefings on file</span></div>
  <hr class="amber"/>
  <p>Run the morning job to generate a briefing.</p>
</section>`;
  }

  const projectIds = data.projects.map((p) => p.id);
  const articles = data.briefings
    .map((b: BriefingEntry) => {
      const isActive = b.date === data.today;
      return `<article class="briefing-article ${isActive ? "active" : ""}" data-briefing-date="${escapeHtml(b.date)}">
  <div class="briefing">${tagProjectSections(md(b.body), projectIds)}</div>
</article>`;
    })
    .join("\n");

  return `
<section class="section" id="section-briefing">
  <div class="section-head">
    <h2>Today&rsquo;s Briefing</h2>
    <span class="kicker">Dated ${escapeHtml(longDate(data.today))}</span>
  </div>
  <hr class="amber"/>
  <div class="briefing-wrap">
    ${articles}
  </div>
</section>`;
}

/**
 * Projects section: v2 collapsed-by-default per-project `<details>`
 * blocks with one-line summaries. The classic ledger table is kept
 * as a summary view above the expandables.
 */
export function renderProjects(data: DashboardData, c: RenderContext): string {
  const projects = data.projects;
  if (projects.length === 0) return "";

  const summaryRows = projects
    .map((p: ProjectCard) => {
      const p0 = p.ticketCounts.byPriority[0] || 0;
      const p1 = p.ticketCounts.byPriority[1] || 0;
      const p2 = p.ticketCounts.byPriority[2] || 0;
      const p3 = p.ticketCounts.byPriority[3] || 0;
      return `<tr data-project="${escapeHtml(p.id)}">
  <td class="project-name">${escapeHtml(p.id)}</td>
  <td class="path">${escapeHtml(p.path ?? "—")}</td>
  <td class="num">${p.ticketCounts.open}</td>
  <td class="num">${p.ticketCounts.inProgress}</td>
  <td class="num">${p0 + p1}</td>
  <td class="num">${p2 + p3}</td>
  <td class="num">${escapeHtml(relativeTime(p.lastHeartbeat))}</td>
  <td class="num">${p.tickCount}</td>
  <td class="num">${escapeHtml(relativeTime(p.inboxMtime))}</td>
</tr>`;
    })
    .join("\n");

  const details = projects
    .map((p: ProjectCard) => renderProjectDetail(p, c))
    .join("\n");

  return `
<section class="section" id="section-projects">
  <div class="section-head">
    <h2>Projects at a Glance</h2>
    <span class="kicker">${projects.length} Registered</span>
  </div>
  <hr class="amber"/>
  <table class="ledger">
    <thead>
      <tr>
        <th>Project</th>
        <th>Path</th>
        <th class="num">Open</th>
        <th class="num">In&nbsp;Prog.</th>
        <th class="num">P0&ndash;1</th>
        <th class="num">P2&ndash;3</th>
        <th class="num">Heartbeat</th>
        <th class="num">Ticks</th>
        <th class="num">Inbox</th>
      </tr>
    </thead>
    <tbody>
${summaryRows}
    </tbody>
  </table>
  <div class="project-details">
${details}
  </div>
</section>`;
}

function renderProjectDetail(p: ProjectCard, c: RenderContext): string {
  const redFlags: string[] = [];
  if (p.ticketCounts.byPriority[0]) redFlags.push(`${p.ticketCounts.byPriority[0]} P0`);
  if (p.inboxMtime && Date.now() - new Date(p.inboxMtime).getTime() > 72 * 3600 * 1000) {
    redFlags.push("stale inbox");
  }
  const warn = redFlags.length > 0 ? ` · <span class="warn">${escapeHtml(redFlags.join(" · "))}</span>` : "";
  const ticketTotal = p.ticketCounts.open + p.ticketCounts.inProgress;
  const oneLine = `
    <span class="project-name">${escapeHtml(p.id)}</span>
    · ${ticketTotal} ticket${ticketTotal === 1 ? "" : "s"}
    · heartbeat ${escapeHtml(relativeTime(p.lastHeartbeat))}${warn}
  `.trim();
  const filterButton = actionButton(c, "filter", {
    "data-project-filter-shortcut": p.id,
  });

  return `<details class="per-project-section" data-project="${escapeHtml(p.id)}">
  <summary>${oneLine} ${filterButton}</summary>
  <div class="project-body">
    <dl class="project-kv">
      <dt>Path</dt><dd class="mono">${escapeHtml(p.path ?? "—")}</dd>
      <dt>Open</dt><dd>${p.ticketCounts.open}</dd>
      <dt>In progress</dt><dd>${p.ticketCounts.inProgress}</dd>
      <dt>P0–1</dt><dd>${(p.ticketCounts.byPriority[0] || 0) + (p.ticketCounts.byPriority[1] || 0)}</dd>
      <dt>P2–3</dt><dd>${(p.ticketCounts.byPriority[2] || 0) + (p.ticketCounts.byPriority[3] || 0)}</dd>
      <dt>Ticks</dt><dd>${p.tickCount}</dd>
      <dt>Last result</dt><dd>${escapeHtml(p.lastResult ?? "—")}</dd>
    </dl>
  </div>
</details>`;
}

export function renderInboxes(inboxes: InboxEntry[], c: RenderContext): string {
  if (inboxes.length === 0) return "";

  const entries = inboxes
    .map((entry: InboxEntry, idx: number) => {
      const bodyId = `inbox-body-${idx}`;
      const toggleId = `inbox-toggle-${idx}`;
      const projectId = escapeHtml(entry.projectId);
      if (entry.isEmpty) {
        return `<div class="inbox-entry empty" data-project="${projectId}">
  <div class="head"><span class="project">${projectId}</span><span class="mtime">quiet</span></div>
  <div class="body">No dispatches on file.</div>
</div>`;
      }
      const when = entry.mtime ? relativeTime(entry.mtime) : "—";
      const actions = c.interactive
        ? `<div class="row-actions">
            ${actionButton(c, "promote", { "data-action": "inbox-promote", "data-project": entry.projectId })}
            ${actionButton(c, "dispatch", { "data-action": "inbox-dispatch", "data-project": entry.projectId })}
            ${actionButton(c, "ack", { "data-action": "inbox-ack", "data-project": entry.projectId, "data-confirm": "true" })}
          </div>`
        : "";
      return `<div class="inbox-entry" data-project="${projectId}">
  <div class="head">
    <span class="project">${projectId}
      <span id="${toggleId}" class="toggle" data-toggle="${bodyId}" data-show="Show" data-hide="Hide">Hide</span>
    </span>
    <span class="mtime">${escapeHtml(when)}</span>
  </div>
  <div class="body" id="${bodyId}" data-inbox-body>${md(entry.body)}</div>
  ${actions}
</div>`;
    })
    .join("\n");

  return `
<section class="section" id="section-inboxes">
  <div class="section-head">
    <h2>The Inbox</h2>
    <span class="kicker">Per-project dispatches</span>
  </div>
  <hr class="amber"/>
  <div class="inbox-grid">
${entries}
  </div>
</section>`;
}

function renderTicketRow(t: TicketCitation, c: RenderContext): string {
  const priority = PRIORITY_LABELS[t.priority] ?? "P?";
  const tags = t.tags.length > 0 ? ` · ${t.tags.join(" · ")}` : "";
  const deps = t.depends.length > 0
    ? `<div class="deps">depends on ${t.depends.map((d) => escapeHtml(d)).join(", ")}</div>`
    : "";
  const actions = c.interactive
    ? `<div class="row-actions">
        ${actionButton(c, "start", { "data-action": "ticket-start", "data-id": t.id, "data-project": t.projectId })}
        ${actionButton(c, "dispatch", { "data-action": "ticket-dispatch-run", "data-id": t.id, "data-project": t.projectId })}
        ${actionButton(c, "note", { "data-action": "ticket-note", "data-id": t.id, "data-project": t.projectId })}
        ${actionButton(c, "close", { "data-action": "ticket-close", "data-id": t.id, "data-project": t.projectId, "data-confirm": "true" })}
      </div>`
    : "";
  return `<div class="ticket-row" data-project="${escapeHtml(t.projectId)}" data-ticket-id="${escapeHtml(t.id)}">
  <div>
    <span class="id">${escapeHtml(t.projectId)}/${escapeHtml(t.id)}</span>
    <span class="title">${escapeHtml(t.title)}</span>
  </div>
  <div class="meta">
    <span class="prio-${priority}">${priority}</span>
    · ${t.ageDays}d old${escapeHtml(tags)}
  </div>
  ${deps}
  ${actions}
</div>`;
}

export function renderTickets(buckets: TicketBuckets, c: RenderContext): string {
  const total = buckets.ready.length + buckets.inProgress.length + buckets.blocked.length;
  if (total === 0) {
    return `
<section class="section" id="section-tickets">
  <div class="section-head"><h2>Tickets</h2><span class="kicker">None open</span></div>
  <hr class="amber"/>
  <p>Clean desk.</p>
</section>`;
  }

  const renderGroup = (label: string, kind: "ready" | "progress" | "blocked", items: TicketCitation[]): string => {
    if (items.length === 0) {
      return `<div class="ticket-group">
  <h3>${escapeHtml(label)}</h3>
  <div class="ticket-row" style="color: var(--muted); font-style: italic;">None.</div>
</div>`;
    }
    const rows = items.map((t) => renderTicketRow(t, c)).join("\n");
    return `<div class="ticket-group">
  <h3>${escapeHtml(label)} <span class="status-tag ${kind}">${items.length}</span></h3>
${rows}
</div>`;
  };

  return `
<section class="section" id="section-tickets">
  <div class="section-head">
    <h2>Tickets</h2>
    <span class="kicker">${total} Active across all projects</span>
  </div>
  <hr class="amber"/>
  <div class="ticket-groups">
    ${renderGroup("In Progress", "progress", buckets.inProgress)}
    ${renderGroup("Ready", "ready", buckets.ready)}
    ${renderGroup("Blocked", "blocked", buckets.blocked)}
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// V1 cross-cutting widgets — Group 7 of the memory redesign.
// ---------------------------------------------------------------------------

export function renderOpenQuestions(questions: OpenQuestion[] | undefined): string {
  if (!questions || questions.length === 0) {
    return `
<section class="section" id="section-open-questions">
  <div class="section-head"><h2>Open Questions</h2><span class="kicker">None</span></div>
  <hr class="amber"/>
  <p>No open questions across projects.</p>
</section>`;
  }
  // Group by project for readable scanning.
  const byProject = new Map<string, OpenQuestion[]>();
  for (const q of questions) {
    if (!byProject.has(q.projectId)) byProject.set(q.projectId, []);
    byProject.get(q.projectId)!.push(q);
  }
  const blocks = [...byProject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([projectId, items]) => {
      const rows = items
        .map((q) => {
          const tagSpan = q.tags.length > 0
            ? ` <span class="tag-list">${q.tags.map((t) => `<code>${escapeHtml(t)}</code>`).join(" ")}</span>`
            : "";
          return `<li>${escapeHtml(q.text)}${tagSpan}</li>`;
        })
        .join("\n");
      return `<div class="project-block" data-project="${escapeHtml(projectId)}">
  <h3>${escapeHtml(projectId)} <span class="status-tag ready">${items.length}</span></h3>
  <ul class="bare">${rows}</ul>
</div>`;
    })
    .join("\n");

  return `
<section class="section" id="section-open-questions">
  <div class="section-head">
    <h2>Open Questions</h2>
    <span class="kicker">${questions.length} across ${byProject.size} project${byProject.size === 1 ? "" : "s"}</span>
  </div>
  <hr class="amber"/>
  <div class="open-questions">
${blocks}
  </div>
</section>`;
}

export function renderRecentMemory(entries: RecentMemoryEntry[] | undefined): string {
  if (!entries || entries.length === 0) {
    return `
<section class="section" id="section-recent-memory">
  <div class="section-head"><h2>Recent Memory</h2><span class="kicker">Quiet week</span></div>
  <hr class="amber"/>
  <p>No memory activity in the last 7 days.</p>
</section>`;
  }
  const rows = entries
    .map((e) => {
      const tagSpan = e.tags.length > 0
        ? ` <span class="tag-list">${e.tags.map((t) => `<code>${escapeHtml(t)}</code>`).join(" ")}</span>`
        : "";
      const recentLabel = e.lastRecalled ? `recalled ${e.lastRecalled}` : `created ${e.createdAt}`;
      return `<li class="memory-row" data-project="${escapeHtml(e.projectId)}">
  <span class="meta"><strong>${escapeHtml(e.projectId)}</strong> · ${escapeHtml(e.section)} · str ${e.strength.toFixed(2)} · ${escapeHtml(recentLabel)}</span>
  <span class="text">${escapeHtml(e.text)}${tagSpan}</span>
</li>`;
    })
    .join("\n");

  return `
<section class="section" id="section-recent-memory">
  <div class="section-head">
    <h2>Recent Memory</h2>
    <span class="kicker">${entries.length} entries · last 7 days, by strength</span>
  </div>
  <hr class="amber"/>
  <ul class="memory-list">
${rows}
  </ul>
</section>`;
}

export function renderRunUsage(usage: RunUsageSnapshot | undefined): string {
  if (!usage || !usage.available) {
    const date = usage?.date ?? new Date().toISOString().slice(0, 10);
    return `
<section class="section" id="section-run-usage">
  <div class="section-head"><h2>Run cost</h2><span class="kicker">${escapeHtml(date)}</span></div>
  <hr class="amber"/>
  <p>No nightly run on file for ${escapeHtml(date)}.</p>
</section>`;
  }
  const rows = usage.passes
    .map((p) => {
      const projectLabel = p.project ? ` · ${escapeHtml(p.project)}` : "";
      const duration = p.durationMs ? `${(p.durationMs / 1000).toFixed(1)}s` : "—";
      return `<tr>
  <td><strong>Pass ${escapeHtml(p.pass)}</strong>${projectLabel}</td>
  <td>${escapeHtml(p.model)}</td>
  <td class="num">${p.inputTokens.toLocaleString()}</td>
  <td class="num">${p.outputTokens.toLocaleString()}</td>
  <td class="num">${duration}</td>
  <td class="num"><strong>${escapeHtml(p.usdFormatted)}</strong></td>
</tr>`;
    })
    .join("\n");

  return `
<section class="section" id="section-run-usage">
  <div class="section-head">
    <h2>Run cost</h2>
    <span class="kicker">${escapeHtml(usage.date)} · ${usage.passes.length} pass${usage.passes.length === 1 ? "" : "es"}</span>
  </div>
  <hr class="amber"/>
  <div class="run-usage">
    <p class="run-usage-total">
      <strong>${escapeHtml(usage.totalUsdFormatted)}</strong>
      &nbsp;·&nbsp; ${usage.totalInputTokens.toLocaleString()} input + ${usage.totalOutputTokens.toLocaleString()} output tokens
    </p>
    <table class="run-usage-table">
      <thead>
        <tr><th>Pass</th><th>Model</th><th>In</th><th>Out</th><th>Time</th><th>Cost</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

export function renderRuns(runs: RunEntry[], c: RenderContext): string {
  if (runs.length === 0) return "";

  const rows = runs
    .map((r: RunEntry) => {
      const statusClass = `status-${(r.status || "unknown").toLowerCase()}`;
      const ticketCell = r.ticketId ? escapeHtml(r.ticketId) : "—";
      const projectAttr = r.projectId ? `data-project="${escapeHtml(r.projectId)}"` : "";
      const actions = c.interactive
        ? `<div class="row-actions">
            ${r.status === "running" ? actionButton(c, "kill", { "data-action": "dispatch-kill", "data-run-id": r.id, "data-confirm": "true" }) : ""}
            ${actionButton(c, "override", { "data-action": "dispatch-override", "data-run-id": r.id, "data-confirm": "true" })}
          </div>`
        : "";
      return `<li class="dispatch-row" ${projectAttr} data-run-id="${escapeHtml(r.id)}">
  <span class="id">${escapeHtml(r.id)}</span>
  <span class="status ${statusClass}">${escapeHtml(r.status)}</span>
  <span class="duration">${escapeHtml(formatDuration(r.durationMs))}</span>
  <span class="goal">${escapeHtml(r.goalSnippet || "—")}</span>
  <span class="ticket">${ticketCell}</span>
  ${actions}
</li>`;
    })
    .join("\n");

  return `
<section class="section" id="section-runs">
  <div class="section-head">
    <h2>Dispatch Log</h2>
    <span class="kicker">${runs.length} Most recent</span>
  </div>
  <hr class="amber"/>
  <ul class="dispatch-list">
${rows}
  </ul>
</section>`;
}

export function renderArchive(data: DashboardData, c: RenderContext): string {
  if (data.briefings.length === 0) return "";

  const limit = 30;
  const cards = data.briefings
    .slice(0, limit)
    .map((b: BriefingEntry) => {
      const isActive = b.date === data.today;
      const href = c.interactive ? `/archive/${escapeHtml(b.date)}` : "#";
      const target = c.interactive ? ` target="_blank"` : "";
      return `<a class="archive-card ${isActive ? "active" : ""}" href="${href}"${target} data-archive-card="${escapeHtml(b.date)}">
  <div class="date">${escapeHtml(weekdayDate(b.date))}</div>
  <div class="head">${escapeHtml(b.headline)}</div>
</a>`;
    })
    .join("\n");

  return `
<section class="section" id="section-archive">
  <div class="section-head">
    <h2>The Archive</h2>
    <span class="kicker">Past ${Math.min(limit, data.briefings.length)} days · click a date to load</span>
  </div>
  <hr class="amber"/>
  <div class="archive">
${cards}
  </div>
</section>`;
}

export function renderFooter(data: DashboardData): string {
  return `
<footer class="footer">
  Generated ${escapeHtml(new Date(data.generatedAt).toLocaleString())}
  · ${new URL("https://github.com/anthropics").host ? "" : ""}Single-file · No network
</footer>`;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function renderDashboard(data: DashboardData, opts: RenderOptions = {}): string {
  const c = ctx(opts);

  const body = [
    renderStickyNav(data, c),
    renderMasthead(data),
    `<main class="page">`,
    renderTopThree(data),
    renderBriefings(data),
    renderProjects(data, c),
    renderInboxes(data.inboxes, c),
    renderTickets(data.tickets, c),
    renderOpenQuestions(data.openQuestions),
    renderRecentMemory(data.recentMemory),
    renderRunUsage(data.runUsage),
    renderRuns(data.runs, c),
    renderArchive(data, c),
    renderFooter(data),
    c.interactive ? `<div class="snackbar" id="snackbar" role="status" aria-live="polite"></div>` : "",
    `</main>`,
  ].join("\n");

  const scriptBlock = c.interactive ? `<script>${DASHBOARD_JS}</script>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="generator" content="hive dashboard"/>
<title>HIVE · The Morning Edition · ${escapeHtml(shortDate(data.today))}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
${body}
${scriptBlock}
</body>
</html>`;
}
