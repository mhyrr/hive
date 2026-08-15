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
  ProposeEntry,
  BriefingEntry,
  RunEntry,
  TicketBuckets,
  TicketCitation,
  OpenQuestion,
  RecentMemoryEntry,
  ReflectionDay,
  RunUsageSnapshot,
  TasteTrackSnapshot,
  TastePageData,
  TasteCategoryGroup,
  TastePageUnit,
  TastePrinciple,
  TicketsPageData,
  EpicBoard,
} from "./collect";
import { DASHBOARD_CSS } from "./styles";
import { DASHBOARD_JS } from "./script";
import { renderPageNav } from "./html";
import { assignVerdicts, colourFor, needsAttention, sortYard, type Colony } from "./colony";
import type { ProjectActivity } from "./activity";
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
  const canonical = canonicalIds(projectIds);
  const tokens = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  const out: { project: boolean; html: string }[] = [];
  let wrap: { id: string; level: number; buf: string[] } | null = null;
  const flush = () => {
    if (!wrap) return;
    out.push({
      project: true,
      html: `<section class="briefing-project-section" data-project="${escapeHtml(wrap.id)}">${wrap.buf.join("")}</section>`,
    });
    wrap = null;
  };
  for (const tok of tokens) {
    const hm = tok.match(/^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>$/i);
    if (hm) {
      const level = parseInt(hm[1]!, 10);
      const text = hm[2]!.replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (wrap && level <= wrap.level) flush();
      const id = canonical.get(text);
      if (id) {
        wrap = { id, level, buf: [tok] };
      } else if (wrap) {
        wrap.buf.push(tok);
      } else {
        out.push({ project: false, html: tok });
      }
    } else if (wrap) {
      wrap.buf.push(tok);
    } else {
      out.push({ project: false, html: tok });
    }
  }
  flush();

  // A run of adjacent project sections is one thing — the night, colony by
  // colony — so it gets one container to flow through. Without it each block
  // is an independent grid cell and the shortest colony leaves a hole the
  // height of the longest.
  const parts: string[] = [];
  let run: string[] = [];
  const closeRun = () => {
    if (run.length === 0) return;
    parts.push(`<div class="briefing-colonies">${run.join("")}</div>`);
    run = [];
  };
  for (const node of out) {
    // Whitespace between two sections is not a section break — marked leaves
    // an empty chunk between adjacent headings and it must not split the run.
    if (node.project || (run.length > 0 && node.html.trim() === "")) {
      run.push(node.html);
      continue;
    }
    closeRun();
    parts.push(node.html);
  }
  closeRun();
  return parts.join("");
}

/** Lowercased project id → the id as registered, for case-tolerant matching. */
function canonicalIds(projectIds: string[]): Map<string, string> {
  return new Map(projectIds.map((p) => [p.toLowerCase(), p]));
}

/**
 * The briefing's flat lists are project-keyed too, just in prose rather than
 * headings: "What needs your attention" and the verifier flags each lead a
 * bullet with a bolded project — `**revrec — fabricated testimonials**` or
 * `**dobby** — Sonnet's extraction`. Tag those `<li>`s so the filter reaches
 * the two sections that most often say why a colony needs you.
 *
 * Deliberately narrow: only a `<li>` opening with `<strong>` is considered,
 * and only the leading token before a dash or colon is matched. A bullet that
 * merely mentions a project mid-sentence stays untagged — a filter that
 * guesses is worse than one that visibly covers less.
 */
