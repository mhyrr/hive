# Distributed HIVE — Design

**Status:** Draft
**Date:** 2026-04-26
**Author:** Maya (with Greg)
**Ticket:** TBD

## Summary

Run HIVE as a long-lived daemon on a home server, reachable from anywhere
via a messaging channel (iMessage primary, Telegram fallback during research),
exposing **a natural-language frontend over arbitrary HTTP APIs**. Each
integration — Sonos, thermostat, Hue, calendar, mail, finance, anything with
a callable surface — is a HIVE **project**. The daemon receives a message,
routes it to the right project, runs a stateless `claude --print` invocation
with the project's identity + tools + per-channel transcript, and replies on
the same channel.

The model intentionally mirrors the existing `heartbeat` pattern: stateless
per-message invocation, byte-stable cached prefix, continuity carried by
files on disk rather than a live process. Two daemons can run — one per
house — with shared identity but per-host project sets, so "ask the house"
works in either location with the same chat interface.

The strange priority — what distinguishes this from a generic LLM chatbot
plus tools: **the project is the unit of API surface, and HIVE is the only
runtime layer.** No orchestration framework, no agent framework, no
retraining. The project's `CLAUDE.md` describes the API in natural language;
typed HTTP clients live in the project's tool wrappers; HIVE supplies the
identity, memory, secrets, and the message loop. Adding a new API is a new
project, not a new system.

## Motivation

What's actually compelling here is broader than home automation. Every API
in life that's currently behind a clumsy app, an underfeatured assistant, or
a manual workflow can be wrapped in a project and reached by chat. Two
houses, multiple integrations per house, eventually personal data surfaces
(mail, calendar, finance, photos) — all on the same chat interface, all
extensible by adding a project directory.

The failure modes the design has to fix:

- **Initialization overhead per message.** A naive "spin up a fresh Claude
  Code session per inbound message" pays a 30K+ token system-prompt write
  every time. Without prompt caching, this is unaffordable at conversation
  cadence. With caching done right, it's near-free.
- **The "long-running session" trap.** The instinctive fix — keep one
  process alive and resume it — is exactly the architecture HIVE already
  killed in heartbeat (TK-024). Long-lived sessions break caching for
  reasons documented below.
- **Tool sprawl per project.** A daemon serving a dozen API integrations
  can't load every tool every time. The "how much to surface at any given
  moment" problem is real but is explicitly a *later* ticket; V1 ships
  per-project tool sets and accepts the limitation.
- **Secrets at rest.** Per-project credentials (Sonos OAuth, thermostat
  API keys) can't live in plain env vars on a network-reachable box.
- **Inbound auth.** A daemon reachable from the internet is the largest
  new attack surface in HIVE's history. Wrong defaults lose the house.

The success metric: **chatting from iPhone to "the house" works, and adding
a new API surface is one project directory plus one secrets file.**

## Non-Goals

- **Not a replacement for the local `hive` CLI.** Local CLI stays the
  primary interface for development work. The daemon adds a new entry path,
  not a substitute.
- **Not a multi-tenant SaaS.** This is Greg's personal infrastructure on
  Greg's personal hardware. No accounts, no billing, no sign-up flow. Family
  multi-user routing is a future possibility but explicitly not V1.
- **Not a tool router.** V1 ships per-project tools — the message routes to
  one project, that project's tools load, done. The harder "agent decides
  which project applies based on intent" problem is acknowledged and
  deferred (see Open Questions).
- **Not a streaming chat UX.** Replies are single messages on the channel.
  No partial tokens, no thinking-out-loud. If a task is long, the agent
  posts an ack and follows up.
- **Not LLM-judging-LLM.** The agent does interpretation; deterministic
  code does the API calls. Sharp boundary, per Greg's standing preference.

## Why Stateless `--print`: The TK-024 Evidence

The design hinges on this, so it gets receipts. The user's question — "can't
we just keep one session alive to skip the init overhead?" — was tried, and
the data is unambiguous.

### What was tried (pre-TK-024)

Heartbeat ran as a long-lived Claude Code session, resumed every 30 minutes
via `--resume`. Goal: avoid paying the system-prompt cost every tick.

### What actually happened

From the TK-024 commit body (`704a068`, 2026-04-06), measured on Opus 4.6:

> One 48-hour session burned **6.8M cache-write tokens across 88 ticks** while
> the prefix grew from **25K to 97K** tokens.

Two compounding causes:

1. **The system prompt mutated between ticks.** Identity file regenerated,
   reflections window rolled, `_index.md` rebuilt. Each mutation invalidated
   the cached prefix — every tick was effectively a cold start.
