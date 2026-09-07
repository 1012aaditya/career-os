# Career Graph — Phase 6.9 freeze record

Audit date: 2026-09-07. Branch `feat/career-graph`, audited against `4388c8a`.

This is the closing record for Phase 6. It states what the Career Graph
guarantees, what it does not, and what Phase 7 (GitHub Evidence) must do
before it writes anything. It is written to be read later by someone who
was not here, so it records the reasoning and not only the decision.

---

## Freeze status

**The Career Graph's logic is freeze-ready. The repository is not.**

Three things are true of the committed tree that have to be resolved before
"frozen" means anything, and none of them is a Career Graph design problem:

1. **Nothing calls `ingestConfirmedResume`.** At `4388c8a` the only
   references to it are its own definition and the module registration.
   `confirm()` sets `status = CONFIRMED` and returns; no controller route
   reaches ingestion. The entire ingestion service is unreachable, so no
   confirmed resume has ever populated a graph.
2. **`CONFIRMED` is a one-way door.** `confirm()` requires `NEEDS_REVIEW`,
   and no route moves an import back out of `CONFIRMED`. Every resume
   confirmed against this code is therefore permanently un-ingestable, and
   the population grows for as long as the tree stays this way. Recovering
   them needs a backfill or a re-ingest route.
3. **Mobile does not build from a clean checkout.** `CareerScreen.tsx`
   imports `react-native-svg`; `apps/mobile/package.json` at `4388c8a`
   does not declare it. CI does not catch this: root `typecheck` runs
   `pnpm -r typecheck` and the mobile package declares no `typecheck`
   script, and CI runs no tests at all.

The fixes for all three exist as uncommitted work in the working tree and
were deliberately left there — see "Working tree" below.

---

## What Phase 6.9 changed

Five fixes, all of them freeze-contract violations rather than new features.

| # | Fix | Contract clause it restores |
|---|---|---|
| 1 | `orderBy` on the 15 previously-unordered collections in `getGraph` — 14 nested join collections plus top-level `goals` | Determinism |
| 2 | `readLinks` in `evidence.ts` sorts its output | Determinism |
| 3 | Timeline reads real education provenance instead of hardcoding "unknown" | Evidence |
| 4 | `CareerStateBasis` reaches the UI; only a *stated* ongoing marker prints "Present" | Career state |
| 5 | Ingestion catches `P2002` and reports `ALREADY_INGESTED` instead of a 500 | Import safety |

### 1 and 2 — determinism

`career-graph.service.ts` opened with an ordering contract asserting that
"every collection returned here is deterministically ordered". That was
true of the six top-level lists and false of everything one level down.
Postgres was free to return an experience's skills, or an evidence row's
links, in any order.

That order reached the user. `EvidenceCard` renders the first six links of
an evidence row and a "+N more" line, so one resume producing one Evidence
row over twenty skills showed a different six on every refresh, with
nothing to indicate the list had changed.

The join tables carry no `createdAt` and no rank column, so there is no
meaningful order to restore — the ordering is by foreign key, which is an
opaque uuid: arbitrary, but *stable*, and stable is the whole requirement.
The client sorts by display name where a human-predictable order matters.

Both layers are fixed rather than just one. The API guarantee is the real
one; the client sort is there because the projection modules are pure
functions that should not depend on their caller having a particular
server version.

### 3 — education provenance

`buildEducationItem` hardcoded `provenance: unknownProvenance()` under a
comment reading "Education carries no evidence relation in the schema".
That was true when written and stopped being true when Phase 6.8 added the
`EvidenceEducation` join. The comment outlived the fact.

The visible effect: every education row on the timeline said "Source not
recorded" while the detail sheet, reading the same payload through
`evidence.ts`, showed the same record as supported. One screen contradicted
the other about the same record.

### 4 — inference must not read as a stated fact

`isCurrent` collapses two different facts:

- the source wrote an ongoing marker ("Present", "Current") — a fact;
- the source supplied no end date at all, and ingestion read that absence
  as ongoing — an inference, and a reasonable one, but ours and not the
  source's.

`getCareerState` has distinguished these since 6.7 as `stated-current` and
`assumed-current`. The basis never left `data-quality.ts`: no UI surface
consumed it, so both rendered as `"Jan 2022 — Present"` and `" · Current"`.
The product asserted a job the user might not hold, from a missing field.

Now `stated-current` keeps `"— Present"` and `" · Current"`; an
`assumed-current` role renders `"From Jan 2022 · Current (assumed)"`.
Ordering, recency and counts are untouched — only the claim changed.

Two details worth recording, both found by review rather than by the first
pass:

