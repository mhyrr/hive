# Forgetting: what canon holds, what it costs, and a rule for letting go

TK-165 · 2026-11-23 · design, not a build. Nothing in `~/.hive/memory` was changed.

## The answer

Canon is mostly good knowledge that nobody searches for. A hand check of 30
random matreas entries found 23 useful, 4 trivia and 3 stale. Recall cannot
tell the useful entries from the others. 68% of matreas has never been returned by a search,
and 12 of the 23 useful sampled entries are in that 68%. Any rule that archives
by disuse would mostly archive good knowledge.

The cost Greg asked about comes from a different place. Pass V reads a
project's **whole** canon on every night that project has candidates. That
makes V's input grow with the canon, not with the day's work. An offline replay
shows that V does not need the whole canon. For 97% (matreas) and 99% (revrec)
of the supersede and merge decisions V actually made, the target entry was among
the 20 entries that BM25 ranks closest to the candidate. Taken together, the 20
nearest entries of every candidate on a night cover a median of 46% of matreas
canon and 24% of revrec canon (28% and 22% since 2026-10-23).

Recommendation, in order of weight:

1. **V reads each candidate's 20 nearest canon entries, not the whole canon.**
   This fixes the cost and stops canon growth from driving V's size.
2. **Forgetting rule: retire on evidence, never on disuse.** Give V a `retire`
   action for the neighbor entries it already sees. V retires an entry when that
   night's evidence shows it stale, contradicted, or trivia. Retired entries move
   to `archive.md`. Search still finds them; V and the index do not read them.
3. **Move superseded lines to `archive.md`.** They are already invisible to V.
   This is file hygiene only.

The real caveat: entries in areas nobody works on are never shown to V, so they
are never retired. Under (1) they also cost nothing, so this is acceptable. Stale
facts in quiet areas can still mislead a session that finds them by search.

## 1. What canon costs

Pass V spent **$91.49 over the 30 nights** from 2026-10-23 to 2026-11-23 (all
passes: $234.99). V read 15.6M input tokens at an effective **$4.96 per million**.

| project | active entries | V canon KB | ≈ tokens | V nights / 30 | ≈ canon tokens / 30 nights |
|---|---:|---:|---:|---:|---:|
| matreas | 789 | 461 | 143k | 14 | 2.00M |
| revrec | 631 | 412 | 128k | 20 | 2.56M |
| hive | 426 | 229 | 71k | 12 | 0.85M |
| dobby | 292 | 190 | 59k | 4 | 0.23M |
| cryptics | 300 | 180 | 56k | 13 | 0.72M |
| investing | 186 | 112 | 35k | 7 | 0.24M |

"V canon KB" is the JSON that `serializeProjectCanon` sends (active entries only,
with hash and tags). Tokens use verify.ts's measured 3.31 chars/token. "V nights"
counts nights with a `candidates.B.<p>.json` or `candidates.consumed.<p>.md`
artifact. Since TK-137, a project gets a V call only on those nights.

These six canons account for about 6.6M of V's 15.6M input tokens, or roughly
**$33 a month**. That is an upper bound, because I used today's canon size for
nights when it was smaller. The money is modest. The bigger problem is growth:
matreas admitted 429 entries in October, and each one is read on every later V
night. That growth is why TK-164 needs a 1M window.

## 2. How recall is counted, and whether to trust it

Three writers touch `_meta.json` (`src/lib/memory.ts`):

| path | what it does | when |
|---|---|---|
| `searchMemory` → `bumpRecall` (`memory.ts:292`) | `recallCount += 1`, `lastRecalled = today`, half-life +7 days (cap 90) | every entry **returned** by `search_memory`, `hive memory search`, or `decompose_goal`'s memory probe |
| `rebuildIndex` → `bumpRecallDamped` (`memory.ts:303`) | `recallCount += 0.25`, `lastRecalled = today`, half-life +1 day | every entry **displayed** in `_index.md`, on every nightly rebuild of a project whose canon changed (`apply.ts:583`) |
| `createEntryMeta` (`memory.ts:280`) | new row, `recallCount 0` | on admission (append, supersede) |