function tagProjectBullets(html: string, projectIds: string[]): string {
  if (!html || projectIds.length === 0) return html;
  const canonical = canonicalIds(projectIds);
  return html.replace(
    /<li>(\s*)<strong>([^<]{1,120})<\/strong>/g,
    (whole: string, space: string, bold: string) => {
      const lead = bold.split(/[—–:-]/)[0]!.trim().toLowerCase();
      const id = canonical.get(lead);
      if (!id) return whole;
      return `<li data-project="${escapeHtml(id)}">${space}<strong>${bold}</strong>`;
    },
  );
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

const VERDICT_LABEL: Record<Colony["verdict"], string> = {
  "needs-you": "Needs you",
  queenless: "Queenless",
  active: "Active",
  waiting: "Waiting",
  quiet: "Quiet",
};

/**
 * The yard: every colony standing on one baseline at the height its stores
 * earn it, each carrying tonight's verdict. This is the first viewport and
 * it answers one question — which colonies need you today.
 */
export function renderYard(data: DashboardData): string {
  const colonies = sortYard(assignVerdicts(data));
  const attention = needsAttention(colonies);
  const peakBrood = Math.max(1, ...colonies.map((c) => c.brood));
  const cardById = new Map(data.projects.map((p) => [p.id, p]));

  // The work band is about what actually landed, so a project that is only
  // live on the month scale scores in the yard but earns no row here.
  const worked = (data.activity ?? []).filter((a) => a.commits > 0);

  // The largest sentence on the page answers the question the reader came
  // with. It used to count commits, which is activity, not a verdict — the
  // number that actually decides the morning was set at 10.5px in the yard
  // label. Scale follows how load-bearing a sentence is, not where it sits.
  const call = colonies.length === 0
    ? `<p class="quiet">No colonies in the yard.</p>`
    : attention.length === 0
      ? `<p class="quiet">All ${colonies.length} colonies are quiet.</p>`
      : `<p><span class="count">${attention.length}</span> of ${colonies.length} ${
          colonies.length === 1 ? "colony needs" : "colonies need"
        } you today.</p>`;

  const workedLine = worked.length === 0
    ? "nothing landed in the last two days"
    : `${worked.length} ${worked.length === 1 ? "colony" : "colonies"} &middot; last two days`;

  const hives = colonies
    .map((c, i) => {
      // Supers above the brood chamber grow with stores, on the yard's
      // shared scale — a taller hive is a stronger one, not a styled one.
      const supers = 1 + Math.round(c.stores * 4);
      const boxes = Array.from({ length: supers }, () => `<div class="super"></div>`).join("");
      const traffic = (c.brood / peakBrood).toFixed(3);

      return `
    <li>
      <button type="button" class="colony colony--${c.verdict}" data-colour="${c.colour}"
              data-project="${escapeHtml(c.id)}" style="--i:${i}"
              aria-label="${escapeHtml(c.id)}: ${escapeHtml(VERDICT_LABEL[c.verdict])}, ${escapeHtml(c.reason)}">
        <div class="colony-name">${escapeHtml(c.id)}</div>
        <div class="colony-stack" style="--traffic:${traffic}">
          ${boxes}
          <div class="super super--brood"></div>
        </div>
        <div class="colony-board"></div>
        <div class="colony-plate">
          <div class="colony-verdict">${escapeHtml(VERDICT_LABEL[c.verdict])}</div>
          <div class="colony-reason">${escapeHtml(c.reason)}</div>
          <div class="colony-figures">
            <span>tickets <b>${c.brood}</b></span>
            <span>memory <b>${c.entries.toLocaleString("en-US")}</b></span>
          </div>
        </div>
      </button>
    </li>`;
    })
    .join("");

  const body =
    colonies.length === 0
      ? `<p class="yard-empty">No colonies registered. <code>hive project add</code> puts one in the yard.</p>`
      : `<ol class="yard-row">${hives}</ol>`;

  return `
<header class="yard-head">
  <h1>Hive</h1>
  <div class="dateline">
    <span>${escapeHtml(longDate(data.today))}</span>
    <span>Inspection ${data.volumeNumber}</span>
  </div>
</header>
<div class="yard-call">${call}</div>
<section class="yard" id="section-yard" aria-labelledby="yard-label">
  <div class="yard-label">
    <h2 id="yard-label">The yard</h2>
    <span class="yard-key">painted &middot; needs you &nbsp; taller &middot; more memory</span>
  </div>
  ${body}
</section>
${renderWork(worked, workedLine)}`;
}

/** How many commit subjects a colony shows before it folds the rest away. */
const SUBJECT_CAP = 5;

/**
 * What got done. Commit subjects as written — they are the only windowed
 * record of work HIVE actually holds, and a subject someone wrote by hand
 * says more than a count of closed tickets.
 */
export function renderWork(activity: ProjectActivity[], aside = ""): string {
  if (activity.length === 0) {
    return `<section class="work"><p class="work-none">No commits in the window. Either a quiet stretch or the repos moved somewhere HIVE is not looking.</p></section>`;
  }

  const items = activity
    .map((a) => {
      const shown = a.subjects.slice(0, SUBJECT_CAP);
      const rest = a.subjects.length - shown.length;
      const lines = shown.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      const more = rest > 0 ? `<li class="more">+${rest} more</li>` : "";

      return `
    <li class="work-item" data-colour="${colourFor(a.projectId)}" data-project="${escapeHtml(a.projectId)}">
      <div class="work-name">${escapeHtml(a.projectId)}</div>
      <div class="work-figures">
        ${a.commits} ${a.commits === 1 ? "commit" : "commits"}
        &middot; <span class="add">+${a.insertions.toLocaleString("en-US")}</span>
        <span class="cut">&minus;${a.deletions.toLocaleString("en-US")}</span>
        &middot; ${a.filesChanged} ${a.filesChanged === 1 ? "file" : "files"}
      </div>
      <ul class="work-subjects">${lines}${more}</ul>
    </li>`;
    })
    .join("");

  // The commit count moved here from the page's largest sentence. It belongs
  // to this band — it says how much landed, not whether anything wants you.
  return `
<section class="work" id="section-work" aria-labelledby="work-label">
  <div class="yard-label">
    <h2 id="work-label">Work</h2>
    ${aside ? `<span class="yard-key">${aside}</span>` : ""}
  </div>
  <ol class="work-list">${items}</ol>
</section>`;
}

/**
 * Upkeep: the launchd jobs that keep the apiary running.
 *
 * Demoted on purpose — it is rarely actionable and never leads. But it is
 * real state, and dropping the old masthead ticker would have taken it off
 * the page entirely.
 */
export function renderUpkeep(data: DashboardData): string {
  const health = data.health ?? [];
  if (health.length === 0) return "";

  const jobs = health
    .map((h) => {
      const when = h.mtime ? relativeTime(h.mtime) : "never";
      return `<li><span class="job">${escapeHtml(h.label)}</span><span class="when">${escapeHtml(when)}</span></li>`;
    })
    .join("");

  const usage = data.runUsage;
  const cost =
    usage?.available && usage.totalUsd > 0
      ? `<li><span class="job">Last night</span><span class="when">${escapeHtml(usage.totalUsdFormatted)}</span></li>`
      : "";

  // The full taste surface stays at /taste; this is only a pointer, and only
  // when there is something waiting.
  const pending = data.tasteTrack?.reviewEligible ?? 0;
  const taste = pending > 0
    ? `<li><span class="job">Taste queue</span><span class="when"><a href="/taste">${pending} waiting</a></span></li>`
    : "";

  return `
<section class="upkeep" id="section-upkeep" aria-labelledby="upkeep-label">
  <div class="yard-label"><h2 id="upkeep-label">Upkeep</h2></div>
  <ul class="upkeep-list">${jobs}${cost}${taste}</ul>
</section>`;
}

/**
 * Section shell: one heading language for every band below the yard.
 * `aside` is author-written markup, never user content — callers escape
 * anything interpolated into it themselves.
 *
 * The title is a real `h2` carrying the section's accessible name. It was a
 * span in a div, which looked identical and left six major sections with no
 * heading and no name — the page's only real headings came from briefing
 * markdown, at 14px, below body size.
 */
function band(id: string, title: string, aside: string, body: string): string {
  return `
<section class="band" id="section-${id}" aria-labelledby="${id}-label">
  <div class="yard-label">
    <h2 id="${id}-label">${escapeHtml(title)}</h2>
    ${aside ? `<span class="yard-key">${aside}</span>` : ""}
  </div>
  ${body}
</section>`;
}

/**
 * The briefing, condensed: the headline carries it, the body reads beneath.
 * It no longer leads the page — prose cannot be scanned, and the yard
 * answers "what needs me" faster than a paragraph can.
 *
 * The body is one grid, not one column. The briefing's own shape is a lede
 * plus a per-project block per colony, so the per-project blocks sit side by
 * side on the same track the work band and the ticket shortlist already use,
 * and the cross-project prose spans. A single 72ch column inside a 1280px
 * page left half the band empty and pushed "what needs your attention" three
 * thousand pixels down.
 *
 * Tagging is the same pass in two shapes — project headings become sections,
 * project-led bullets become tagged rows — so the filter reaches the text and
 * not just the tables.
 */
export function renderBriefingBand(data: DashboardData): string {
  const b = data.todayBriefing;
  if (!b) return "";
  // Drop the artifact's own H1 (the band already carries the date) and the
  // "## Headline" label above the lede. The label is an eyebrow over a
  // heading — the sentence beneath it is self-evidently the headline, and
  // naming it costs a line and says nothing. The briefing template still
  // writes it because the section names are how the generator is steered;
  // stripping it here keeps that contract intact and the page clean.
  const body = b.body
    .replace(/^#\s+.*\n?/, "")
    .replace(/^\s*##\s+headline\s*\n/i, "")
    .trim();
  const projectIds = data.projects.map((p) => p.id);
  const html = tagProjectBullets(tagProjectSections(md(body), projectIds), projectIds);
  return band(
    "briefing",
    "Briefing",
    escapeHtml(longDate(b.date)),
    `<div class="briefing-body">${html}</div>`,
  );
}

/**
 * Watches, inline. The full control surface lives on /watches; this is what
 * each watch last actually said, which is the part worth a morning read.
 */
export function renderWatchesBand(w: DashboardData["watches"]): string {
  if (!w || w.rows.length === 0) return "";

  const spoke = (w.latest ?? []).filter((c) => !c.quiet && !c.dropped && c.output);
  const aside = w.tickStale ? "tick stale" : `${w.rows.length} watching`; // author text

  if (spoke.length === 0) {
    return band("watches", "Watches", aside, `<p class="band-none">Every watch chose silence.</p>`);
  }

  const cards = spoke
    .map((c) => {
      // A watch is qualified `project/name` when it is scoped to one colony,
      // and bare when it reasons across the whole apiary. Only the scoped ones
      // belong to the project filter; the fleet's standing questions are not
      // any single project's, and hiding them would be a lie.
      const scope = c.watch.includes("/") ? c.watch.slice(0, c.watch.indexOf("/")) : null;
      const projectAttr = scope ? ` data-project="${escapeHtml(scope)}"` : "";
      return `
    <li class="watch-card"${projectAttr}>
      <div class="watch-head">
        <span class="watch-name">${escapeHtml(c.watch)}</span>
        <span class="watch-when">${escapeHtml(relativeTime(c.at))}</span>
      </div>
      <div class="prose">${md(c.output ?? "")}</div>
    </li>`;
    })
    .join("");

  return band("watches", "Watches", aside, `<ol class="watch-list">${cards}</ol>`);
}

/**
 * Stores: everything HIVE knows, in one place.
 *
 * Replaces three separate sections — recent memory, open questions, and
 * promotion candidates — that were three views of one store and read as
 * three unrelated tables.
 */
export function renderStores(data: DashboardData): string {
  const recent = (data.recentMemory ?? []).slice(0, 12);
  const questions = (data.openQuestions ?? []).slice(0, 8);
  const candidates = data.promotionCandidates ?? [];

  if (recent.length === 0 && questions.length === 0 && candidates.length === 0) return "";

  const total = (data.memoryStats ?? []).reduce((a, s) => a + s.total, 0);

  const admitted = recent.length === 0 ? "" : `
    <div class="stores-col">
      <h3>Lately admitted</h3>
      <ul class="entry-list">${recent
        .map(
          (e) => `<li data-project="${escapeHtml(e.projectId)}">
            <span class="entry-meta">${escapeHtml(e.projectId)} &middot; ${escapeHtml(e.section)}</span>
            <span class="entry-text">${escapeHtml(e.text)}</span>
          </li>`,
        )
        .join("")}</ul>
    </div>`;

  const asked = questions.length === 0 ? "" : `
    <div class="stores-col">
      <h3>Still open</h3>
      <ul class="entry-list">${questions
        .map(
          (q) => `<li data-project="${escapeHtml(q.projectId)}">
            <span class="entry-meta">${escapeHtml(q.projectId)}</span>
            <span class="entry-text">${escapeHtml(q.text)}</span>
          </li>`,
        )
        .join("")}</ul>
    </div>`;

  const ready = candidates.length === 0 ? "" : `
    <div class="stores-col">
      <h3>Ready to promote</h3>
      <ul class="entry-list">${candidates
        .slice(0, 6)
        .map(
          (c) => `<li data-project="${escapeHtml(c.projectId)}">
            <span class="entry-meta">${escapeHtml(c.projectId)} &middot; recalled ${c.recallCount}&times;</span>
            <span class="entry-text">${escapeHtml(c.text)}</span>
          </li>`,
        )
        .join("")}</ul>
    </div>`;

  return band(
    "stores",
    "Stores",
    `${total.toLocaleString("en-US")} entries`,
    `<div class="stores">${admitted}${asked}${ready}</div>`,
  );
}

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

  // Anchors for the sections this page actually renders — and only those. The
  // condense pass cut projects, inbox, reflections and dispatch off the page
  // but left their links here, so five of seven jumps landed nowhere. Each
  // band renders conditionally, so each link asks the same question the band
  // does. Pages follow the sections, after a separator, named for where they
  // go rather than for the band they duplicate.
  const hasStores =
    (data.recentMemory ?? []).length > 0 ||
    (data.openQuestions ?? []).length > 0 ||
    (data.promotionCandidates ?? []).length > 0;
  const sections: [boolean, string, string][] = [
    [true, "#section-yard", "Yard"],
    [(data.activity ?? []).some((a) => a.commits > 0), "#section-work", "Work"],
    [!!data.todayBriefing, "#section-briefing", "Briefing"],
    [(data.watches?.rows.length ?? 0) > 0, "#section-watches", "Watches"],
    [true, "#section-tickets", "Tickets"],
    [hasStores, "#section-stores", "Stores"],
    [data.briefings.length > 0, "#section-archive", "Archive"],
  ];
  const pages: [string, string][] = [
    ["/tickets", "Full board"],
    ["/taste", "Taste"],
    ["/watches", "All watches"],
  ];
  const anchor = ([href, label]: [string, string]) => `<a href="${href}">${label}</a>`;
  const jumpLinks = [
    ...sections.filter(([shown]) => shown).map(([, href, label]) => anchor([href, label])),
    `<span class="nav-sep">&middot;</span>`,
    ...pages.map(anchor),
  ].join("");

  const filterGroup = pills
    ? `<div class="sticky-filter">
         <div class="pills">${pills}</div>
         <button type="button" class="needs-action-toggle" data-needs-action-toggle aria-pressed="false">[ needs action ]</button>
       </div>`
    : "";

  // Two rows so both groups scale: sections wrap horizontally beside the
  // title; the project filter gets its own full-width row. A single flex row
  // starves whichever group is smaller once projects and sections multiply.
  return `
<nav class="sticky-nav" aria-label="Dashboard navigation">
  <div class="sticky-row">
    <div class="sticky-title">HIVE <span class="sep">·</span> ${escapeHtml(weekdayDate(data.today))}</div>
    <div class="jump-links">${jumpLinks}</div>
  </div>
  ${filterGroup ? `<div class="sticky-row sticky-row--filter">${filterGroup}</div>` : ""}
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

/** Latest Propose output beside the morning briefing. Quiet nights omit it. */
export function renderPropose(propose: ProposeEntry | null | undefined): string {
  if (!propose) return "";
  return `<section class="section" id="section-propose">
  <div class="section-head"><h2>Propose</h2><span class="kicker">${escapeHtml(propose.date)} · nightly propose cycle · <a href="/watches">fleet →</a></span></div>
  <hr class="amber"/>
  <div class="briefing">${md(propose.body)}</div>
</section>`;
}

export function renderProjects(data: DashboardData, _c: RenderContext): string {
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
</section>`;
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
            ${actionButton(c, "make ticket", { "data-action": "inbox-promote", "data-project": entry.projectId })}
            ${actionButton(c, "dismiss", { "data-action": "inbox-ack", "data-project": entry.projectId, "data-confirm": "true" })}
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
        ${actionButton(c, "add note", { "data-action": "ticket-note", "data-id": t.id, "data-project": t.projectId })}
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

/** Per project, on the main page. The full board lives at /tickets. */
const TICKETS_PER_PROJECT = 5;

/** State first, then priority, then how recently anyone touched it. */
function ticketWeight(t: TicketCitation, state: number): number[] {
  return [state, t.priority, t.updatedDays ?? Number.POSITIVE_INFINITY];
}

/**
 * Tickets, capped.
 *
 * The old band rendered every open ticket across every project — 164 rows
 * on this machine, which is a listing, not a briefing. Each colony shows the
 * few that would actually be picked up next; the whole board is one click
 * away and does not need reprinting here.
 */
export function renderTickets(buckets: TicketBuckets, c: RenderContext): string {
  const tagged = [
    ...buckets.inProgress.map((t) => ({ t, state: 0, kind: "progress" as const })),
    ...buckets.ready.map((t) => ({ t, state: 1, kind: "ready" as const })),
    ...buckets.blocked.map((t) => ({ t, state: 2, kind: "blocked" as const })),
  ];
  const total = tagged.length;

  if (total === 0) {
    return band("tickets", "Tickets", "none open", `<p class="band-none">Clean desk.</p>`);
  }

  const byProject = new Map<string, typeof tagged>();
  for (const row of tagged) {
    const list = byProject.get(row.t.projectId) ?? [];
    list.push(row);
    byProject.set(row.t.projectId, list);
  }

  // Busiest queue first — the same instinct the yard sorts on.
  const projects = [...byProject.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const columns = projects
    .map(([projectId, rows]) => {
      const sorted = [...rows].sort((a, b) => {
        const wa = ticketWeight(a.t, a.state);
        const wb = ticketWeight(b.t, b.state);
        for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return wa[i] - wb[i];
        return a.t.id.localeCompare(b.t.id);
      });
      const shown = sorted.slice(0, TICKETS_PER_PROJECT);
      const rest = sorted.length - shown.length;

      const items = shown
        .map(
          ({ t, kind }) => `<li class="tk tk--${kind}">
        <span class="tk-id">${escapeHtml(t.id)}</span>
        <span class="tk-title">${escapeHtml(t.title)}</span>
        <span class="tk-pri">P${t.priority}</span>
        <span class="tk-actions">
          ${actionButton(c, "start", { "data-action": "ticket-start", "data-id": t.id, "data-project": t.projectId })}
          ${actionButton(c, "note", { "data-action": "ticket-note", "data-id": t.id, "data-project": t.projectId })}
          ${actionButton(c, "close", { "data-action": "ticket-close", "data-id": t.id, "data-project": t.projectId, "data-confirm": "true" })}
        </span>
      </li>`,
        )
        .join("");

      const more = rest > 0
        ? `<li class="tk-more"><a href="/tickets#project=${encodeURIComponent(projectId)}">${rest} more</a></li>`
        : "";

      return `
    <div class="tk-col" data-project="${escapeHtml(projectId)}">
      <h3>${escapeHtml(projectId)} <span class="tk-count">${sorted.length}</span></h3>
      <ul class="tk-list">${items}${more}</ul>
    </div>`;
    })
    .join("");

  return band(
    "tickets",
    "Tickets",
    `${total} active &middot; <a href="/tickets">full board</a>`,
    `<div class="tk-grid">${columns}</div>`,
  );
}

// ---------------------------------------------------------------------------
// Tickets PAGE — dedicated /tickets surface, per-epic mini-kanbans plus a
// standalone block at the top. docs/specs/2026-05-09-tickets-page-design.md
// ---------------------------------------------------------------------------

function renderRunsLine(runs: TicketCitation["runs"]): string {
  if (!runs || runs.length === 0) return "";
  const links = runs.map((r) => {
    const statusClass = `run-status-${r.status}`;
    return `<a href="/runs/${escapeHtml(r.id)}" class="run-link ${statusClass}">${escapeHtml(r.id)} <span class="run-link-status">(${escapeHtml(r.status)})</span></a>`;
  }).join(" ");
  return `<div class="card-runs"><span class="card-runs-label">Runs:</span> ${links}</div>`;
}

function renderTicketCard(t: TicketCitation, opts: { showBlockedBy?: boolean } = {}): string {
  const priority = PRIORITY_LABELS[t.priority] ?? "P?";
  const ageLabel = t.ageDays <= 0
    ? "today"
    : t.ageDays === 1
      ? "1d"
      : `${t.ageDays}d`;
  const blockedBy =
    opts.showBlockedBy && t.depends.length > 0
      ? `<div class="blocked-by">&#8627; ${t.depends.map((d) => escapeHtml(d)).join(", ")}</div>`
      : "";
  // Inline detail panel — pre-rendered, hidden until expanded.
  const bodyHtml = t.body && t.body.trim()
    ? `<div class="card-body" hidden>${md(t.body)}</div>`
    : "";
  const runsLine = renderRunsLine(t.runs);
  const tagsLine = t.tags.length > 0
    ? `<div class="card-tags">${t.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  return `<article class="ticket-card" data-ticket-id="${escapeHtml(t.id)}" data-project="${escapeHtml(t.projectId)}" tabindex="0" role="button" aria-expanded="false">
    <div class="card-summary">
      <span class="card-id">${escapeHtml(t.id)}</span>
      <span class="card-title">${escapeHtml(t.title)}</span>
      <div class="card-byline">
        <span class="project">${escapeHtml(t.projectId)}</span>
        <span class="prio-${priority}">${priority}</span>
        <span class="age">${ageLabel}</span>
        <span class="card-chevron" aria-hidden="true">+</span>
      </div>
      ${blockedBy}
      ${runsLine}
    </div>
    ${bodyHtml}
    ${bodyHtml ? tagsLine : ""}
  </article>`;
}

function renderKanbanColumn(label: string, kind: "ready" | "progress" | "blocked", items: TicketCitation[]): string {
  const cards = items.length === 0
    ? `<div class="kanban-col-empty">&mdash;</div>`
    : items.map((t) => renderTicketCard(t, { showBlockedBy: kind === "blocked" })).join("\n");
  return `<div class="kanban-col">
    <h4 class="kanban-col-head ${kind}">
      <span>${escapeHtml(label)}</span>
      <span class="col-count">${items.length}</span>
    </h4>
    ${cards}
  </div>`;
}

function renderKanban(buckets: TicketBuckets): string {
  return `<div class="kanban">
    ${renderKanbanColumn("Ready", "ready", buckets.ready)}
    ${renderKanbanColumn("In Progress", "progress", buckets.inProgress)}
    ${renderKanbanColumn("Blocked", "blocked", buckets.blocked)}
  </div>`;
}

function renderEpicBoard(board: EpicBoard): string {
  const e = board.epic;
  const priority = PRIORITY_LABELS[e.priority] ?? "P?";
  const prioClass = e.priority === 0 ? "p0" : "";
  const tags = e.tags.length > 0
    ? `<span class="chip">${e.tags.map((t) => escapeHtml(t)).join(" &middot; ")}</span>`
    : "";
  const hasBody = !!(e.body && e.body.trim());
  const headRole = hasBody
    ? ' role="button" tabindex="0" aria-expanded="false"'
    : "";
  const chevron = hasBody
    ? `<span class="board-chevron" aria-hidden="true">+</span>`
    : "";
  const bodyBlock = hasBody
    ? `<div class="epic-body" hidden>${md(e.body!)}</div>`
    : "";
  return `<section class="epic-board" data-epic-id="${escapeHtml(e.id)}" data-project="${escapeHtml(e.projectId)}">
  <div class="board-head"${headRole}>
    <div class="board-head-left">
      <span class="board-eyebrow">Epic</span>
      <span class="board-id mono">${escapeHtml(e.id)}</span>
      <span class="board-title">${escapeHtml(e.title)}</span>
    </div>
    <div class="board-chips">
      <span class="chip">${escapeHtml(e.projectId)}</span>
      <span class="chip chip-prio ${prioClass}">${priority}</span>
      <span class="chip chip-active">${board.childCount} active</span>
      ${tags}
      ${chevron}
    </div>
  </div>
  ${bodyBlock}
  ${renderKanban(board.buckets)}
</section>`;
}

function renderStandaloneBoard(buckets: TicketBuckets): string {
  const total = buckets.ready.length + buckets.inProgress.length + buckets.blocked.length;
  if (total === 0) return "";
  return `<section class="standalone-board">
  <div class="board-head">
    <div>
      <span class="board-eyebrow">Standalone</span>
      <span class="board-title">Unfiled tickets</span>
    </div>
    <div class="board-chips">
      <span class="chip chip-active">${total} active</span>
    </div>
  </div>
  ${renderKanban(buckets)}
</section>`;
}

export function renderTicketsPage(data: TicketsPageData, _c: RenderContext): string {
  const { epics, standalone, totalActive, projectCount } = data;

  if (totalActive === 0) {
    return `
<section class="section" id="section-tickets-page">
  <div class="section-head">
    <h2>Tickets</h2>
    <span class="kicker">Clean desk</span>
  </div>
  <hr class="amber"/>
  <div class="tickets-page-empty">No active tickets across any project.</div>
</section>`;
  }

  return `
<section class="section" id="section-tickets-page">
  <div class="section-head">
    <h2>Tickets</h2>
    <span class="kicker">${totalActive} active &middot; ${epics.length} epic${epics.length === 1 ? "" : "s"} &middot; ${projectCount} project${projectCount === 1 ? "" : "s"}</span>
  </div>
  <hr class="amber"/>
  ${renderStandaloneBoard(standalone)}
  ${epics.map((b) => renderEpicBoard(b)).join("\n")}
</section>`;
}

export function renderTicketsPageDocument(data: TicketsPageData, opts: RenderOptions = {}): string {
  const c = ctx(opts);
  const today = data.generatedAt.slice(0, 10);
  const nav = renderPageNav("/tickets");

  const scriptBlock = c.interactive ? `<script>${DASHBOARD_JS}</script>` : "";
  const filterBar = c.interactive ? renderTicketsFilterBar(data.projectIds) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Tickets · ${escapeHtml(today)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${nav}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline">
      <span>Tickets</span>
      <span class="sep">·</span>
      <span>${escapeHtml(longDate(today))}</span>
    </div>
  </header>
  ${filterBar}
  ${renderTicketsPage(data, c)}
</div>
${scriptBlock}
</body>
</html>`;
}

function renderTicketsFilterBar(projectIds: string[]): string {
  if (projectIds.length === 0) return "";
  const pills = [
    `<button type="button" class="pill pill--active" data-project-filter="ALL">ALL</button>`,
    ...projectIds.map(
      (id) =>
        `<button type="button" class="pill" data-project-filter="${escapeHtml(id)}">${escapeHtml(id)}</button>`,
    ),
  ].join("");
  return `<div class="tickets-filter-bar">
    <div class="pills">${pills}</div>
  </div>
  <div id="filter-banner" class="filter-banner" aria-live="polite"></div>`;
}

// ---------------------------------------------------------------------------
// V1 cross-cutting widgets — Group 7 of the memory redesign.
// ---------------------------------------------------------------------------

export function renderReflections(reflection: ReflectionDay | null | undefined): string {
  if (!reflection || !reflection.body) {
    return `
<section class="section" id="section-reflections">
  <div class="section-head"><h2>Reflections</h2><span class="kicker">No reflections on file</span></div>
  <hr class="amber"/>
  <p>Pass V hasn&rsquo;t landed any reflections yet. They appear after the nightly verifier accepts a Pass C candidate.</p>
</section>`;
  }
  const ageLabel =
    reflection.ageDays === 0 ? "today"
    : reflection.ageDays === 1 ? "yesterday"
    : `${reflection.ageDays} days ago`;
  const staleNote = reflection.ageDays >= 3
    ? ` <span class="kicker-warn">· stale (${reflection.ageDays}d)</span>`
    : "";
  return `
<section class="section" id="section-reflections">
  <div class="section-head">
    <h2>Reflections</h2>
    <span class="kicker">${escapeHtml(longDate(reflection.date))} &middot; ${escapeHtml(ageLabel)}${staleNote}</span>
  </div>
  <hr class="amber"/>
  <div class="reflections">${md(reflection.body)}</div>
</section>`;
}

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

/** Human labels for the taste-track passes so the cost table reads legibly. */
const PASS_LABELS: Record<string, string> = {
  TA: "taste flag",
  TB: "taste analyze",
  TC: "taste consolidate",
  TR: "taste replay",
};

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
      const tasteLabel = PASS_LABELS[p.pass];
      const passCell = tasteLabel ? `Pass ${escapeHtml(p.pass)} · ${escapeHtml(tasteLabel)}` : `Pass ${escapeHtml(p.pass)}`;
      return `<tr>
  <td><strong>${passCell}</strong>${projectLabel}</td>
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

/**
 * The taste track (TA flag → TB analyze → TC consolidate + replay): what the
 * night learned about judgment. Surfaces the actionable `review-eligible` queue
 * and the gate's bookkeeping. Renders nothing when no taste run is on file.
 */
export function renderTasteTrack(taste: TasteTrackSnapshot | undefined): string {
  if (!taste || !taste.available) return "";

  const stat = (label: string, n: number, emphasis = false): string =>
    `<li><span class="num">${emphasis ? `<strong>${n}</strong>` : n}</span> ${escapeHtml(label)}</li>`;

  const counts = [
    stat("review-eligible", taste.reviewEligible, true),
    stat("written", taste.written),
    stat("holding", taste.holding),
    stat("replay-confirmed", taste.replayPassed),
    ...(taste.replayInconclusive ? [stat("replay-inconclusive (held)", taste.replayInconclusive)] : []),
    ...(taste.conflicts ? [stat("conflicts", taste.conflicts)] : []),
    ...(taste.tensions ? [stat("tensions", taste.tensions)] : []),
    ...(taste.handoffs ? [stat("→ fact candidates", taste.handoffs)] : []),
  ].join("\n");

  const queue = taste.reviewEligibleUnits.length
    ? `<table class="run-usage-table">
      <thead><tr><th>Rule</th><th>Category</th><th>Tier</th><th>Seen</th><th>Ladders up to</th></tr></thead>
      <tbody>
${taste.reviewEligibleUnits
  .map(
    (u) => `<tr>
  <td><strong>${escapeHtml(u.dedupeKey)}</strong></td>
  <td>${escapeHtml(u.category)}</td>
  <td>${escapeHtml(u.tier)}</td>
  <td class="num">${u.recurrence}×</td>
  <td>${u.laddersUpTo ? escapeHtml(u.laddersUpTo) : "—"}</td>
</tr>`,
  )
  .join("\n")}
      </tbody>
    </table>
    <p class="kicker">Run <code>hive taste review</code> to approve, edit, or kill these.</p>`
    : `<p>Nothing review-eligible — judgments accumulating in holding.</p>`;

  const proposals = taste.newPrincipleProposals.length
    ? `<div class="taste-proposals"><h3>New-principle proposals</h3><ul>${taste.newPrincipleProposals
        .map((p) => `<li>${escapeHtml(p)}</li>`)
        .join("")}</ul></div>`
    : "";

  return `
<section class="section" id="section-taste-track">
  <div class="section-head">
    <h2>Taste track</h2>
    <span class="kicker">${escapeHtml(taste.date)} · ${taste.reviewEligible} awaiting review · <a class="taste-more" href="/taste">full library →</a></span>
  </div>
  <hr class="amber"/>
  <ul class="taste-stats">
${counts}
  </ul>
  ${queue}
  ${proposals}
</section>`;
}

// ---------------------------------------------------------------------------
// /taste — the durable taste library (its own page, like /tickets and /runs)
// ---------------------------------------------------------------------------

/** A single taste unit — rule scannable, the WHY behind a disclosure. */
function renderTasteUnit(u: TastePageUnit): string {
  const glob = u.glob ? `:${escapeHtml(u.glob)}` : "";
  const scopeSuffix = u.scopeLabel !== "general" ? ` · ${escapeHtml(u.scopeLabel)}` : "";
  const secondary = u.secondaryCategory ? ` (+${escapeHtml(u.secondaryCategory)})` : "";
  const meta = `${escapeHtml(u.tier)} · ${escapeHtml(u.scopeKind)}${glob} · ${escapeHtml(
    u.reasonSource,
  )} · seen ${u.recurrence}×${scopeSuffix}`;
  const ladder = u.laddersUpTo
    ? `<span class="taste-ladder">↑ ${escapeHtml(u.laddersUpTo)}</span>`
    : "";
  const example =
    u.bad || u.good
      ? `<div class="taste-eg">
      <p><span class="taste-eg-label taste-eg-bad">bad</span> ${escapeHtml(u.bad)}</p>
      <p><span class="taste-eg-label taste-eg-good">good</span> ${escapeHtml(u.good)}</p>
    </div>`
      : "";
  return `<div class="taste-unit taste-unit--${u.status}">
  <div class="taste-unit-head">
    <span class="taste-badge taste-badge--${u.status}">${u.status}</span>
    <span class="taste-rule">${escapeHtml(u.ruleStatement)}${secondary}</span>
  </div>
  <div class="taste-meta">${meta}${ladder}</div>
  <details class="taste-detail">
    <summary>why</summary>
    <p class="taste-why">${escapeHtml(u.reasoning)}</p>
    ${example}
  </details>
</div>`;
}

/** One category block: header with lifecycle counts, then its units. */
function renderTasteCategory(g: TasteCategoryGroup): string {
  const counts = [
    g.active ? `${g.active} active` : "",
    g.pending ? `${g.pending} pending` : "",
    g.holding ? `${g.holding} holding` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<section class="section taste-cat" id="taste-cat-${g.category.toLowerCase()}">
  <div class="section-head">
    <h2>${escapeHtml(g.category)}</h2>
    <span class="kicker">${escapeHtml(counts)}</span>
  </div>
  <hr class="amber"/>
  ${g.units.map(renderTasteUnit).join("\n")}
</section>`;
}

/** The overview strip: library lifecycle totals + the night's gate posture. */
function renderTasteOverview(data: TastePageData): string {
  const t = data.totals;
  const run = data.latestRun;
  const stat = (label: string, n: number, emphasis = false): string =>
    `<li><span class="num">${emphasis ? `<strong>${n}</strong>` : n}</span> ${escapeHtml(label)}</li>`;
  const libraryStats = [
    stat("units", t.total, true),
    stat("active", t.active),
    stat("pending", t.pending),
    stat("holding", t.holding),
  ].join("\n");
  const runStats = run.available
    ? `<ul class="taste-stats">
      ${stat("review-eligible", run.reviewEligible, true)}
      ${stat("written this run", run.written)}
      ${stat("replay-confirmed", run.replayPassed)}
      ${run.tensions ? stat("tensions", run.tensions) : ""}
      ${run.conflicts ? stat("conflicts", run.conflicts) : ""}
    </ul>
    <p class="kicker">Last gate run ${escapeHtml(run.date)}.</p>`
    : `<p class="kicker">No taste run on file for today yet.</p>`;
  return `<section class="section" id="taste-overview">
  <div class="section-head">
    <h2>The library</h2>
    <span class="kicker">${data.groups.length} categor${data.groups.length === 1 ? "y" : "ies"} · ${escapeHtml(
      data.scopes.join(", "),
    )}</span>
  </div>
  <hr class="amber"/>
  <ul class="taste-stats">
${libraryStats}
  </ul>
  ${runStats}
</section>`;
}

/** The review-eligible queue — the actionable call to `hive taste review`. */
function renderTasteReviewQueue(run: TasteTrackSnapshot): string {
  if (!run.available || run.reviewEligibleUnits.length === 0) return "";
  const rows = run.reviewEligibleUnits
    .map(
      (u) => `<tr>
  <td class="rule-key">${escapeHtml(u.dedupeKey)}</td>
  <td>${escapeHtml(u.category)}</td>
  <td>${escapeHtml(u.tier)}</td>
  <td class="num">${u.recurrence}×</td>
  <td>${u.laddersUpTo ? escapeHtml(u.laddersUpTo) : "—"}</td>
</tr>`,
    )
    .join("\n");
  return `<section class="section" id="taste-review-queue">
  <div class="section-head">
    <h2>Awaiting review</h2>
    <span class="kicker">${run.reviewEligible} eligible</span>
  </div>
  <hr class="amber"/>
  <table class="taste-review-table">
    <thead><tr><th>Rule</th><th>Category</th><th>Tier</th><th>Seen</th><th>Ladders up to</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="kicker">Run <code>hive taste review</code> to approve, edit, or kill these.</p>
</section>`;
}

/** The apex canon these units ladder up to — reference rail, name + gloss. */
function renderTastePrinciples(principles: TastePrinciple[]): string {
  if (principles.length === 0) return "";
  const items = principles
    .map(
      (p) => `<li class="taste-principle">
  <h3>${escapeHtml(p.name)}</h3>
  ${p.body ? `<p>${escapeHtml(p.body)}</p>` : ""}
</li>`,
    )
    .join("\n");
  return `<section class="section" id="taste-principles">
  <div class="section-head">
    <h2>Principles</h2>
    <span class="kicker">the canon units ladder up to</span>
  </div>
  <hr class="amber"/>
  <ul class="taste-principle-list">
${items}
  </ul>
</section>`;
}

function renderTastePageBody(data: TastePageData): string {
  const library = data.groups.length
    ? data.groups.map(renderTasteCategory).join("\n")
    : `<section class="section"><hr class="amber"/><p>No taste units yet — judgments accumulate here once the nightly gate admits them.</p></section>`;
  return [
    renderTasteOverview(data),
    renderTasteReviewQueue(data.latestRun),
    library,
    renderTastePrinciples(data.principles),
  ].join("\n");
}

export function renderTastePageDocument(data: TastePageData, opts: RenderOptions = {}): string {
  const c = ctx(opts);
  const today = data.generatedAt.slice(0, 10);
  const nav = renderPageNav("/taste");
  const scriptBlock = c.interactive ? `<script>${DASHBOARD_JS}</script>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Taste · ${escapeHtml(today)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${nav}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline">
      <span>Taste</span>
      <span class="sep">·</span>
      <span>${escapeHtml(longDate(today))}</span>
    </div>
  </header>
  ${renderTastePageBody(data)}
</div>
${scriptBlock}
</body>
</html>`;
}

export function renderRuns(runs: RunEntry[], c: RenderContext): string {
  const visible = runs.slice(0, 10);
  if (visible.length === 0) return "";

  const rows = visible
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
    <span class="kicker">${visible.length} Most recent</span>
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

  // The last band still wearing the old world: a section-head and kicker where
  // every sibling uses the yard label, which made it read as a different page
  // stapled to the bottom of this one.
  return band(
    "archive",
    "Archive",
    `past ${Math.min(limit, data.briefings.length)} days &middot; click a date to open`,
    `<div class="archive">\n${cards}\n</div>`,
  );
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
    renderYard(data),
    `<main class="page">`,
    renderBriefingBand(data),
    renderWatchesBand(data.watches),
    renderTickets(data.tickets, c),
    renderStores(data),
    renderArchive(data, c),
    renderUpkeep(data),
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
<title>HIVE · The Inspection · ${escapeHtml(shortDate(data.today))}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<!--
THESIS: An inspection ends in a verdict per colony, not a log. Refuses the
equal-weight section stack that made the old page unscannable.
OWN-WORLD: Weathered chalk ground; painted hive bodies in cobalt, verdigris,
violet, slate, olive; oxide red reserved for escalation and never decorative;
stencil caps; tabular figures. No hexagon, no honey-amber, no serif broadsheet.
STORY: The reader learns which projects want them before reading a single
number, then reads why, then opens the one that matters.
FIRST VIEWPORT: Wordmark and dateline top-left; one sentence counting the
colonies that want you; beneath it a baseline row of hives standing at the
height their stores earn, brood chamber at the base with an entrance sized to
traffic, verdict stencilled on the plate under each.
FORM: The Apiary Record; candidate 6 of 7; seed key 2570ec1e.
FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, and DESIGN.md
-->
${body}
${scriptBlock}
</body>
</html>`;
}