- The range string no longer spells currentness at all on the timeline;
  `TimelineRow` composes the range and the marker. Gating only the
  `"— Present"` branch left the terminal `"Current"` ungated, so an undated
  current role still asserted a flat `Current` — and once the marker
  learned to qualify itself, rendered `"Current · Current (assumed)"`. The
  stutter predates this milestone (`"Current · Current"`); composing in one
  place removes it and makes the marker survive a record with no dates.
- Entity cards render `period` with no marker beside it, so `formatPeriod`
  carries the qualification inside the string. Gating it the same way as
  the timeline without that would have left the snapshot card silent about
  a role the timeline calls current — the same cross-screen contradiction
  the education fix exists to remove.

Rendering, verified across all five cases:

| Record | Row |
|---|---|
| Stated ongoing, has start | `Mar 2024 — Present · Current` |
| No end date supplied, has start | `From Jan 2022 · Current (assumed)` |
| Stated ongoing, no dates | `Current` |
| No end date supplied, no dates | `Current (assumed)` |
| Ended | `From Jan 2019` |

Measured before and after on identical input:

| Case | `4388c8a` | After 6.9 |
|---|---|---|
| Role with `endDateText: "Present"` | `Mar 2024 — Present` | `Mar 2024 — Present` |
| Role with `endDateText: null` | `Jan 2022 — Present` | `From Jan 2022` |
| Education with `EvidenceEducation` | `Source not recorded` | `From Resume` |
| Evidence links, shuffled input | order changed | order identical |

### 5 — P2002

The in-transaction idempotency read runs under READ COMMITTED, so two
concurrent ingestions of one import both see no ledger row and both run the
full write path. The unique index on `CareerGraphIngestion.resumeImportId`
is what actually serialises them, and the loser's writes roll back cleanly
— that part was already correct.

What was wrong was the report: `P2002` escaped as an unhandled 500 at the
moment the winning request committed. A caller that reverts the import on
failure would ask the user to retry an import already live in their graph.
The ledger row is now read back — not assumed — and a `P2002` from any
other constraint rethrows untouched.

---

## Deliberately deferred

Each of these is real. None of them blocks Phase 7, and the reasoning is
recorded so the deferral can be re-argued rather than rediscovered.

### Field-level provenance — DEFER

**Question asked:** can Phase 7 add GitHub evidence while provenance stays
import-level?

**Yes, for reading.** `Evidence` carries `sourceType`, and every
evidence-to-entity join is many-to-many, so one `Project` row can be
attested by a RESUME evidence and a GITHUB evidence simultaneously.
Import-level provenance composes correctly by construction, and `getGraph`
already returns everything a two-source UI needs to render.

**The known limit:** `EvidenceSkill` attaches *every* skill in an import to
that import's one Evidence row. The join means "this document mentioned
this skill", not "this source proves this skill". That is honest today
because the UI says only "Supported"/"Unsupported" and names the source. It
stops being honest the moment anything scores evidence strength, because it
would be counting imports rather than facts. **Phase 7 must not build
scoring on these joins.**

No event sourcing, no audit log. Revisit when evidence strength is built.

### Conflict resolution and stale-record retirement — DEFER, with a caveat

Ingestion detects nothing and resolves nothing; `data-quality.ts` reports
lookalike records to the user and changes nothing. That is the right
default — merging distinct database identities inside a display layer would
hide a normalisation decision.

**The caveat, recorded because it is worse than "not yet implemented":**
the dedupe keys can silently *drop* a real record. Experience matches on
`(userId, companyId, title, startDate, endDate)` and `parseDate` returns
null for anything it cannot read. Two stints as "Software Engineer" at one
company written `"2018 – 2019"` and `"2021 – 2022"` both parse to
`(null, null)`, so the second matches the first and is discarded — along
with its description. Achievement's key `(userId, title, occurredAt)` is
the most exposed: the same award twice, or two undated ones, collapse to
one row.

Every match path is create-only, so a matched row is never enriched by a
later, better source either.

This is pre-existing resume-side behaviour, it does not prevent GitHub
evidence from being added, and fixing it properly means designing the
conflict model this milestone was told not to design. It is the **first
thing to fix after Phase 7 lands**, and it should be fixed before any
source starts re-syncing on a schedule.

### `Experience.type` — DEFER

Hardcoded to `EMPLOYMENT`; the enum is effectively dead. GitHub evidence
does not depend on experience type, and inferring one from title regexes
would fabricate data. Left alone deliberately.

### Stranded `PROCESSING` — DEFER (operational)

`claimNext` sets `PROCESSING` with no lease, no `claimedAt` and no worker
id — the columns do not exist — and there is no sweeper. A worker crash
strands the row permanently: no route returns it to `PENDING`, and
`claimNext` only selects `PENDING`.

It corrupts nothing. Nothing was written to the graph, and the user can
re-upload. It is a lease/sweeper design, which belongs with production
hardening.