Pass V reads, `read_hive_memory` dumps, and the dedupe probe in `reflections.ts`
(`noBump: true`) do not count.

`recallCount` is a weak value signal, for five reasons:

1. **Search is rare.** The transcripts on disk (early October onward) hold about
   26 `search_memory` calls aimed at matreas, and each call returns at most 10
   entries. At that rate, most entries are never returned whatever their value.
2. **It counts "was returned," not "was used."** One search bumps up to 10 entries.
3. **Index bumps reinforce themselves.** Entries shown in the index gain strength
   every night, so they stay in the index. They also get a fresh `lastRecalled`,
   which makes them look recently used.
4. **Legacy inflation.** Before 026b7ba (2026-08-17), one search bumped every
   entry with a BM25 score above zero, up to 162 entries per search. Older
   entries in revrec, hive and investing carry this inflation (revrec: 242
   entries at `recallCount ≥ 10`).
5. **Coverage gaps.** 66 revrec entries (10%) and 93 hive entries (22%) have no
   meta row, so no recall is ever recorded for them. There are also 47 and 46
   orphan meta rows. The bump code skips entries without meta.

`recallCount == 0` is the most reliable reading. It means no search returned the
entry and it never earned an index slot. It does not mean the entry is worthless
(see §3).

### The counts

Each cell gives entries, share of active entries, and (where marked B) share of V
canon bytes. "Silent N" (used in §6) means older than
N days and no recall of either kind in N days. `createdAt` is the admission
date. matreas sidecar dates start at 2026-08-30, although some entry texts cite
August 10. The earliest matreas `createdAt` values may therefore be later than
the real admission (cause unverified).

| project | never recalled | never recalled, age > 30d | not recalled 30d | not recalled 60d | not recalled 90d | no meta |
|---|---|---|---|---|---|---|
| matreas | 539 · 68% · 67% B | 486 · 62% · 60% B | 683 · 87% | 565 · 72% | 539 · 68% | 1 |
| revrec | 255 · 40% · 38% B | 191 · 30% · 30% B | 485 · 77% | 359 · 57% | 331 · 53% | 66 |
| hive | 102 · 24% · 26% B | 67 · 16% · 18% B | 260 · 61% | 258 · 61% | 241 · 57% | 93 |
| dobby | 190 · 65% · 65% B | 186 · 64% · 64% B | 258 · 88% | 242 · 83% | 196 · 67% | 1 |
| cryptics | 236 · 79% · 78% B | 162 · 54% · 54% B | 254 · 85% | 240 · 80% | 236 · 79% | 0 |
| investing | 48 · 26% · 26% B | 25 · 13% · 13% B | 146 · 79% | 143 · 77% | 129 · 69% | 7 |

The "not recalled" columns include the never-recalled entries. Entries with no
meta row are left out of every column except the last.
matreas and cryptics canons are under 90 days old, so their 90-day columns equal
"never recalled."

## 3. A hand-checked sample: 30 matreas entries

Seeded random draw (`random.seed(165)`) from the 789 active entries. I read each
one and checked 10 against `~/work/matreas` (marked ✓).

