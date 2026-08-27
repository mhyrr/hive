# Next and inbox lifecycle

**Status:** accepted 2026-08-24
**Date:** 2026-08-24
**Owners:** Greg and Maya

## Decision

The global inbox is not a useful queue. It mixes observations, repeated Act
proposals, and old notifications without a reader or a retention rule.

HIVE will give each output one owner:

- Observe writes a dated watch artifact. The dashboard folds that artifact into
  the briefing for the same date.
- A clamped Act watch upserts one structured slot per project in `next.json`.
  `hive next` lists every slot after it checks each live ticket again.
  `NO_SIGNAL` does not clear a slot.
- An Act watch that starts work records that disposition in that project's
  slot. It does not write an inbox notification. The private run remains the
  audit record.
- Project inboxes remain short-lived inputs to the nightly briefer.
- The global inbox stops accepting new writes. Its existing contents move to a
  dated archive once.

`hive next` answers one question: which ticket should an agent execute next,
per project? It does not replace `hive ticket ready`, which remains the
complete inventory.

## Safety rules

The nightly verifier records which project inbox bodies it used. Apply lands the
briefing before it clears any inbox. It clears an inbox only when its current
body still matches the recorded body. A concurrent write therefore survives for
the next briefing.

`hive next` never trusts model output alone. The selected ticket must still be
open, non-epic, above P0, free of `needs-greg`, unclaimed, unblocked, and have a
body. A stale record stays visible as unavailable until Act replaces it.

## Verification

- An Observe watch produces a dated artifact and appears with that day's
  briefing.
- An inbox-only project clears after its captured briefing lands.
- A briefing failure or changed inbox preserves the inbox.
- Consecutive Act proposals for the same project replace that project's slot.
  Other projects stay. A v1 singleton file migrates to a one-item v2 board.
- `hive next` rejects a ticket whose live state is no longer executable.
- No runtime path writes `~/.hive/inbox.md`.