### Worker route security — DEFER (hardening), with one exception noted

`verifyWorkerSecret` compares the shared secret with `!==`, which is not
constant-time, and the worker routes are not scoped per user — a caller
holding the secret can act on any import.

Neither currently permits cross-user *graph* modification: the worker
routes only move an import's status and write `extractionResult`, and both
`complete()` and `fail()` are compare-and-swap guarded on `PROCESSING`, so
a confirmed import cannot be dragged backwards. Ingestion itself is
user-scoped through `findFirst({ id, userId })`.

Constant-time comparison and per-user authorization are Phase 12.

### Skill normalization — DEFER (explicitly out of scope)

`normalizeName` only trims, lowercases and collapses whitespace. "Node.js",
"NodeJS" and "Node" are three rows. GitHub will make this markedly worse by
supplying a second spelling of everything. Out of scope by instruction, and
noted as a known cost of proceeding.

### Ingestion round trips and global lock ordering — DEFER (operational)

Ingestion issues roughly 160 sequential round trips inside one transaction
budgeted at 120s. `Skill.normalizedName` and `Company.normalizedName` are
globally unique across all users, so those inserts take index locks held to
commit — two users importing resumes mentioning "react" serialise on it,
and because insertion order follows document order rather than a sorted
one, a cross-transaction deadlock is reachable. Postgres kills one
transaction and it rolls back cleanly, so this costs a failed import rather
than corrupt data.

Sorting the skill list before the loop would remove the deadlock class, and
`createMany` on the join loops would cut roughly 35 round trips. Both are
worth doing for lock-window reasons, neither is a Phase 7 blocker.

Related and worth knowing: `Skill.upsert` uses `update: {}`, so a skill's
display name is permanently whatever the first importer's resume wrote, and
that string is served to every other user. Safe today; it becomes a
cross-tenant last-writer-wins the moment someone "improves" it to
`update: { name }`. **Do not.**

### `rawExtractionResult` in resume-import responses — NOT CHANGED

`findAll` and `findOne` return the whole `ResumeImport` row, including
`rawExtractionResult`. It is the user's own data behind an ownership check,
so this is a payload-size question, not a leak — `findAll` returns every
import with two full JSON blobs each. `getGraph` already excludes it
correctly.

Not changed here because the fix belongs in `resume-import.service.ts`,
which carries unrelated uncommitted work. Reported rather than mixed in.

---

## Phase 7 preconditions

Phase 7 does **not** need the identity model to change. It needs one
additive migration and two rules.

### Required: a source-generic ingestion ledger

`CareerGraphIngestion.resumeImportId` is `NOT NULL`, `UNIQUE`, and foreign
keyed to `ResumeImport`. A GitHub sync has no `resumeImportId`, so the
table **cannot represent a non-resume ingestion at all**. The two ways
around it without a migration are both bad: fabricate a fake `ResumeImport`
per sync, which pollutes `findAll` and drags GitHub through a state machine
it has no business in; or skip the ledger, which forfeits idempotency and
re-runs the full write path against the dedupe keys described above.

Smallest change: make `resumeImportId` nullable, add `sourceType` and a
`sourceKey`, and make `(userId, sourceType, sourceKey)` unique. Additive,
and it leaves resume ingestion working unchanged.

### Recommended: a natural key for re-sync

`Evidence.externalId` exists but has no unique constraint and no index, so
it cannot answer "have I already ingested repo X?" without a sequential
scan. A resume is confirmed once; GitHub is re-pulled. Add
`@@unique([userId, sourceType, externalId])` before the first re-sync ships.

### Rule 1 — do not resolve conflicts silently

Where GitHub and the resume disagree, surface both. The ingestion path is
create-only, so today the first writer wins permanently and the better data
is discarded without a trace. Do not paper over that with a last-writer-wins
update.

### Rule 2 — disconnect is not yet answerable

No first-class entity records its source. `Project`, `Experience`,
`Education`, `Achievement` and `UserSkill` have no `sourceType` and no
creating-evidence reference; provenance exists only transitively through
the Evidence joins. So when a user disconnects GitHub you can delete the
GITHUB Evidence rows and their joins, but you cannot tell whether a
`Project` was *created by* GitHub (delete it) or merely *attested by* it
(keep it).

If Phase 7 ships a disconnect flow, it needs a `createdByEvidenceId` (or
equivalent) on those tables. If it does not ship one, this can wait — but
it is a data-deletion promise, not UI polish, so decide deliberately.

---

## The freeze contract, honestly scored

**Identity** — Holds. Every relationship resolves by stable id; there is no
name-only matching where ids exist. The one name-keyed path is a
display-level capability merge in `CareerScreen.tsx`, unreachable while
`Skill.normalizedName` stays globally unique, and it is the thing to
revisit first if a source ever bypasses `normalizeName`.