| # | hash | type | recalls | class | note |
|---:|---|---|---:|---|---|
| 1 | 623c82cb | fact | 3 | useful | soft-credit model |
| 2 | d37e29ec | fact | 22 | useful | browser-verification recipe (contains dev login credentials) |
| 3 | 34d74c10 | decision | 0 | useful | ✓ `campaign_goals` table exists |
| 4 | c8b856a8 | fact | 0 | useful | GitHub-handle etiquette for a client contact |
| 5 | 695ad48d | fact | 9 | **stale** | ✓ `.gitignore` is now `/tasks/`; the lint task is no longer ignored |
| 6 | f6fae174 | convention | 0 | useful | scope LiveView test selectors |
| 7 | 4041a020 | fact | 0 | useful | do not compile dev during eval |
| 8 | 3ce481c1 | fact | 0 | useful | RE7 column prefixes |
| 9 | f27da0d5 | fact | 0 | trivia | one-off credo rename incident |
| 10 | ffa034b3 | decision | 8.25 | useful | DAF grants never carry a receipt |
| 11 | aa5b7d50 | fact | 0 | useful | ✓ `search_names`, fuzzy threshold 0.5 |
| 12 | 72a99491 | decision | 0 | useful | ✓ endowment tables exist |
| 13 | d18e7d8f | convention | 0 | useful | test setup convention |
| 14 | 83b61b04 | fact | 1 | useful | Playwright `.fill()` on combobox |
| 15 | 3134b68e | fact | 11 | useful | ✓ `receipt_sent: true` set in `issue_receipt` |
| 16 | 94124af9 | fact | 0 | trivia | ✓ dead-link incident, fixed; code comment records it |
| 17 | 1696546f | decision | 22.25 | useful | Gift Entry sequencing; ✓ TK-375 still open |
| 18 | 11dd0591 | fact | 6 | **stale** | ✓ says RE-style campaigns are unbuilt; `create_campaign_tree` migration landed 2026-10-27 |
| 19 | 4314b9e1 | decision | 0 | useful | memo fund wins over pledge |
| 20 | c489627b | fact | 0 | **stale** | ✓ Dockerfile is now Elixir 1.19.4 / OTP 28.5, not 1.17.3 / 27.2.4 |
| 21 | d03e5a19 | decision | 26.75 | useful | per-section settings access |
| 22 | 0fbc6fef | fact | 0 | trivia | ✓ refutes one audit claim; cited line `credit.ex:599` has drifted |
| 23 | 3645de0b | fact | 56 | useful | RENXT export format |
| 24 | 7044969a | decision | 0 | useful | ✓ `PledgeRevision` requires a reason to lower a pledge |
| 25 | d65f72e7 | convention | 0 | useful | how to add record history |
| 26 | df063d18 | fact | 2 | useful | wealth-screening vendor research |
| 27 | 4aa71277 | decision | 0.5 | useful | ✓ harbor colour `#2B7A95` still in Tailwind config |
| 28 | 3dd6ecc5 | fact | 13 | useful | ✓ `remove_captured` exists (moved to `test/support/ai/evals/runner.ex`) |
| 29 | 95535d4b | fact | 0 | trivia | generic subagent reflection, misfiled in matreas |
| 30 | cea0dfdc | convention | 0 | useful | `<details>` loses `open` on re-render |

**Totals: 23 useful (77%), 4 trivia (13%), 3 stale (10%), 0 superseded.** With
n = 30, the 95% interval for "trivia or stale" is about 12%–41%.

Recall against value:

- 17 sampled entries were never recalled: 12 useful, 4 trivia, 1 stale.
- 13 were recalled: 11 useful, 2 stale.
- Two of the three stale entries had been recalled (9 and 6 times). Recall kept
  them alive. Nothing in the pipeline re-checks a claim against the code.

One more finding: entry #2 holds a dev login and password in plain text, and V
reads it every night. It is a dev seed, not a production secret. It still should
not be in canon.

## 4. Duplicates

Token-set similarity over all active-entry pairs: Jaccard ≥ 0.35 or containment
≥ 0.6, with at least 8 shared content words.

| project | strict pairs | loose pairs (J ≥ 0.22 or C ≥ 0.45) | redundant entries (loose) |
|---|---:|---:|---:|
| matreas | 0 | 6 | 6 (0.8%, 2 KB) |
| revrec | 3 | 9 | 9 (1.4%, 2 KB) |

Most loose pairs are related, not duplicate. Examples: two different "Greg
declined" precedents, or a fact paired with the open question it raised. Real
restatements are few. revrec has `AccountKeys` stated once as a fact and once as
a decision, and the `maybe_` prefix rule stated twice. matreas has three
paraphrases of one Pass C finding, which is also misfiled: it belongs to hive.

Duplicates are rare because V blocks them at the door. V rejected **199 matreas
candidates and about 180 revrec candidates as duplicates**, and merged 81 and 40
more into existing entries. That gate depends on V seeing the matching entry.
Any change to what V reads must keep the matching entry in view (§6).