2. **The conversation grew unbounded under `--resume`.** Each tick appended
   the prior turn's tool calls, output, and reflection to the conversation.
   The prefix monotonically grew toward the context limit.

The naive "long-running session" model isn't slightly worse than stateless —
it's the dominant cost. 6.8M cache-write tokens on Opus 4.6 list pricing is
non-trivial money for a system that was supposed to be free of per-tick
overhead.

### What replaced it

Stateless: each tick is a fresh `claude --print`, no `--resume`, no
`--session-id`. Cross-tick state moved to files on disk (`inbox.md`, git,
ticket store, dispatch run records) and is read by the agent on its first
turn.

`assembleHeartbeatIdentity()` is **byte-stable across ticks** — only the
SOUL/IDENTITY/SELF/AGENTS/TRUST stack plus the reflection protocol. No
reflections (mutate), no project memory index (mutates).

The variable per-tick payload (timestamp + context brief) is written to
`~/.hive/projects/<id>/.tick-brief.md` and the agent reads it on its first
turn — so the *user message* itself is also byte-stable, because Claude
Code's cache breakpoint sits after the user message and any variable
content there invalidates the whole cached prefix.

### Results

> Per-tick prefix stabilized at ~34K, no growth. Within-tick caching still
> works. ~55% reduction in per-session cost.

Cross-tick cache reuse remained partially blocked by a two-token jitter in
Claude Code's persisted prefix that suggests Claude Code injects
per-invocation content the user can't see (tracked in TK-029, still open).
**For the distributed-HIVE daemon this is mostly moot** — the daemon owns
the full payload it sends to Anthropic and can guarantee byte-stability
end-to-end. V1 cache verification on the Pi harness already confirmed
**99.7% cross-session cache hit rate** with a 21K-token static prefix
(see hive memory `pi caching v1` — Sonnet 4.6, run 1 cacheWrite=4925,
run 2 cacheRead=4913, cost dropped from $0.0186 → $0.0016 — 91% lower on
the cached run).

### The model for distributed HIVE

Same shape as heartbeat. Per-message:

1. Compose a **byte-stable** prefix: SOUL stack + project memory snapshot
   + project tool descriptions + per-channel transcript-so-far. This is the
   cached block. ~30-50K tokens.
2. Append the **variable** suffix: just the new inbound message text. A few
   dozen tokens.
3. Run `claude --print` with the prefix as `--append-system-prompt-file` and
   the message as the user turn.
4. Parse the reply, send it on the channel.
5. Append `(user_msg, assistant_reply)` to the per-channel transcript file
   on disk. Next message's prefix includes it.

Continuity is real — the agent sees the conversation history. But the
process is stateless and the cache stays warm. The transcript file gets
summarized periodically (heartbeat-style) when it grows past a threshold,
to keep the cached prefix from drifting upward.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  iPhone (iMessage) ──┐                                          │
│  Telegram client  ───┤                                          │
│                      │                                          │
│                      ▼                                          │
│              ┌──────────────────┐                               │
│              │  Transport       │  iMessage relay or Telegram   │
│              │  Adapter         │  webhook → JSON (text+chat_id)│
│              └────────┬─────────┘                               │
│                       │                                         │
│                       ▼                                         │
│              ┌──────────────────┐                               │
│              │  hive serve      │  HTTP listener, auth, route   │
│              │  (daemon)        │  chat_id → project            │
│              └────────┬─────────┘                               │
│                       │                                         │
│                       ▼                                         │
│              ┌──────────────────┐                               │
│              │  Per-project     │  CLAUDE.md, tools/, secrets,  │
│              │  exec context    │  transcript-<chat_id>.md      │
│              └────────┬─────────┘                               │
│                       │                                         │
│                       ▼                                         │
│              ┌──────────────────┐                               │
│              │  claude --print  │  byte-stable prefix +         │
│              │  (stateless)     │  variable user message        │
│              └────────┬─────────┘                               │
│                       │                                         │
│                       ▼                                         │
│              ┌──────────────────┐                               │
│              │  HTTP API calls  │  Sonos, thermostat, etc.      │
│              │  (deterministic) │                               │
│              └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

### Components

- **Transport adapter** — One process per channel. iMessage requires a Mac
  + a relay (BlueBubbles/sendblue/Beeper-style); Telegram is a webhook
  receiver. Both normalize to `{channel_id, chat_id, sender_id, text,
  attachments, timestamp}` and POST to the daemon.
- **`hive serve`** — Long-lived daemon. HTTP listener (likely on localhost,
  fronted by Cloudflare Tunnel or Tailscale Funnel — see Transport
  section). Holds the routing table, secrets, and transcript files. On
  inbound: auth → route → exec → reply.