**Determinism** — Holds as of this milestone, and did not before it. All 15
unordered collections now carry an `orderBy`; evidence links are sorted at
the client too. Verified by feeding shuffled input through the projections
and diffing the output.

**Provenance** — Holds, at import level, and the limit is stated above. No
projection invents an edge; `relations.ts` explicitly refuses
text-similarity attachment; the only assertive sentence in the UI
("Confirmed from a resume you reviewed") is gated on a real
`ResumeImport.status`.

**Career state** — Holds as of this milestone. `CURRENT`/`ENDED`/`UNKNOWN`
each carry an explainable basis, and inference no longer renders as a
stated fact.

*Known gap:* the data-quality finding "N roles are current at the same
time" counts state without regard to basis, so three roles that merely omit
end dates are reported as a contradiction the user did not create. It sits
in a section framed as "records to review", so it prompts rather than
asserts. Left as-is; worth revisiting.

**Evidence** — Holds. Education is no longer a special unsupported case,
in the data (6.8) and now in the timeline too (6.9).

*Known gap:* `Evidence.sourceUrl` and `externalId` are parsed into the
mobile model and rendered nowhere. Both are always null for resume evidence
so nothing is lost today — but for a GitHub commit or PR the URL *is* the
evidence, and Phase 7 must add that render site or it will drop the
artifact link silently.

**Relationships** — Holds. Every exposed relationship exists in source data
or is explicitly deterministic. Ingestion does not write
`ExperienceProject` or `ExperienceAchievement` at all, so those arrive
empty rather than guessed at.

**Import safety** — Holds for repeated ingestion of the *same* import:
`distinctIds` prevents composite-key collisions, `companyId ?? null`
prevents cross-employer matching, and P2002 is now handled. **Does not hold
for logically-repeated imports** — re-uploading the same resume creates
duplicates, or silently drops records, per the dedupe caveat above. That is
the deferred conflict model and it is the largest known hole.

**API** — Holds. Every career route is behind `AuthGuard` and scoped by
`userId`; `getGraph` is deterministic and null-safe; `extractionResult` is
excluded from graph responses.

**Mobile** — Holds. Projections agree with API semantics, the
`ONGOING_MARKERS` list mirrors ingestion's exactly (including trim and
lowercase handling), and all four null-safety scenarios — empty graph, null
profile, null dates, missing nested arrays — degrade to honest empty states
rather than crashing.

---

## Test coverage — the largest outstanding risk

**There are no Career Graph tests.** The repository contains two spec files
and both are auth. The Phase 6.8 report of "17 suites passed" is not
supported by this tree; the actual baseline is `Test Files 1 failed | 1
passed (2)`, `Tests 2 failed | 6 passed (8)`, the two failures being the
known pre-existing auth ones.

So every determinism, provenance and career-state guarantee above rests on
reading the code and on one-off scripted checks, not on anything that will
fail if someone breaks it tomorrow.

This is cheap to fix and should be done first. All seven modules in
`apps/mobile/src/career/` are pure TypeScript with type-only imports — no
React Native runtime — so they run under plain vitest in Node with no RN
harness. The blocker is not technical: adding a test runner means editing
`apps/mobile/package.json`, which currently carries unrelated uncommitted
work, and Phase 6.9 declined to mix the two.

Worth covering first: empty graph, shuffled nested collections, stated vs
assumed current, conflicting dates, education provenance, repeated
ingestion, and evidence link ordering.

---

## Working tree

Phase 6.9 committed only its own five files. These were already modified
before the milestone began and were deliberately left alone, because each
mixes pre-existing work with something the Career Graph needs:

- `apps/api/src/resume-import/resume-import.service.ts` — contains the
  ingestion wiring that fixes freeze blocker 1, mixed with reformatting.
- `apps/api/src/resume-import/resume-import.module.ts` — imports
  `CareerGraphModule` for that wiring.
- `apps/mobile/package.json`, `pnpm-lock.yaml` — add `react-native-svg`,
  which fixes freeze blocker 3.
- `apps/mobile/src/navigation/MainStackNavigator.tsx`,
  `apps/mobile/src/screens/ResumeReviewScreen.tsx` — typed navigation and
  a cast.
- Untracked: `apps/api/env`, `apps/api/tsconfig.build.tsbuildinfo`. Neither
  should be committed; `tsconfig.build.tsbuildinfo` belongs in
  `.gitignore`.

One hazard to fix when that wiring is committed: the working-tree
`confirm()` flips to `CONFIRMED`, then ingests, then reverts on failure —
all outside a transaction. A process death between the status write and the
ingestion leaves the same dead end by a different route. The status flip
belongs inside the ingestion transaction, or the revert needs to be a
compensating transaction.