Paraphrases with different vocabulary would escape this scan. I did not pay for
an embedding or LLM pass to find them.

## 5. How entries leave canon today

There is exactly one exit:

- **Supersede** (V, `supersedeEntryByHash`, `memory.ts:768`). The old line stays
  in `knowledge.md` as `~~text~~ → superseded DATE`. V, search, and the index all
  skip it. matreas has 43 such lines (19 KB) and revrec has 33 (18 KB). They cost
  V nothing.

Everything else adds or keeps:

- **Merge** adds tags to an existing entry and drops the candidate. Tag lists
  grow; entry #2 now carries 14 tags.
- **Reject** keeps a candidate out. It never removes an existing entry.
- **Decay** (2026-04-12 decision) lowers search rank only.
- `supersedeEntry` (by text, `memory.ts:658`) has no callers outside tests.
  There is no forget, archive or delete command.

So canon grows by every accept, and the only way out is a better version of the
same fact arriving. A fact that goes stale without a successor stays forever.
This is how entries #5, #18 and #20 survived.

## 6. Options, with the cut each would make

The "sample cut" column shows what each rule removes from the 30 hand-classified
entries.

| option | matreas cut | revrec cut | sample cut (matreas) | what is lost |
|---|---|---|---|---|
| **A. Archive never-recalled, age > 30d** | 486 entries · 275 KB (60%) | 191 · 122 KB (30%) | 14: **10 useful**, 3 trivia, 1 stale | Most of the domain decisions (memo-fund rule, pledge revisions, endowments). V can no longer dedupe against them. |
| **B. Archive silent 60d** | 160 · 86 KB (19%) | 218 · 146 KB (36%) | 7: 4 useful, 2 trivia, 1 stale | Same kind of loss, smaller. At matreas's October pace (~14 admissions a day), 60 days of admissions is about today's whole canon, so this caps growth but does not shrink matreas. |
| **C. Size budget 150 KB, keep by strength** | 546 · 311 KB (68%) | 437 · 262 KB (64%) | 17: 13 useful | Arbitrary. Strength is mostly recency plus index stickiness. |
| **D. Merge duplicates** | ~6 · 2 KB | ~9 · 2 KB | 0 | Almost nothing. V already does this on entry. |
| **E. Tombstone superseded** | 43 lines · 19 KB of file | 33 · 18 KB of file | 0 | Nothing. Saves nothing in V, which already skips them. |
| **F. V reads top-20 neighbors per candidate** (recommended) | median 46% of canon read per night (since 10-23: 28%; max 80%) | median 24% (since 10-23: 22%; max 54%) | 0 (nothing leaves canon) | 3% (matreas) and 1% (revrec) of past supersede/merge targets fell outside the top 20. Each miss means a possible duplicate or a missed supersede. |
| **G. Retire on evidence** (recommended rule) | unknown until it runs; sample suggests up to ~23% eventually (12%–41%) | same | only entries V sees next to today's evidence | V could retire a useful entry. It stays in `archive.md` and search still finds it, so restore is one move. |

### F in detail: the replay

For every past V decision that cited a `target_hash` (supersede or merge), I
ranked the canon of that night against the candidate text with the repo's own
`buildCorpus` and `bm25Score`. I used text only; tags were left out because
merges add the candidate's tags to the target. The canon of a night was
approximated as entries with `createdAt` before the run date.

| project | decisions tested | target in top 5 | top 10 | top 20 |
|---|---:|---:|---:|---:|
| matreas | 143 | 87% | 92% | **97%** |
| revrec | 88 | 91% | 95% | **99%** |

With tags included the numbers are 91/96/98 and 93/97/100. That run is biased in
BM25's favor, for the reason above.

The read size scales with the day's candidate count. matreas nights with 30–45
candidates read 50–70% of canon at k = 20. Nights with fewer than 10 candidates
read under 20%. The per-night table is in the appendix.

The replay covers only decisions that cite a target. Duplicate rejects cite none,
so they could not be tested directly. They rely on the same "V sees the match"
mechanism. Before switching, run V in shadow mode for a week on both inputs and
compare its decisions.