- **Per-project exec context** — A directory at `~/.hive/projects/<name>/`
  containing `CLAUDE.md` (project description and conventions), `tools/`
  (typed HTTP clients exposed as MCP tools or Skills), `secrets.env`
  (encrypted at rest), `transcripts/<chat_id>.md` (per-channel rolling
  transcript), `index.md` (project memory).
- **Stateless executor** — Same shape as `dispatch` and `heartbeat`. Builds
  the byte-stable prefix, shells `claude --print`, returns the result.

### What's reusable from existing HIVE code

| Existing | Reuse for |
|----------|-----------|
| `assembleHeartbeatIdentity()` | Byte-stable prefix construction |
| `src/commands/dispatch.ts` shell-out logic | The executor |
| `~/.hive/projects/<name>/` layout | Project directory shape |
| `inbox.md` pattern | Per-channel transcript pattern |
| Memory subsystem | Project memory in the prefix |
| Auth/redaction patterns from `sessions.ts` | Inbound message redaction |

The daemon is roughly: existing dispatch internals + an HTTP listener +
a routing table + an outbound reply channel. Estimated ~600-1000 lines for
V1, no fork of existing CLI.

## Project Shape: API Surface as Project

Every API integration is a HIVE project. The project structure already
supports this — V1 just formalizes the conventions for "API surface" projects
specifically.

```
~/.hive/projects/sonos/
├── CLAUDE.md              # Natural-language project description
├── memory/
│   └── _index.md          # Standard HIVE project memory
├── tools/
│   ├── play.ts            # Typed HTTP client → Sonos API
│   ├── pause.ts
│   ├── volume.ts
│   └── manifest.json      # Tool descriptions for the prefix
├── secrets.env            # Encrypted at rest, 0600
├── transcripts/
│   ├── greg-iphone.md     # Per-channel rolling transcript
│   └── living-room-pi.md
└── chat_routes.json       # Channels that route here
```

### `CLAUDE.md` for an API project

The conventions in this file are what the agent reads to know what's
possible. Example shape:

```markdown
# Sonos

## What this project does
Control the Sonos system at the home (kitchen, living room, office, master).

## Devices
- Living Room — primary speaker, default for "play music"
- Kitchen — paired with Living Room by default; "kitchen only" unpairs
- Office — Greg's workspace; "play in office"
- Master — bedroom; "bedroom" or "upstairs"

## Common asks
- "Play [artist/album/playlist]" → search Sonos favorites first, then Spotify
- "Volume up" / "louder" → +10%
- "Pause" → pause active group
- "What's playing?" → return current track

## Constraints
- Only Greg's account is authorized
- Volume hard cap at 75% to avoid waking the kids
```

This is the *prompt*, not config. It loads into the cached prefix. The
agent reads it the same way it reads `SELF.md`.

### Tools as the deterministic layer

`tools/*.ts` files are typed HTTP clients exposed via the MCP tool surface
the agent already has. The agent decides *what* to do; the tools execute
*how*. No business logic in the agent, no LLM judgment in the tools.
Standard HIVE doctrine.

### Adding a new API

1. `hive project add <name> --type api`
2. Write `CLAUDE.md` describing the surface in natural language
3. Drop typed HTTP clients into `tools/`, register them in `manifest.json`
4. `hive secrets set <name> KEY=value` (writes to encrypted `secrets.env`)
5. `hive route add <chat_id> <project>`

That's it. No daemon restart, no reload command — projects load lazily on
the first message that routes to them.

## Transport: iMessage Primary, Telegram for Research

Greg's preference is iMessage from iPhone. The honest answer is **the
transport is the part that needs research before the daemon design can
finalize**. Two viable paths:

### Path A: iMessage relay on a Mac

Requires a Mac mini (one per house) running a relay that bridges
iMessage → HTTP. Options:

- **BlueBubbles** — open-source, server runs on macOS, exposes a REST API
  and webhook for inbound. Stable, free, requires Mac.
- **Beeper Cloud / sendblue** — commercial relays. Cleaner but external
  service in the loop, monthly cost, third party sees message contents.
- **AppleScript / `osascript` + Messages app DB polling** — DIY, fragile,
  breaks on macOS upgrades.

