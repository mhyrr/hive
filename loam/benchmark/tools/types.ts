// LOAM Phase 0 benchmark — scenario source types.
//
// The scenario files under ../scenario are the single source of truth.
// tools/render.ts renders them into the frozen corpus formats under
// ../corpus (Slack export JSON, mbox, git fast-import, transcript md)
// AND into the gold label files under ../gold. Gold reference labels are
// authored inline on the exhaust events they occur in, so labels cannot
// drift from the corpus, and every labeled span is machine-checked to be
// a substring of the event content.

export type ActorId = string;
export type ArtifactId = string;
export type Eid = string; // stable authored event id, mapped to a native id at render time

export type RefKind = "citation" | "assertion" | "retelling" | "instantiation";
export type Difficulty = "easy" | "medium" | "hard";

/** A gold Reference Event, authored inline on the exhaust event that contains it. */
export interface GoldRef {
  artifact: ArtifactId;
  kind: RefKind;
  /** Lexical difficulty of the reference — reported dimension for recall (esp. assertions). */
  difficulty?: Difficulty;
  /** Must be a verbatim substring of the event content (render.ts enforces). */
  span: string;
  /** Actor is among the artifact's authors/participants → weight 0 under §6.4. */
  self_reference?: boolean;
  /** Instantiations only: normalized distance from the Procedure's canonical rev. */
  divergence?: number;
  /** This exhaust contradicts the referenced Principle/Fact (enactment gap / staleness input). */
  violation?: boolean;
}

/** A planted near-miss: content that superficially matches an artifact but is NOT a reference. */
export interface GoldNegative {
  artifact: ArtifactId; // the artifact a naive detector would wrongly match
  note: string;
}

export interface SlackMsg {
  eid: Eid;
  channel: string;
  /** UTC, "YYYY-MM-DD HH:MM" (optionally :SS). */
  at: string;
  user: ActorId;
  text: string;
  /** Eid of thread parent; renders as thread_ts. */
  thread?: Eid;
  refs?: GoldRef[];
  negative?: GoldNegative;
}

export interface Email {
  eid: Eid;
  at: string;
  from: ActorId;
  to: ActorId[];
  cc?: ActorId[];
  subject: string;
  inReplyTo?: Eid;
  body: string;
  refs?: GoldRef[];
  negative?: GoldNegative;
}

export interface Commit {
  eid: Eid;
  at: string;
  /** Key into Actor.git identities (an actor may commit under several). */
  author: string;
  message: string;
  /** path → content; null deletes the path. */
  files: Record<string, string | null>;
  refs?: GoldRef[];
  negative?: GoldNegative;
}

export interface TranscriptSeg {
  eid: Eid;
  speaker: ActorId;
  text: string;
  refs?: GoldRef[];
  negative?: GoldNegative;
}

export interface Transcript {
  /** Output filename under corpus/transcripts/. */
  file: string;
  title: string;
  at: string;
  attendees: ActorId[];
  segments: TranscriptSeg[];
}

export interface GitIdentity {
  key: string; // referenced by Commit.author
  name: string;
  email: string;
}

export interface Actor {
  id: ActorId;
  name: string;
  team: "eng" | "product" | "gtm" | "exec";
  is_agent?: boolean;
  slack: string; // Slack user id (U…)
  email: string;
  git?: GitIdentity[];
}

export interface Channel {
  name: string;
  members: ActorId[]; // audience size feeds reach-scaling gold
  topic: string;
}

export type ArtifactType =
  | "episode"
  | "decision"
  | "story"
  | "principle"
  | "procedure"
  | "fact";

export interface GoldArtifact {
  id: ArtifactId;
  type: ArtifactType;
  title: string;
  summary: string;
  occurred_at: string; // UTC "YYYY-MM-DD"
  actors: ActorId[]; // authors/participants — the §6.4 self-reference set
  provenance: Eid[]; // resolved to native ids at render time
  scope: "org" | "team:eng" | "team:product" | "team:gtm";
  /** Type-specific extensions (supersedes, moral, canonical file, …). */
  attrs?: Record<string, unknown>;
}

/** A discussed-but-never-decided question: extraction must NOT emit an artifact. */
export interface GoldNonArtifact {
  id: string;
  would_be_type: ArtifactType;
  title: string;
  why_not: string;
  evidence: Eid[];
}