### G in detail: the rule

> An entry leaves canon when the verifier, holding that night's evidence,
> judges it stale, contradicted, or trivia. It never leaves for lack of use.

Mechanics, for a later ticket:

- Add `retire` to `DECISION_RULES`, targeting a neighbor hash with a reason from
  {stale, contradicted, trivia, misfiled}. Retire works only on entries that are
  in V's input that night, which F already bounds.
- `apply.ts` moves a retired line to `archive.md` with `→ retired DATE: reason`.
  Superseded lines move there too (option E).
- `search_memory` searches `archive.md` with the same ranking, and labels a hit
  as archived. The index and V never read the archive.
- Directive entries (TK-123) can be retired only as `contradicted`, never as
  `trivia`.
- Nothing is deleted. `hive memory restore <hash>` moves a line back.

Retire-on-evidence does not need a recall signal. It acts only where the day's
work gives V something to judge with. Sample entry #18 says RE-style campaigns
are "unbuilt." On 2026-10-27, the night the campaign redesign arrived as
candidates, BM25 ranked #18 first or second for four of them (checked with
`scripts/probe18.ts`). V read the whole canon that night, so it saw #18, and it
left the entry alone. Today V has no action for "this is now false" unless a
candidate replaces it. With `retire`, that night was the moment to act. Whether
V would have used it is unverified.

### What I would not do

- Archive by recall (A, B, C). The sample shows that a recall-based cut throws
  away about three useful entries for each junk entry it removes.
- Make the recall signal smarter first. Search is too rare for any recall rule
  to carry much information in matreas or cryptics. Fix the counters (below) for
  ranking, not for forgetting.

## 7. Smaller fixes found on the way

- Keep search recalls and index bumps apart. Store `searchRecalls` and
  `lastSearched` next to the existing fields, and stop index rebuilds from
  setting `lastRecalled`. Today an index slot looks like use.
- Backfill meta rows for the 66 revrec and 93 hive entries that have none, and
  drop the orphan rows.
- Remove the dev credentials from matreas entry `d37e29ec`.
- About 5–9% of matreas and revrec entries mention hive's own pipeline (regex,
  noisy, not hand-checked). Entry #29 and the Pass C paraphrases are clear
  cases. Pass B or V should file those under hive.

## 8. One-time sweep (optional, paid)

F and G stop growth and clean the areas that are under active work. They never
reach stale entries in quiet areas. A one-time text-only sweep with Opus would
flag dated snapshots, trivia and misfiled entries, at roughly 150k input tokens
per large project, or about $1–2 per project at $4.96/M. It cannot check claims
against code; that needs an agent with repo access and costs more. This needs
Greg's go.

## Method and what was checked by hand

- All numbers come from copies of `knowledge.md`, `_meta.json` and `_index.md`
  taken 2026-11-23, parsed with the repo's own `readProjectMemorySnapshot` and
  `serializeProjectCanon`. Two `search_memory` calls on hive during research
  bumped up to 14 hive entries before the snapshot. No matreas or revrec
  searches were run.
- Checked by hand: the 30-entry classification; the 13 ✓ claims against
  `~/work/matreas`; the dedupe pairs listed in §4; V's prompt and canon
  serializer in `verify.ts`; the bump paths in `memory.ts` and `apply.ts`.
- Computed and not hand-checked: per-project recall shares, the cost split by
  project (upper bound), the F replay, and the hive-internal share in §7.
- The transcript count of `search_memory` calls covers only transcripts still
  on disk (early October onward).
- Scripts: `~/.comb/agents/hive-tk-165-memory-audit/scripts/`
  (`measure.ts`, `cuts.py`, `dupes.py`, `neighbors.ts`, `union.ts`, `vcost.py`,
  `searches.py`, `classes.py`, `probe18.ts`).

## Appendix: neighbor read per night

For each night with candidates since 2026-10-01: candidate count, the canon that
night (entries / KB), then the distinct entries and KB that the top-k neighbors
of all candidates cover, with their share of canon bytes.

