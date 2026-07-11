// Deterministic renderer: scenario/* → corpus/* + gold/*.
//
//   bun run loam/benchmark/tools/render.ts            # render in place
//   bun run loam/benchmark/tools/render.ts --out DIR  # render elsewhere
//
// Fails hard on any inconsistency: unknown eids, spans that aren't in
// their event's content, self_reference flags that disagree with the
// artifact's actor list, retellings of non-stories, instantiations of
// non-procedures, or instantiations without divergence.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { Actor, GoldRef, RefKind } from "./types.ts";
import { ORG, ACTORS, CHANNELS } from "../scenario/org.ts";
import { ARTIFACTS, NON_ARTIFACTS } from "../scenario/artifacts.ts";
import { COMMITS } from "../scenario/git.ts";
import { EMAILS } from "../scenario/email.ts";
import { TRANSCRIPTS } from "../scenario/transcripts.ts";
import { SLACK_Q1 } from "../scenario/slack-q1.ts";
import { SLACK_Q2 } from "../scenario/slack-q2.ts";

const BENCH_ROOT = join(import.meta.dir, "..");
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag >= 0 ? process.argv[outFlag + 1] : BENCH_ROOT;

const SLACK = [...SLACK_Q1, ...SLACK_Q2];

// ── helpers ─────────────────────────────────────────────────────────
function fail(msg: string): never {
  throw new Error(`scenario error: ${msg}`);
}

