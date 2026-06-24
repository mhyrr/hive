/**
 * Pass TA-0 — mechanical segmentation (design §4.1). No model runs here.
 * Locate candidate *divergence windows* with cheap structural + lexical cues,
 * erring toward recall; precision is bought downstream by TA-1 + TB. This
 * mirrors condition.ts's "rank before any model" philosophy and is fully
 * unit-testable on inline transcripts.
 */
import { basename } from "node:path";

import { hasAlwaysIncludeMarker } from "./sessions";
import type { TranscriptEvent } from "./transcript";
import type { DivergenceWindow, LocusKind } from "./taste-types";

export interface SegmentOptions {
  kBefore?: number;
  kAfter?: number;
  /** Max event distance for a repeated tool target to count as a redo. */
  repeatTargetWithin?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  kBefore: 2,
  kAfter: 4,
  repeatTargetWithin: 12,
};

// High-recall, deliberately noisy. TB is the precision gate (design §4.1).
const REACTION_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\bno,/i, cue: "no," },
  { re: /\b(not|don'?t|isn'?t|doesn'?t|won'?t|didn'?t)\b/i, cue: "negation" },
  { re: /\binstead\b/i, cue: "instead" },
  { re: /\bactually\b/i, cue: "actually" },
  { re: /\bwhy (did|are|would|do) you\b/i, cue: "why-did-you" },
  { re: /\b(revert|undo|roll ?back|back ?out)\b/i, cue: "revert" },
  { re: /\b(redo|re-?do|again|once more)\b/i, cue: "redo" },
  { re: /\btoo (verbose|clever|much|many|complex|complicated|long|big)\b/i, cue: "too-x" },
  { re: /\b(simpler|simplify|cleaner|leaner|tighter)\b/i, cue: "simpler" },
  { re: /\bjust\b/i, cue: "just" },
  { re: /\b(wrong|incorrect|broken|that'?s a bug|buggy)\b/i, cue: "wrong" },
  { re: /\b(stop|wait|hold on|hang on)\b/i, cue: "stop" },
  { re: /\b(prefer|rather|should (be|have|use)|use .+ instead)\b/i, cue: "preference" },
];

const PRAISE_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\b(nice|great|perfect|exactly|love it|beautiful|clean|elegant)\b/i, cue: "praise" },
  { re: /\b(that'?s it|nailed it|ship it|lgtm|love this)\b/i, cue: "praise-strong" },
];

const REVERT_CMD = /\bgit (checkout|revert|reset|restore|stash)\b/i;
// Abandoning a path by removing/renaming it is a self-correction even when the
// target differs (so repeat-target can't see it) and no git/error is involved.
const DESTRUCTIVE_CMD = /\b(rm|rmdir|unlink|mv|git mv|git rm)\b/i;

// A substantive user turn (terse corrections like "make it a UUID" clear this)
// vs. a bare acknowledgement ("ok", "yes", "thanks") that isn't a divergence.
const MIN_POST_ACTION_LEN = 12;

interface Locus {
  index: number;
  kind: LocusKind;
  cues: string[];
}

function reactionCues(text: string): string[] {
  const cues = new Set<string>();
  for (const { re, cue } of REACTION_CUES) if (re.test(text)) cues.add(cue);
  for (const { re, cue } of PRAISE_CUES) if (re.test(text)) cues.add(cue);
  if (hasAlwaysIncludeMarker(text)) cues.add("always-include");
  return Array.from(cues);
}

function detectLoci(events: TranscriptEvent[], o: Required<SegmentOptions>): Locus[] {
  const loci: Locus[] = [];
  let assistantSinceUser = false;
  let toolUseSinceUser = false;
  const targetLastIdx = new Map<string, number>();
  let lastErrorIdx = -1_000;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;

    // Human-reaction locus: a user message reacting to assistant output.
    if (e.kind === "message" && e.role === "user") {
      if (assistantSinceUser) {
        const cues = reactionCues(e.text);
        if (cues.length > 0) {
          loci.push({ index: i, kind: "human-reaction", cues });
        } else if (toolUseSinceUser && e.text.trim().length >= MIN_POST_ACTION_LEN) {
          // Recall floor: a substantive user turn after the assistant DID
          // something, with no lexical cue, is still a candidate divergence
          // (terse restated-requirement corrections). TB is the precision gate.
          loci.push({ index: i, kind: "human-reaction", cues: ["post-action"] });
        }
      }
      assistantSinceUser = false;
      toolUseSinceUser = false;
    } else if (e.role === "assistant") {
      assistantSinceUser = true;
    }

    // Self-correction locus: revert / destructive-path / repeated target / error-retry.
    if (e.kind === "tool_use") {
      toolUseSinceUser = true;
      const cues: string[] = [];
      const summary = e.tool?.summary ?? "";
      if (REVERT_CMD.test(summary)) cues.push("revert-cmd");
      if (DESTRUCTIVE_CMD.test(summary)) cues.push("destructive-cmd");
      const target = e.tool?.target;
      if (target) {
        const prev = targetLastIdx.get(target);
        if (prev !== undefined && i - prev <= o.repeatTargetWithin) cues.push("repeat-target");
        targetLastIdx.set(target, i);
      }
      if (i - lastErrorIdx <= 2) cues.push("error-retry");
      if (cues.length > 0) loci.push({ index: i, kind: "self-correction", cues });
    }

    if (e.kind === "tool_result" && e.tool?.isError) lastErrorIdx = i;
  }

  return loci;
}

/**
 * Segment one session's ordered events into merged divergence windows.
 * A window = [locus − kBefore, locus + kAfter]; overlapping windows merge.
 */
export function segmentWindows(
  events: TranscriptEvent[],
  opts: SegmentOptions = {},
): DivergenceWindow[] {
  const o = { ...DEFAULTS, ...opts };
  if (events.length === 0) return [];
  const loci = detectLoci(events, o);
  if (loci.length === 0) return [];

  const ranges = loci
    .map((locus) => ({
      locus,
      start: Math.max(0, locus.index - o.kBefore),
      end: Math.min(events.length - 1, locus.index + o.kAfter),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number; loci: Locus[] }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      last.loci.push(r.locus);
    } else {
      merged.push({ start: r.start, end: r.end, loci: [r.locus] });
    }
  }

  const sessionFile = events[0]!.anchor.sessionFile || "session";
  const base = basename(sessionFile);

  return merged.map((m) => {
    // Prefer a human-reaction locus as the anchor — higher-precision signal.
    const primary = m.loci.find((l) => l.kind === "human-reaction") ?? m.loci[0]!;
    const primaryEvent = events[primary.index]!;
    const winEvents = events.slice(m.start, m.end + 1);
    const cues = Array.from(new Set(m.loci.flatMap((l) => l.cues)));
    return {
      windowId: `${base}:${primaryEvent.anchor.line}`,
      anchor: primaryEvent.anchor,
      locusKind: primary.kind,
      startId: winEvents[0]!.anchor.id,
      endId: winEvents[winEvents.length - 1]!.anchor.id,
      cues,
      events: winEvents,
    };
  });
}