```
matreas
2026-10-01 cands= 36 canon=346/191KB  k10=185/110KB(57%)  k20=268/153KB(80%)
2026-10-02 cands= 22 canon=364/202KB  k10=135/82KB(41%)  k20=213/126KB(63%)
2026-10-03 cands= 20 canon=376/209KB  k10=135/81KB(39%)  k20=215/127KB(61%)
2026-10-04 cands= 21 canon=388/216KB  k10=127/76KB(35%)  k20=207/123KB(57%)
2026-10-05 cands= 28 canon=400/223KB  k10=144/89KB(40%)  k20=240/141KB(63%)
2026-10-06 cands= 45 canon=419/235KB  k10=188/117KB(50%)  k20=284/169KB(72%)
2026-10-07 cands= 31 canon=442/249KB  k10=160/102KB(41%)  k20=255/155KB(62%)
2026-10-08 cands= 41 canon=457/258KB  k10=171/110KB(43%)  k20=262/161KB(62%)
2026-10-09 cands= 40 canon=482/274KB  k10=202/123KB(45%)  k20=304/183KB(67%)
2026-10-10 cands= 41 canon=509/288KB  k10=203/124KB(43%)  k20=309/184KB(64%)
2026-10-11 cands= 41 canon=541/305KB  k10=190/117KB(38%)  k20=313/189KB(62%)
2026-10-12 cands= 21 canon=569/322KB  k10=131/85KB(27%)  k20=224/140KB(44%)
2026-10-13 cands= 34 canon=586/332KB  k10=178/108KB(33%)  k20=288/173KB(52%)
2026-10-14 cands= 21 canon=605/341KB  k10=146/92KB(27%)  k20=257/159KB(47%)
2026-10-15 cands= 38 canon=619/350KB  k10=208/129KB(37%)  k20=316/189KB(54%)
2026-10-16 cands= 24 canon=638/361KB  k10=140/85KB(24%)  k20=218/131KB(36%)
2026-10-17 cands= 31 canon=647/367KB  k10=206/128KB(35%)  k20=336/202KB(55%)
2026-10-18 cands= 18 canon=662/374KB  k10=115/71KB(19%)  k20=201/125KB(33%)
2026-10-19 cands= 15 canon=674/381KB  k10=87/53KB(14%)  k20=162/101KB(27%)
2026-10-20 cands= 20 canon=681/384KB  k10=113/68KB(18%)  k20=218/130KB(34%)
2026-10-21 cands=  6 canon=692/390KB  k10=43/28KB(7%)  k20=81/51KB(13%)
2026-10-22 cands= 25 canon=697/394KB  k10=178/110KB(28%)  k20=289/175KB(44%)
2026-10-23 cands= 33 canon=718/405KB  k10=225/137KB(34%)  k20=357/215KB(53%)
2026-10-24 cands= 36 canon=718/405KB  k10=191/116KB(29%)  k20=325/194KB(48%)
2026-10-25 cands=  1 canon=730/413KB  k10=10/6KB(2%)  k20=20/14KB(3%)
2026-10-26 cands=  8 canon=730/413KB  k10=66/38KB(9%)  k20=126/73KB(18%)
2026-10-27 cands= 32 canon=735/415KB  k10=162/101KB(24%)  k20=289/177KB(43%)
2026-10-28 cands= 23 canon=753/425KB  k10=161/95KB(22%)  k20=279/164KB(39%)
2026-10-29 cands= 17 canon=753/425KB  k10=104/68KB(16%)  k20=200/126KB(30%)
2026-10-30 cands= 39 canon=753/425KB  k10=202/126KB(30%)  k20=350/213KB(50%)
2026-10-31 cands=  7 canon=774/438KB  k10=62/40KB(9%)  k20=108/69KB(16%)
2026-11-02 cands= 13 canon=775/438KB  k10=105/66KB(15%)  k20=187/115KB(26%)
2026-11-03 cands= 18 canon=780/442KB  k10=123/77KB(18%)  k20=230/145KB(33%)
2026-11-04 cands= 10 canon=785/444KB  k10=64/42KB(9%)  k20=114/73KB(17%)
2026-11-05 cands=  1 canon=787/445KB  k10=10/8KB(2%)  k20=20/14KB(3%)
2026-11-20 cands=  2 canon=787/445KB  k10=16/11KB(2%)  k20=33/21KB(5%)

revrec
2026-10-01 cands= 18 canon=485/316KB  k10=117/85KB(27%)  k20=199/145KB(46%)
2026-10-02 cands=  9 canon=494/321KB  k10=68/53KB(16%)  k20=120/89KB(28%)
2026-10-03 cands= 28 canon=498/324KB  k10=152/113KB(35%)  k20=241/176KB(54%)
2026-10-04 cands= 18 canon=507/329KB  k10=108/77KB(23%)  k20=189/137KB(41%)
2026-10-05 cands=  3 canon=514/334KB  k10=28/18KB(5%)  k20=52/33KB(10%)
2026-10-08 cands=  4 canon=514/334KB  k10=24/19KB(6%)  k20=48/37KB(11%)
2026-10-09 cands= 22 canon=517/336KB  k10=137/100KB(30%)  k20=227/164KB(49%)
2026-10-10 cands= 10 canon=528/342KB  k10=64/48KB(14%)  k20=113/83KB(24%)
2026-10-13 cands= 30 canon=531/343KB  k10=155/110KB(32%)  k20=261/185KB(54%)
2026-10-17 cands=  7 canon=549/354KB  k10=41/29KB(8%)  k20=77/53KB(15%)
2026-10-23 cands= 14 canon=553/356KB  k10=94/64KB(18%)  k20=159/110KB(31%)
2026-10-24 cands= 11 canon=553/356KB  k10=69/46KB(13%)  k20=118/81KB(23%)
2026-10-28 cands=  7 canon=555/357KB  k10=28/18KB(5%)  k20=73/50KB(14%)
2026-10-29 cands=  7 canon=555/357KB  k10=55/39KB(11%)  k20=106/76KB(21%)
2026-10-30 cands=  8 canon=555/357KB  k10=56/38KB(11%)  k20=104/72KB(20%)
2026-10-31 cands= 12 canon=559/359KB  k10=79/54KB(15%)  k20=127/86KB(24%)
2026-11-01 cands= 15 canon=564/362KB  k10=85/57KB(16%)  k20=151/103KB(29%)
2026-11-02 cands=  6 canon=570/364KB  k10=45/28KB(8%)  k20=82/53KB(15%)
2026-11-03 cands= 14 canon=573/366KB  k10=92/64KB(17%)  k20=154/109KB(30%)
2026-11-04 cands= 19 canon=582/371KB  k10=92/63KB(17%)  k20=166/116KB(31%)
2026-11-05 cands=  1 canon=594/379KB  k10=10/7KB(2%)  k20=20/15KB(4%)
2026-11-10 cands= 18 canon=595/379KB  k10=97/69KB(18%)  k20=168/119KB(32%)
2026-11-11 cands= 15 canon=607/386KB  k10=84/60KB(16%)  k20=156/111KB(29%)
2026-11-12 cands=  4 canon=610/387KB  k10=37/26KB(7%)  k20=70/49KB(13%)
2026-11-13 cands= 10 canon=610/387KB  k10=55/36KB(9%)  k20=105/69KB(18%)
2026-11-14 cands=  5 canon=611/388KB  k10=46/31KB(8%)  k20=84/57KB(15%)
2026-11-16 cands= 16 canon=614/390KB  k10=117/79KB(20%)  k20=204/141KB(36%)
2026-11-17 cands=  1 canon=620/392KB  k10=10/7KB(2%)  k20=20/13KB(3%)
2026-11-18 cands=  2 canon=625/396KB  k10=20/13KB(3%)  k20=39/26KB(6%)
2026-11-20 cands= 14 canon=625/396KB  k10=102/72KB(18%)  k20=177/123KB(31%)
```

The canon column is approximate: it counts today's active entries admitted
before that date, so entries superseded since then are missing from it.