function epoch(at: string, ctx: string): number {
  const m = at.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) fail(`bad timestamp "${at}" in ${ctx}`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  if (Number.isNaN(t)) fail(`invalid date "${at}" in ${ctx}`);
  return Math.floor(t / 1000);
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const actorById = new Map<string, Actor>(ACTORS.map((a) => [a.id, a]));
const gitIdent = new Map(ACTORS.flatMap((a) => (a.git ?? []).map((g) => [g.key, { actor: a.id, ...g }] as const)));
const channelByName = new Map(CHANNELS.map((c) => [c.name, c]));
for (const c of CHANNELS) for (const m of c.members) if (!actorById.has(m)) fail(`channel #${c.name}: unknown member ${m}`);

interface Ev {
  eid: string;
  source: "slack" | "email" | "git" | "transcript";
  native_id: string; // git filled in after fast-import
  at: number;
  actor: string;
  kind: string;
  content: string;
  venue: { name: string; audience_size: number | null };
  refs: GoldRef[];
  negative?: { artifact: string; note: string };
}
const events = new Map<string, Ev>();
function addEvent(ev: Ev) {
  if (events.has(ev.eid)) fail(`duplicate eid ${ev.eid}`);
  events.set(ev.eid, ev);
}

function write(rel: string, content: string) {
  const p = join(OUT, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

// ── slack ───────────────────────────────────────────────────────────
const slackTs = new Map<string, string>(); // eid → ts
{
  const seen = new Set<string>();
  const byChanDay = new Map<string, { ts: string; msg: Record<string, unknown> }[]>();
  const sorted = [...SLACK].sort((a, b) => epoch(a.at, a.eid) - epoch(b.at, b.eid));
  for (const m of sorted) {
    const ch = channelByName.get(m.channel) ?? fail(`${m.eid}: unknown channel #${m.channel}`);
    const actor = actorById.get(m.user) ?? fail(`${m.eid}: unknown user ${m.user}`);
    if (!ch.members.includes(m.user)) fail(`${m.eid}: ${m.user} is not a member of #${m.channel}`);
    const sec = epoch(m.at, m.eid);
    const key = `${m.channel}:${sec}`;
    if (seen.has(key)) fail(`${m.eid}: duplicate second-resolution timestamp in #${m.channel} (${m.at})`);
    seen.add(key);
    const ts = `${sec}.000000`;
    slackTs.set(m.eid, ts);
    const rec: Record<string, unknown> = { type: "message", user: actor.slack, text: m.text, ts };
    if (m.thread) {
      const parent = slackTs.get(m.thread) ?? fail(`${m.eid}: thread parent ${m.thread} not found (must precede reply)`);
      rec.thread_ts = parent;
    }
    addEvent({
      eid: m.eid, source: "slack", native_id: `${m.channel}:${ts}`, at: sec, actor: m.user,
      kind: "message", content: m.text,
      venue: { name: `#${m.channel}`, audience_size: ch.members.length },
      refs: m.refs ?? [], negative: m.negative,
    });
    const dk = `${m.channel}/${day(sec)}`;
    if (!byChanDay.has(dk)) byChanDay.set(dk, []);
    byChanDay.get(dk)!.push({ ts, msg: rec });
  }
  for (const [dk, msgs] of byChanDay) write(`corpus/slack/${dk}.json`, json(msgs.map((x) => x.msg)));
  write("corpus/slack/users.json", json(ACTORS.map((a) => ({
    id: a.slack, team_id: "T0AA00000", name: a.id, real_name: a.name,
    is_bot: a.is_agent ?? false, profile: { email: a.email, real_name: a.name },
  }))));
  write("corpus/slack/channels.json", json(CHANNELS.map((c, i) => ({
    id: `C0AA0000${i + 1}`, name: c.name,
    members: c.members.map((m) => actorById.get(m)!.slack),
    topic: { value: c.topic }, purpose: { value: c.topic },
  }))));
}

// ── email ───────────────────────────────────────────────────────────
{
  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], MONS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const rfc2822 = (sec: number) => {
    const d = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  };
  const asctime = (sec: number) => {
    const d = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  };
  const msgid = (eid: string) => `<${eid}@${ORG.domain}>`;
  const addr = (id: string) => {
    const a = actorById.get(id) ?? fail(`email: unknown actor ${id}`);
    return `${a.name} <${a.email}>`;
  };
  const sorted = [...EMAILS].sort((a, b) => epoch(a.at, a.eid) - epoch(b.at, b.eid));
  const byEid = new Map(sorted.map((e) => [e.eid, e]));
  let mbox = "";
  for (const e of sorted) {
    const sec = epoch(e.at, e.eid);
    const from = actorById.get(e.from) ?? fail(`${e.eid}: unknown sender ${e.from}`);
    const refsChain: string[] = [];
    for (let p = e.inReplyTo; p; ) {
      const parent = byEid.get(p) ?? fail(`${e.eid}: inReplyTo ${p} not found`);
      refsChain.unshift(msgid(parent.eid));
      p = parent.inReplyTo;
    }
    mbox += `From ${from.email} ${asctime(sec)}\n`;
    mbox += `From: ${addr(e.from)}\n`;
    mbox += `To: ${e.to.map(addr).join(", ")}\n`;
    if (e.cc?.length) mbox += `Cc: ${e.cc.map(addr).join(", ")}\n`;
    mbox += `Subject: ${e.subject}\n`;
    mbox += `Date: ${rfc2822(sec)}\n`;
    mbox += `Message-ID: ${msgid(e.eid)}\n`;
    if (e.inReplyTo) {
      mbox += `In-Reply-To: ${msgid(e.inReplyTo)}\n`;
      mbox += `References: ${refsChain.join(" ")}\n`;
    }
    mbox += `MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n`;
    mbox += e.body.replace(/^From /gm, ">From ") + "\n\n";
    addEvent({
      eid: e.eid, source: "email", native_id: msgid(e.eid), at: sec, actor: e.from,
      kind: "message", content: `${e.subject}\n${e.body}`,
      venue: { name: "email", audience_size: 1 + e.to.length + (e.cc?.length ?? 0) },
      refs: e.refs ?? [], negative: e.negative,
    });
  }
  write("corpus/email/threads.mbox", mbox);
}

// ── transcripts ─────────────────────────────────────────────────────
for (const t of TRANSCRIPTS) {
  const sec0 = epoch(t.at, t.file);
  let md = `# ${t.title}\n\n`;
  md += `Date: ${iso(sec0)}\n`;
  md += `Attendees: ${t.attendees.map((a) => (actorById.get(a) ?? fail(`${t.file}: unknown attendee ${a}`)).name).join(", ")}\n\n---\n\n`;
  t.segments.forEach((s, i) => {
    const a = actorById.get(s.speaker) ?? fail(`${s.eid}: unknown speaker ${s.speaker}`);
    if (!t.attendees.includes(s.speaker)) fail(`${s.eid}: speaker ${s.speaker} not in attendee list`);
    md += `${i + 1}. **${a.name}:** ${s.text}\n\n`;
    addEvent({
      eid: s.eid, source: "transcript", native_id: `${t.file}#${i + 1}`,
      at: sec0 + i * 60, actor: s.speaker, kind: "transcript_segment", content: s.text,
      venue: { name: t.title, audience_size: t.attendees.length },
      refs: s.refs ?? [], negative: s.negative,
    });
  });
  write(`corpus/transcripts/${t.file}`, md);
}

// ── git ─────────────────────────────────────────────────────────────
{
  const sorted = [...COMMITS].sort((a, b) => epoch(a.at, a.eid) - epoch(b.at, b.eid));
  let stream = "";
  sorted.forEach((c, i) => {
    const ident = gitIdent.get(c.author) ?? fail(`${c.eid}: unknown git identity ${c.author}`);
    const sec = epoch(c.at, c.eid);
    const who = `${ident.name} <${ident.email}> ${sec} +0000`;
    const msg = c.message + "\n";
    stream += `commit refs/heads/main\nmark :${i + 1}\n`;
    stream += `author ${who}\ncommitter ${who}\n`;
    stream += `data ${Buffer.byteLength(msg)}\n${msg}`;
    for (const [path, content] of Object.entries(c.files)) {
      if (content === null) stream += `D ${path}\n`;
      else stream += `M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }
    stream += "\n";
    const diffText = Object.entries(c.files)
      .map(([p, body]) => (body === null ? `[delete ${p}]` : `--- ${p} ---\n${body}`))
      .join("\n");
    addEvent({
      eid: c.eid, source: "git", native_id: `mark:${i + 1}`, at: sec, actor: ident.actor,
      kind: "commit", content: `${c.message}\n\n${diffText}`,
      venue: { name: "repo:sundial", audience_size: null },
      refs: c.refs ?? [], negative: c.negative,
    });
  });
  write("corpus/git/sundial.fast-import", stream);
  write(
    "corpus/git/build.sh",
    `#!/usr/bin/env bash
# Rebuild the sundial repo from the frozen fast-import stream.
# Usage: ./build.sh [target-dir]   (default: ./sundial)
set -euo pipefail
dir="\${1:-sundial}"
git init -q "$dir"
git -C "$dir" fast-import --quiet < "$(dirname "$0")/sundial.fast-import"
git -C "$dir" checkout -q main
echo "rebuilt $dir @ $(git -C "$dir" rev-parse HEAD)"
`,
  );

  // Resolve marks → SHAs by actually importing (deterministic: fixed dates).
  const tmp = join(OUT, ".git-import-tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const init = spawnSync("git", ["init", "-q", "--bare", tmp]);
  if (init.status !== 0) fail(`git init failed: ${init.stderr}`);
  const marksPath = join(tmp, "marks.txt");
  const imp = spawnSync("git", ["-C", tmp, "fast-import", "--quiet", `--export-marks=${marksPath}`], {
    input: stream,
  });
  if (imp.status !== 0) fail(`git fast-import failed: ${imp.stderr}`);
  const marks = new Map(
    (await Bun.file(marksPath).text())
      .trim().split("\n")
      .map((l) => l.split(" ") as [string, string])
      .map(([m, sha]) => [m.slice(1), sha] as const),
  );
  sorted.forEach((c, i) => {
    const sha = marks.get(String(i + 1)) ?? fail(`no mark for commit ${c.eid}`);
    events.get(c.eid)!.native_id = sha;
  });
  rmSync(tmp, { recursive: true, force: true });
}

// ── gold: consistency checks + emission ─────────────────────────────
const artifactById = new Map(ARTIFACTS.map((a) => [a.id, a]));
for (const a of ARTIFACTS) for (const act of a.actors) if (!actorById.has(act)) fail(`${a.id}: unknown actor ${act}`);

// Every gold ref, checked and flattened.
interface RefRow {
  id: string;
  artifact_id: string;
  source: string;
  native_id: string;
  at: string;
  actor: string;
  is_agent: boolean;
  kind: RefKind;
  difficulty: string | null;
  self_reference: boolean;
  violation: boolean;
  divergence: number | null;
  venue: { name: string; audience_size: number | null };
  span: string;
}
const refRows: RefRow[] = [];
for (const ev of events.values()) {
  ev.refs.forEach((r, i) => {
    const art = artifactById.get(r.artifact) ?? fail(`${ev.eid}: ref to unknown artifact ${r.artifact}`);
    if (!norm(ev.content).includes(norm(r.span)))
      fail(`${ev.eid}: span not found in content: "${r.span}"`);
    const isParticipant = art.actors.includes(ev.actor);
    if (Boolean(r.self_reference) !== isParticipant)
      fail(`${ev.eid}: ref to ${r.artifact} — self_reference=${r.self_reference ?? false} but actor ${ev.actor} ${isParticipant ? "IS" : "is NOT"} in artifact.actors`);
    if (r.kind === "retelling" && art.type !== "story")
      fail(`${ev.eid}: retelling of non-story ${r.artifact}`);
    if (r.kind === "instantiation" && art.type !== "procedure")
      fail(`${ev.eid}: instantiation of non-procedure ${r.artifact}`);
    if ((r.kind === "instantiation") !== (r.divergence !== undefined))
      fail(`${ev.eid}: divergence must be present iff kind=instantiation (${r.artifact})`);
    refRows.push({
      id: `ref-${ev.eid}-${i + 1}`,
      artifact_id: r.artifact,
      source: ev.source,
      native_id: ev.native_id,
      at: iso(ev.at),
      actor: ev.actor,
      is_agent: actorById.get(ev.actor)!.is_agent ?? false,
      kind: r.kind,
      difficulty: r.difficulty ?? null,
      self_reference: r.self_reference ?? false,
      violation: r.violation ?? false,
      divergence: r.divergence ?? null,
      venue: ev.venue,
      span: r.span,
    });
  });
}
refRows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

// Artifacts: resolve provenance eids, forbid provenance after creation-day+1 grace? (no — just resolve)
const goldArtifacts = ARTIFACTS.map((a) => ({
  ...a,
  provenance: a.provenance.map((eid) => {
    const ev = events.get(eid) ?? fail(`${a.id}: provenance eid ${eid} not found`);
    return { eid, source: ev.source, native_id: ev.native_id, at: iso(ev.at) };
  }),
}));
const goldNegatives = {
  near_miss_events: [...events.values()]
    .filter((e) => e.negative)
    .sort((a, b) => a.at - b.at)
    .map((e) => ({
      eid: e.eid, source: e.source, native_id: e.native_id, at: iso(e.at), actor: e.actor,
      would_match: e.negative!.artifact, note: e.negative!.note, content: e.content,
    })),
  non_artifacts: NON_ARTIFACTS.map((n) => ({
    ...n,
    evidence: n.evidence.map((eid) => {
      const ev = events.get(eid) ?? fail(`${n.id}: evidence eid ${eid} not found`);
      return { eid, source: ev.source, native_id: ev.native_id };
    }),
  })),
};
for (const n of goldNegatives.near_miss_events)
  if (!artifactById.has(n.would_match)) fail(`negative on ${n.eid}: unknown artifact ${n.would_match}`);

// Stats
const count = <T,>(xs: T[], f: (x: T) => string) =>
  xs.reduce((m: Record<string, number>, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const organic = refRows.filter((r) => !r.self_reference);
const stats = {
  exhaust_events: { total: events.size, ...count([...events.values()], (e) => e.source) },
  gold_artifacts: count(ARTIFACTS, (a) => a.type),
  reference_events: {
    total: refRows.length,
    by_kind: count(refRows, (r) => r.kind),
    by_kind_excluding_self_reference: count(organic, (r) => r.kind),
    assertions_by_difficulty: count(refRows.filter((r) => r.kind === "assertion"), (r) => r.difficulty ?? "?"),
    self_references: refRows.filter((r) => r.self_reference).length,
    violations: refRows.filter((r) => r.violation).length,
    multi_ref_events: Object.values(count(refRows, (r) => `${r.source}:${r.native_id}`)).filter((n) => n > 1).length,
  },
  near_miss_negatives: goldNegatives.near_miss_events.length,
  non_artifacts: goldNegatives.non_artifacts.length,
};

write("gold/actors.json", json(ACTORS.map((a) => ({
  actor_id: a.id, name: a.name, team: a.team, is_agent: a.is_agent ?? false,
  identities: {
    slack: a.slack, email: a.email,
    git: (a.git ?? []).map((g) => `${g.name} <${g.email}>`),
  },
}))));
write("gold/artifacts.json", json(goldArtifacts));
write("gold/reference_events.jsonl", refRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
write("gold/negatives.json", json(goldNegatives));
write("gold/stats.json", json(stats));

console.log(`rendered → ${OUT}`);
console.log(JSON.stringify(stats, null, 2));