The Mac is already needed at each house anyway (it's the daemon host).
**Tentative recommendation: BlueBubbles**, but Path A's research is part of
the V1 ticket scope.

### Path B: Telegram during research

Free, instant, no Mac required, works on any phone, webhook is one curl
command. Less native than iMessage on iPhone but **a perfectly good
research vehicle while iMessage is being figured out.** V1 ships with
Telegram working end-to-end and iMessage as a parallel transport adapter
slotting in once the relay choice is made.

Both transports normalize to the same internal `{chat_id, text, ...}`
payload. The daemon doesn't care which channel a message came from — only
that it was authenticated and routes to a known project.

### Network exposure

The daemon listens on localhost. Public reach happens via:

- **Cloudflare Tunnel** (free tier, no inbound port open, mTLS optional,
  WAF available) — recommended.
- **Tailscale Funnel** (free for personal use, simpler model, ties to
  Tailscale identity).
- **Direct port + Caddy + Let's Encrypt** — possible, but the configuration
  surface is bigger and one mistake is one Shodan listing away from a
  problem.

**Tentative recommendation: Cloudflare Tunnel.** Final choice gated on the
research ticket.

### Inbound auth

- Per-channel HMAC on the webhook (Telegram supports this natively;
  iMessage relay supports it via configuration).
- Allowlist of `chat_id`s permitted to reach a given project.
- Daemon-level rate limit (per `chat_id` and global) — even on a tunnel,
  abuse from an authorized but compromised channel is a real failure mode.

## Per-Channel Transcript: How Continuity Works

The mechanism that makes "this feels like a chat" without breaking caching:

```
~/.hive/projects/<name>/transcripts/<chat_id>.md
```

Append-only. Format:

```markdown
[2026-04-26 14:03] user: play something chill in the kitchen
[2026-04-26 14:03] assistant: Queued "Bon Iver Radio" on Kitchen + Living
  Room. Volume at 35%.

[2026-04-26 14:18] user: just kitchen
[2026-04-26 14:18] assistant: Unpaired. Now playing in Kitchen only.
```

The transcript is included in the cached prefix on the next inbound message.
Because the prefix structure is deterministic (transcript appended below a
stable marker), the cache hits up to the most recent reply. Only the new
user message at the suffix is uncached.

### Keeping the cache hot as transcripts grow

Two-tier strategy:

1. **Recent-window** — the last N exchanges (e.g. 30) live in the transcript
   file verbatim.
2. **Summary head** — older exchanges get summarized into a single block at
   the top of the transcript on a heartbeat-style cadence (rotation when
   transcript exceeds threshold). Summary is byte-stable until the next
   rotation, so it caches cleanly between rotations.

This is the same shape as the existing memory consolidation pipeline, just
applied per-channel. Steal the code path; don't reinvent it.

## Multi-Host Topology: Two Houses

Greg has two houses. The vision is one chat experience that works in either
location with house-specific projects.

### Per-host projects, shared identity

Each daemon (one per house) runs the same SOUL/IDENTITY/SELF stack — Greg's
single identity layer travels with the chat — but ships a different project
set tuned to that house's devices.

```
House A daemon: sonos-a, thermostat-a, hue-a, garage-a, ...
House B daemon: sonos-b, thermostat-b, ...
Both:           calendar, mail, finance, weather (data projects, host-agnostic)
```

### Routing a message to the right house

The chat addresses a daemon, not a house directly. Two viable schemes:

- **Per-channel daemon** — separate Telegram bots / iMessage chats, one per
  house. "House A" is one chat; "House B" is another. Simplest.
  Recommended for V1.
- **One channel, command prefix** — `@a` / `@b` prefix routes within a
  single chat. More elegant, but failure mode (sending the right command to
  the wrong house) is bad enough that V1 picks separate channels.

### Identity sync between hosts

`~/.hive/{SOUL,IDENTITY,SELF,AGENTS,TRUST}.md` and `OVERRIDES.md` should be
identical between hosts. Sync via:

- A git repo (private) that both daemons pull on a schedule.
- A `hive sync` command that pushes/pulls identity + selected project
  memory between known hosts.

V1 picks **git pull on a heartbeat schedule.** Simple, auditable, and the
identity stack already lives in this shape.

## Secrets

Per-project credentials must be encrypted at rest, scoped to project,
loadable by the daemon process at message-handling time without prompting.

### V1 approach: age + master passphrase

- `~/.hive/projects/<name>/secrets.env` is age-encrypted (mode 0600).
- Daemon loads master passphrase at startup (via systemd credential, macOS
  keychain via `security find-generic-password`, or interactive prompt at
  boot).
- Per-message: daemon decrypts the project's secrets into the executor
  environment for that one invocation.
- Secrets never appear on disk in plaintext, never log to stdout, never
  appear in transcripts (redaction patterns from `sessions.ts` extend to
  cover per-project secret values).

### What V1 doesn't do

- No HSM, no hardware key, no per-secret rotation policy. Greg's threat
  model is "compromised home network and lost laptop," not "nation-state
  adversary."
- No per-message secret request to the user. The daemon has the keys.

## First Slice — Research + V1 Ticket

The V1 ticket has two phases. **Phase 1 is research, gating Phase 2.**

### Phase 1: Transport research (1-2 days)

Concrete deliverables, written as a follow-up doc in `docs/specs/`:

1. **iMessage relay choice.** Trial BlueBubbles end-to-end on a Mac.
   Document setup, reliability over 24 hours, attachment handling, group
   chat behavior. Compare against Beeper API.
2. **Tunnel choice.** Stand up Cloudflare Tunnel and Tailscale Funnel side
   by side. Document setup time, observability, latency, and the failure
   modes for each.
3. **Inbound auth pattern.** Concrete HMAC scheme for Telegram + iMessage
   relay. Test rotation. Document the threat model.
4. **Decision doc.** One page picking the V1 stack. Greg signs off before
   Phase 2 starts.

### Phase 2: V1 daemon (3-5 days after Phase 1)

1. `hive serve` skeleton — HTTP listener, auth middleware, routing table.
2. Telegram adapter end-to-end (research vehicle).
3. Stateless executor reusing `dispatch` internals + per-channel transcript.
4. One project: `home-automation` with two devices working (Sonos + Hue, or
   Sonos + thermostat — whichever is simpler to get an OAuth token for).
5. age-based secrets loader.
6. Cloudflare Tunnel deployment.
7. iMessage adapter (BlueBubbles) — or deferred to V1.5 if Phase 1 says so.

### What's explicitly *out* of V1

- Multi-host sync (one daemon, one house, V1).
- Family multi-user routing.
- Tool router / surface management (the "how much to load" problem).
- Streaming replies, attachments, voice.
- Web dashboard for inbound traffic.

## Open Questions

1. **The "how much to surface" problem.** A daemon serving 20 API projects
   can't load every tool every time. V1 sidesteps by routing one chat to
   one project, but the natural evolution is "the daemon decides which
   project applies based on intent." This is hard. Cheap classifier on
   inbound? Skill-style trigger conditions? Council of project-routers?
   Genuinely unsolved. Tracked separately, blocks V2.
2. **Transcript summarization cadence.** When does a transcript rotate?
   Every N exchanges, every M tokens, every X days, on idle? Whichever it
   is, the rotation event has to leave the cached prefix byte-stable until
   the next rotation. Worth a small experiment.
3. **iMessage relay reliability.** BlueBubbles depends on the Messages app
   on macOS, which Apple changes without warning. What's the recovery
   pattern when a macOS update breaks the relay? Probably a heartbeat-style
   liveness check + a Telegram fallback for "the house is unreachable, here
   is your house notification."
4. **Per-house identity drift.** If both houses run the same SOUL stack but
   one daemon's project memory accumulates faster, the cached prefix
   diverges. Probably fine — project memory is per-host already — but worth
   confirming the shared SOUL/IDENTITY blocks stay byte-stable.
5. **Anthropic ToS posture for daemon-driven inference.** The same open
   question already in HIVE memory under `pi subscription auth` — does a
   subscription OAuth account permit programmatic use through a non-Claude-
   Code harness? If yes, the daemon is cheaper. If not, the daemon uses an
   API key. Daemon design is identical either way; cost model differs.

## Appendix: Project Ideas Beyond Home Automation

The ones that fall out for free once `hive serve` exists. Not commitments —
candidates for the eventual project portfolio.

- **Coding-from-phone** — dispatch into real repos on the home box from
  anywhere. The daemon already speaks `dispatch`.
- **Morning briefing** — heartbeat already runs recurring; add mail +
  calendar + RSS readers + a push to the chat channel.
- **Personal RAG** — ingest mail, notes, browser history into project
  memory; query in chat.
- **Always-on watcher** — heartbeat + rules ("tell me when X happens") with
  push notifications.
- **Family shared agent** — multi-user routing on the same daemon, per-user
  memory slot. Requires the multi-user work explicitly out of V1.
- **Finance** — read-only Plaid, alerts on unusual activity. Strong threat
  model required.
- **Photos** — ingest from Photos app, tag and search via chat. iCloud is
  the integration headache.
- **Travel** — flight + hotel + calendar joins; "what's my next trip" and
  "shift the rental car by an hour" both work.

The unifying observation: anything with an HTTP API and a clumsy app is a
candidate. The daemon's value isn't the API integrations — it's making the
natural-language interface universal across them.
