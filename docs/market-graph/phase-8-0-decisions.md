# Phase 8.0 — Market Graph: architecture decision record

Decided 2026-09-08. Branch `feat/market-graph`, worktree `career-os-phase8`,
based on `feat/external-evidence` at `f388f96`.

The Career Graph answers "what does this person actually know and have
evidence for". The Market Graph answers a different question — "what does
the external market currently demand" — and the two must not be able to
answer each other's. Phase 9 will combine them. Phase 8 makes the market
side trustworthy enough to be worth combining.

Three words carry the whole phase and are used here in exactly one sense
each:

- **Observation** — "TypeScript appears in Greenhouse posting 6136160004,
  seen by us at 2026-09-08T12:00:00Z."
- **Signal** — "TypeScript appears in 62 of 100 postings we resolved to
  Backend Engineer, over window W, under ruleset v1."
- **Recommendation** — "You should learn TypeScript." **Phase 9. Absent
  here, and its absence is enforced by tests, not by intention.**

---

## D1 — The first source is Greenhouse, and Adzuna is refused on licence

**Decision.** The first implemented source is the Greenhouse Job Board
API. Adzuna, Jooble and Lightcast job postings are refused.

**Why.** The build prompt named Adzuna first among seven candidates. It
cannot be used. Adzuna's published terms of service name our exact
product in their prohibited list:

> "It may not be used in its original format or in aggregation (including
> but not limited to vacancy counts, average salaries etc) to deliver any
> ongoing work or research, apart from the purpose stated prior, without
> written consent."

and require deletion on termination:

> "an API user shall immediately remove all insertion codes and data
> acquired from Adzuna from all pages of its web sites."

A Market Graph *is* aggregation into vacancy counts, and it retains raw
observations permanently so that signals stay reproducible. Both clauses
are directly incompatible. Adzuna also returns only a description snippet
("we currently only provide a snipped of the job description"), which
would make skill extraction impossible even if the licence allowed it.

Jooble is refused on capacity, not licence: a key is capped at **500
requests for the lifetime of the key**. That is a demo, not a source.
Lightcast job postings are enterprise contract only — a verified public
procurement records £62,830 for a two-year subscription.

**What Greenhouse buys.**

- Real first-party employer postings, not an aggregator's relabelling.
- No authentication at all. Verified live: `GET
  https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
  returned 200 for `vercel` (87 jobs), `stripe` (620) and `figma` (157).
- Full job body in `content`, which is what makes skill extraction
  possible.
- `id`, `first_published` and `updated_at` on every posting — the only
  free source found carrying both a creation and a modification
  timestamp.
- The whole board arrives in one response, so there is no pagination
  window during which the underlying set can shift.

**What this costs, stated plainly.**

1. **The licence position is "unaddressed", not "permitted".** No terms of
   service governing the public Job Board API were found. Greenhouse
   documents the endpoint as public and unauthenticated and describes its
   purpose as letting third parties "build a custom job board or career
   site", and there is no clause forbidding aggregation or requiring
   deletion. That is the inverse of Adzuna, where our use is named and
   prohibited — but it is not the same as a grant. **This is recorded as a
   known unknown, not as a permission.** `MarketSource.licenceBasis`
   carries `UNADDRESSED_PUBLIC_ENDPOINT` for Greenhouse so the position is
   queryable rather than remembered.
2. **Greenhouse is per-company.** There is no global search. The sample
   frame is a curated list of board tokens, which means every signal is
   "the market as covered by these employers" and may never be labelled
   "the market". `MarketSignalRun.scopes` holds that board list and
   `sourceScopeKey` is its checksum, so "which employers is this about?"
   is answerable from the row rather than being a caveat somebody
   forgets.
3. **`application_deadline` is null in practice.** It exists in the
   payload and would be the ideal freshness input. It was null on all 864
   postings sampled across three boards. It is parsed and stored, and
   freshness does not depend on it. See D7.

**Verified live on 2026-09-08**, not from documentation alone: field
inventory, id type and range, timestamp format, entity-escaping of
`content`, response-order stability, 404 shape for an unknown board, and
the fact that the key set differs between boards (`stripe` and `figma`
return `education`; `vercel` does not).

---

## D2 — Everything is additive, and prefixed `Market`

**Decision.** Fourteen new models, eleven new enums, one new migration. No
existing model, column, index or constraint is altered. Every new model
is named `Market*`.

**Why the prefix.** `CanonicalSkill` was considered and rejected: it
implies the existing `Skill` is non-canonical, which is false. `Skill` is
canonical for the person side. There are two canonical vocabularies and
the prefix names which side you are standing on. It also makes "did
Phase 8 touch a frozen table?" answerable by `grep -v '^model Market'`
rather than by review.

**Why not reuse `Skill`.** `Skill.normalizedName` and
`Company.normalizedName` are **globally unique across all users**. Three
consequences, all already documented in the Phase 6.9 freeze record:

- inserts take an index lock held to commit, so a background market
  ingest would serialise against live resume imports and a
  cross-transaction deadlock is reachable;
- `Skill.upsert` uses `update: {}`, so a skill's display name is
  permanently whatever the first importer's resume wrote — and the freeze
  record's instruction about changing that is the single word "**Do
  not.**";
- a market ingest writing into `Skill` would mean observing the job market
  silently edits users' career graphs.

`MarketSkill` will hold a market vocabulary that has no business in a
user's skill picker. The two are linked in Phase 9 by an explicit mapping
table, never by a shared row. See D10.

---

## D3 — A posting is three tables, not one

**Decision.**

| Model | Mutability | Holds |
| --- | --- | --- |
| `MarketPosting` | identity immutable; two pointer columns advance | who this posting is, `firstSeenAt`, `lastSeenAt` |
| `MarketPostingVersion` | **immutable, content-addressed** | what the posting said, and the raw payload |
| `MarketPostingSighting` | **append-only** | that we saw it in run R at instant T |
| `MarketRunScopeCoverage` | **append-only** | what one run actually covered, per board |

This is a deliberate departure from Phase 7, which keeps one mutable
`Evidence` row per repository. That flattening was justified by an
unbounded `getGraph` shipping everything to a mobile client. Market data
is not per-user and is never shipped wholesale, so the justification does
not transfer — and reproducibility actively forbids a mutate-only model.

**Why.** The rule "refreshing a database row does not make the underlying
market observation newer" has to be structural, or it decays into a
convention somebody forgets. Phase 7 has already been bitten by exactly
this shape: `previouslyObservedAt` was dragged forward on every
non-observing run, so — in the words of the fix — "a row whose counts are
a year old reports them as observed last week."

With the split, the rule is enforced by what a table *can* express:

- re-fetching an unchanged posting appends **one** ~50-byte sighting row,
  advances `lastSeenAt`, and creates **no** version. Every content field
  and every source timestamp is physically untouchable by that path;
- an edited posting produces a **new** version. The old one is retained,
  so a signal computed last month still resolves to the text that
  produced it;
- `firstSeenAt` appears in no update payload, so a re-observation cannot
  overwrite when we first saw the job.

**The two alternatives, and what each destroys.**

*One mutable row per posting.* Historical windows become uncomputable — a
signal for week 20 can only be computed from data describing week 20, and
if the row was overwritten in week 36 that data no longer exists.
Recomputing after a normalization fix becomes impossible, which makes the
versioning in D6 pointless.

*One row per fetch.* Prevalence silently becomes a function of our polling
cadence: a posting live 90 days and polled daily contributes 90 rows, one
live 3 days contributes 3, so naive counting weights postings by how hard
they are to fill — the inverse of what prevalence means. Every query would
need `DISTINCT ON (postingId)`, and the day someone forgets, the number is
wrong by an order of magnitude with nothing to catch it.

**What this costs.** Three tables instead of one, and a join to answer
"show me this posting". Accepted.

---

## D4 — Posting identity is source-scoped and derived from the source's id

**Decision.**

```
externalId = 'market:' + sourceSlug + ':' + basis + ':' + identityVersion + ':' + externalKey
```

e.g. `market:greenhouse-vercel:sid:1:6136160004`.

`MarketPosting.externalId` is `@unique`. Every component a query needs is
**also stored as its own column**; `externalId` is never parsed.

**Why each part.**

- **`title + company` is banned outright** as an identity. One company
  posting "Software Engineer" in three cities collapses to one row, and
  the same title reposted next quarter produces no new row — so a
  re-opened requisition is invisible and demand flatlines.
- **Scoped by `sourceSlug`, not `sourceId`.** `sourceId` is a
  `@default(uuid())` and differs between dev, CI and production. A derived
  id containing one is not reproducible across environments — the
  determinism tests would pass in-process and the artifact would still be
  machine-local. `sourceSlug` is authored, ASCII, and CHECK-constrained.
- **`basis` records how the id was derived** (`sid` = the source's own
  stable id). It is the descendant of Phase 7's `revalidatedBy`: the basis
  is falsifiable even where the id is not. A future source with no stable
  id gets `url` or `fp` and its collision risk is documented at that
  point, not assumed away now.
- **`identityVersion` is inside the string** so that changing a derivation
  produces a visible split (`fp:2:`) rather than a silent
  re-identification of everything ingested afterwards.
- **Never parsed.** `sourceSlug` may itself contain a separator, so
  parsing is ambiguous by construction. Every hash input is
  `canonicalJson({named: fields})` of an object, never a joined string,
  for the same reason.

Greenhouse ids are JSON numbers. They are validated with
`Number.isSafeInteger` and refused otherwise, following the existing
`numericId` rule — beyond 2^53 the parser has already rounded, and a
rounded id could collide with a different posting.

---

## D5 — The same job in three sources stays three observations

**Decision.** Phase 8 never collapses postings across sources. Three
sources carrying one job produce three `MarketPosting` rows, three version
chains, three sighting ledgers and three raw payloads.

**Why.** A collapse is a destructive inference and there is no way back
from it. Phase 8 has no evidence good enough to make it. This is the same
reasoning the Phase 7 evidence repository already applies to deletion:
absence from a sync is not evidence of absence.

**The seam left for later.** Cross-source identity, when it arrives, is a
*separate table* — `(postingId unique, clusterId, method)` — so adding it
changes no posting identity, invalidates no existing signal, and requires
no re-ingestion. What Phase 8 must store *now* so that job is possible
without re-fetching sources that will have deleted the postings:
`rawPayload` and its hash, `companyRaw` and `companyNormalized`,
`applyUrlCanonical`, and the full stabilized description rather than only
a digest. Storing only a hash would foreclose every future fuzzy method.

**The honest labelling rule until then.** A multi-source count counts
**postings**, not jobs. `MarketSignal.dedupeMethod` is `NONE` in Phase 8,
and the API says "postings" — never "jobs" or "openings".

---

## D6 — One ruleset version, stamped on every derived row

**Decision.** A single `rulesetVersion` integer covers field
normalization *and* role/skill alias resolution. It is a key column on
`MarketPostingNormalization` and on `MarketPostingSkillMention`, and is
recorded on every signal. Signal arithmetic carries a separate
`computationVersion`.

Normalization results are stored **per version and never overwritten**.
Re-normalizing under v2 writes new rows; v1 rows remain, and a v1 signal
remains reproducible and explainable.

**Why one version and not three.** A stricter design separates
normalization (pure, no database reads) from taxonomy resolution (reads
versioned alias tables) with independent version numbers. That separation
is real and is honoured **in code structure** — the normalizer is a pure
function and the resolver is a separate stage. It is not honoured in the
*numbering*, because two version columns where one ever moves is
ceremony. The cost is that adding a single skill alias requires
re-normalizing, not just re-resolving. At Phase 8 volumes that is seconds.
Deferred, with the trigger recorded: split the versions when
re-normalization stops being cheap.

**What makes an old signal reproducible.** Four things, all of which
Phase 8 guarantees: raw payloads are retained; the v1 normalizer module is
frozen and a bug fix in it *is* v2; alias rows are keyed by version and
frozen once referenced; and every signal records the exact ruleset,
computation version, window and source scope it was computed under.

**Anything that can change a persisted byte is part of the version** —
the alias tables, the boilerplate strippers, the token rules. None of them
may be an environment variable.

---

## D7 — Freshness is derived, never stored

**Decision.** No `freshness` column exists. Freshness is a pure function
of `(asOf, lastSeenAt, lastCompleteCoverageAt, source config)`, computed
at read.

**Why.** A stored freshness column is a judgement made at time T that goes
on asserting itself at T+6 months. Keeping it honest requires a sweeper
that rewrites rows nothing observed — which is precisely the write churn
Phase 7 had to eliminate. A derived function also takes an explicit
`asOf`, so "was this fresh when that signal was computed?" is answerable;
a column holding only the latest verdict cannot answer it.

**The four states, and the one that matters.**

- `FRESH` — seen within two poll intervals. Two rather than one so a
  single missed run does not flip a healthy posting. This is a
  fault-tolerance argument about *our sampling*, not a claim about the job
  market, which is why it needs no market evidence to justify.
- `AGING` — seen longer ago than that, but within the source's configured
  expected posting lifetime.
- `STALE` — beyond it.
- `UNAVAILABLE` — **we cannot tell.** No complete run has covered this
  posting's board since we last saw it, so its absence is our failure, not
  the posting's disappearance. This is Phase 7's `NOT_SCANNED`, in the
  time dimension, and it must never render as `STALE` — which in turn must
  never render as "the job is gone".

**The one number I will not pretend to know.** `expectedPostingLifetime`
is genuinely market-dependent. It is a per-source configured column with a
documented default of 30 days, chosen because it is the modal auto-expiry
on major ATS boards — which makes it defensible as *board behaviour*, not
as a measured market median. Every freshness verdict RETURNS
`lifetimeBasis` to its caller - it is derived, so there is nothing stored
to go back and find - which means a reader can see at the point of use
that a verdict rests on a guess. `application_deadline` would replace the
guess with the employer's own stated expiry, and is parsed for that
purpose — but it was null on all 864 postings sampled, so **freshness does
not depend on it today** and the code must not behave as though it does.

---

## D8 — Signals are integers, persisted, immutable, and floored

**Decision.** `MarketSignal` stores `numeratorCount Int` and
`denominatorCount Int`. There is no `value`, `ratio`, `percent`, `score`,
`weight` or `confidence` column anywhere in Phase 8.

**Why integers.** A ratio is a lossy projection: 3/7 and 429/1001 both
round to 0.4286 and only one is a signal. Every consumer needs the
denominator to decide whether to display the number at all. Integers also
roll up correctly — a quarter is `Σnum / Σden` — whereas averaging ratios
over unequal denominators is Simpson's paradox with extra steps. And
integer counts are bit-exact on every machine, so a determinism test can
assert byte equality without chasing float accumulation order.

**Why persisted rather than computed on read.** A signal computed on read
changes the instant a new posting lands, so asking the same question twice
gives two answers with nothing recording that anything changed. That makes
"deterministic market graph" a phrase rather than a property, and leaves
Phase 9 with no id to cite when a user asks why they were told something.

**Why immutable.** A recompute writes a new `MarketSignalRun` and a fresh
set of rows. Nothing is updated in place. Staleness is then a visible fact
— every signal carries its window and `computedAt` — rather than a bug to
be patched away.

**The two signal types, defined exactly.**

- `ROLE_POSTING_VOLUME` — count of distinct postings resolved to role R
  whose sighting falls in the window. Never suppressed: a role with three
  postings appears with volume three.
- `ROLE_SKILL_PREVALENCE` — of the postings for R that were *eligible to
  express skills at all*, how many mention canonical skill S. Binary per
  posting: ten mentions count once.

**The denominator is the load-bearing part.** A posting whose description
we could not read is not a posting with no requirements. Only postings
with `skillExtractionStatus = EXTRACTED` and a full description enter the
prevalence denominator. Excluded postings still count toward volume, and
the exclusion counts are recorded on the signal run — so the gap is
visible rather than silently shrinking the denominator.

**Small samples get a floor, not a fudge factor.** A prevalence row is
written only if `denominatorCount >= minDenominator` and
`distinctCompanyCount >= minDistinctCompanies`. Below either, the row is
not written and the suppression is counted. The thresholds live on the
signal run, not in code, so changing them produces a new comparable
snapshot instead of silently changing what an existing number means.

A `lowConfidence` flag was considered and rejected: a flag relies on every
consumer remembering to check it, and one day something renders "100% of
Backend Engineer postings require COBOL" over n=1. Suppression fails
closed.

**Windows are half-open `[start, end)` in UTC**, filtering on the
sighting's `observedAt`. Half-open so adjacent windows tile exactly with
no double count at the seam. Filtering on `observedAt` because it is the
only candidate that is non-null by construction, on our clock, and
immutable — `first_published` is nullable and correctable by the source,
which would silently change a historical answer.

The consequence is stated rather than hidden: a window over `observedAt`
means "postings **we observed** in this window", not "postings created in
it". The difference is our polling cadence. Field names say
`observedPostingCount`, never `newPostingCount`.

---

## D9 — Zero confidence scores

**Decision.** Phase 8 ships no confidence score of any kind. Not source
reliability, not extraction confidence, not normalization confidence, not
aggregation confidence.

**Why, per concept.**

- **Source reliability** would need ground truth to score against. With
  one source and no labelled set, any number is a constant chosen by
  whoever wrote the migration, laundered through a column name until it
  looks measured. What ships instead: run statuses, coverage scope, and
  counts of parse anomalies — facts a human or a later model can score.
- **Extraction confidence** is cut by *reducing scope* until it does not
  arise. Phase 8 extracts skills by deterministic token-anchored matching
  against a curated alias table. There is no probabilistic step, so a
  confidence column would be a constant `1.0`. What ships instead:
  `extractedFrom` (title vs description), which is a fact and lets a
  consumer weight them differently on defensible grounds.
- **Normalization confidence** is a probability attached to a hash lookup.
  The term is in the alias table or it is not. What ships instead:
  `matchMethod`, and `UNMAPPED` as a first-class retained outcome.
- **Aggregation confidence** is the one real concern, and a scalar
  destroys it: a single 0.6 cannot distinguish "plenty of data from one
  narrow scope", "thin data across a broad one", and "one employer posted
  400 near-identical roles". What ships instead: the raw counts
  (`denominatorCount`, `distinctCompanyCount`, `distinctSourceCount`), the
  suppression floor, and the partial-coverage flag.

This continues an existing commitment rather than inventing one. The
Phase 6.9 freeze record already says, of the evidence joins,
"**Phase 7 must not build scoring on these joins**". The same applies
here.

**Two bounded ratios are permitted**, each with a stated formula and an
explicit statement of what it does not mean; both are derived at read and
neither is stored as truth.

---

## D10 — What Phase 8 deliberately does not build

The Opportunity Engine is absent, and the absence is enforced.

**There is no column, and no table, connecting any `Market*` model to
`User`, `UserSkill`, `Skill`, `Experience`, `Project` or `Evidence`.** Not
even a nullable `Skill.marketSkillId` — which would in any case be a
change to a frozen model, and which, once it exists, somebody joins on and
starts scoring within a week. The absence of that join *is* the phase
boundary, and a schema-scanning test fails if one appears.

Also not built, with the trigger that would justify each:

| Not built | Trigger to revisit |
| --- | --- |
| `jobFitScore`, `opportunityScore`, `recommendedJob`, learning recommendations | Phase 9, by definition |
| Embeddings, vector storage, semantic retrieval | The alias-miss rate stays high *after* the dictionary is genuinely curated. Fix the dictionary first — it is cheaper and auditable |
| Cross-source posting identity | Measured overlap between two sources exceeds a few percent. **Measure before building** |
| `MarketCompany` entity | A signal is keyed by company rather than merely counting distinct ones |
| Salary modelling | Most sources report it. Greenhouse does not, and a salary signal over the sources that happen to publish it is a signal about disclosure regimes |
| Location / geography normalization | A signal is segmented by geography |
| Seniority ontology | A signal is segmented by seniority. The raw seniority token is preserved meanwhile, so the evidence to build one accumulates |
| Role hierarchy, career ladders, role adjacency | Phase 9, and then as a signal with a denominator — not as an edge table |
| Term frequency weighting of skill mentions | Never at this phase. A skill named ten times in a verbose posting is not more required than one named once |

**There is no `MarketRoleSkill` edge table.** "Backend Engineer requires
TypeScript" is not a fact anyone observed — nobody published it and no
source asserts it. It is a computed statement with a numerator, a
denominator, a window, a company count and a ruleset version, which is the
definition of a signal. A dedicated edge table is that same statement with
its provenance thrown away, and within a month somebody adds `+ 0.1 if
trending` and it becomes an undefendable number the product renders as
fact. The role–skill edge *is* `MarketSignal` with
`signalType = ROLE_SKILL_PREVALENCE`.

---

## The completeness contract

Extends Phase 7's, in the same words where the meaning is the same.

1. **A run that read fewer boards than it was asked for is `PARTIAL`,
   never `SUCCEEDED`.** Status is **derived inside `finish()` from the
   per-board coverage records — never accepted from the caller**, exactly
   as `ExternalSyncRunService` does today.
2. **`null` is never `0`.** A posting whose description could not be read
   is not a posting with no requirements. An unestablished count is null
   and must render as "not established".
3. **Absence from a run is never deletion.** A posting missing from a run
   may have been missed to a rate limit or an error. Closure requires
   either an explicit source signal or absence across complete runs whose
   coverage provably included it.
4. **A signal computed over a window containing a partial run is computed
   and flagged, not refused and not silent.** "PARTIAL is not a failure" —
   refusing would discard real observations, and under a rate-limited
   steady state most runs are partial, so blanket refusal means never
   computing anything. The signal carries `coverageComplete = false` and
   its counts are stated as lower bounds.
5. **A trend or delta across two windows with mismatched coverage is
   refused outright.** A flag is not enough here, because a coverage
   change manufactures a trend indistinguishable from a real one. Phase 8
   ships no trend signal, so this rule is currently vacuous — it is
   recorded because the first person to add one will need it.

---

## Determinism rules

Each is a test, not an aspiration.

1. One hash primitive: `canonicalHash(v) = sha256hex(canonicalJson(v))`,
   built on the existing serializer. No Phase 8 module calls `createHash`
   directly.
2. Every hash input is an **object** through `canonicalJson`, never a
   concatenated string — concatenation is ambiguous whenever a field can
   contain the separator, and `sourceSlug` can.
3. `canonicalJson` preserves array order, so **every array is sorted with
   a total comparator before hashing**.
4. Every comparator is **total**: it never returns 0 for two distinct
   items, and its last term is a unique column.
5. Postings are ordered by numeric source id ascending. Not by title,
   which changes; not by the order the API returned them, which is stable
   today but is an internal artifact we were not promised.
6. `localeCompare`, `Intl.*` and `toLocale*` are banned in the
   normalization and signal layers — all are ICU-version dependent.
7. Every `findMany` feeding a computation or a serialized response has an
   explicit `orderBy` ending in a unique column.
8. The clock is injected. The pure layers contain no `Date.now()`, no
   `new Date()`, no `Math.random()`. A missing injected instant throws
   rather than falling back to now.
9. All instants are ISO-8601 with an offset, re-emitted through
   `new Date(Date.parse(x)).toISOString()`. A zone-less date-time is
   refused, not coerced — ECMAScript reads it as local, so accepting one
   fabricates a different instant per machine.
10. Normalization begins NFKC → strip zero-width → casefold → collapse
    whitespace → trim, in that order, and the order is part of the ruleset
    version.
11. No float anywhere: counts are integers, and no `Market*` model
    declares a `Float` column.
12. Identity columns appear in `create` and never in `update`.
    `firstSeenAt` appears in no update payload.
13. `lastSeenAt` advances by `GREATEST(old, new)`, so a late-finishing
    retry cannot walk it backwards.
14. Idempotency rests on a unique constraint plus P2002 recovery, never on
    a "does it exist?" pre-check — under READ COMMITTED two overlapping
    runs both read "absent" and both insert.
15. No nullable column appears in a unique key. Postgres treats NULLs as
    DISTINCT, so a nullable key column silently permits unlimited
    duplicates — the trap the `Evidence` schema comment already documents.
    Where a signal legitimately has no skill, two **partial** unique
    indexes are used instead.

---

## Out of scope for Phase 8

Opportunity Engine, Next Best Action, job matching, fit or opportunity
scoring, learning recommendations, user-to-market joins of any kind,
embeddings and vector search, cross-source posting identity, salary
modelling, geography normalization, seniority ontology, role hierarchy,
trend and delta signals, a job-search UI, and any write to a Career Graph
or Phase 7 table.

---

## Verified against the live API on 2026-09-08

- `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
  returns 200 with no credentials for `vercel`, `stripe`, `figma`.
- The whole board arrives in one response with a `meta.total` that matched
  `jobs.length` on all three.
- `id` is a JSON number, unique within a board, within safe-integer range.
- `updated_at` and `first_published` are ISO-8601 **with a numeric
  offset** (`-04:00`), not `Z`.
- `content` is HTML-entity-escaped HTML — it must be unescaped *before*
  tags are stripped, or a skill extractor reads `lt div class quot`.
- Two consecutive requests returned **byte-identical** bodies, in an order
  that is neither id order nor title order.
- The key set **differs between boards**: `stripe` and `figma` return
  `education`; `vercel` does not.
- An unknown board returns 404 with `{"status":404,"error":"Job not
  found"}`.
- `application_deadline` was null on all 864 postings sampled.

## Known unknowns

- **No terms of service governing the Job Board API were found.** The
  position is unaddressed, not permitted, and is recorded as such in
  `MarketSource.licenceBasis`. Before this ships to real users somebody
  should get that in writing.
- Greenhouse publishes no rate limit. Twenty rapid sequential requests all
  returned 200. The client applies its own ceiling regardless.
- Whether response ordering is *guaranteed* stable is unknown; it was
  observed stable. The adapter imposes its own ordering and does not rely
  on it either way.
- `expectedPostingLifetime` has no measured value yet. See D7.
- The overlap rate between two sources carrying one job is unmeasured, so
  the decision in D5 not to collapse is a decision to preserve
  information, not a measured claim that overlap is rare.

---

## Phase 8.2 amendment — what an adversarial review changed

The architecture above was reviewed against the committed schema and
migration by a reviewer whose brief was to break it. It found three
defects that would have shipped, and roughly fifteen smaller ones. What
follows is what changed and why, because the reasoning is worth more than
the diff.

### The freshness design contradicted itself

`MarketPosting.lastCompleteCoverageAt` was the input that distinguished
"this job closed" from "we could not tell". The only code that touches a
posting row is the ingest path, and the ingest path only touches postings
it **saw** — so for a posting that had disappeared from a board, the
column could never advance. It would have reported `UNAVAILABLE` forever,
and `AGING` and `STALE` would have been unreachable: the product could
never have said a job closed.

The obvious repair — a bulk update across every posting in a scope after
each run — is exactly the sweeper that D7 gives as its reason for deriving
freshness rather than storing it. The decision forbade the only mechanism
its own function required.

**Fixed** by deleting the column and adding `MarketRunScopeCoverage`: one
append-only row per run per board, recording whether that scope was read
and whether it was read completely. "Has this posting's board been
completely read since we last saw it" becomes a `MAX` over that table. No
per-posting write, no sweeper, and D7's reasoning intact.

That one table also closed two other holes. The completeness contract
claimed a run's status was "derived from the per-board coverage records",
and there were no such records — only a nullable `stats` JSON column
supplied by the same caller whose claim it was meant to check, which is
precisely the failure Phase 7 already learned the hard way. And
`MarketSignalRun.coverageComplete` could only have been computed
source-wide, so a signal over two boards would have been flagged because a
third, unrelated board 404'd — and a flag that is always on is a flag
nobody reads.

### A single DELETE could have destroyed every observation

Every foreign key pointing at an ingestion run or a source was `CASCADE`.
Deleting one run row would have removed the posting versions it first saw,
cascaded to every later sighting of those versions, orphaned the postings,
and left every signal computed from them still rendering with its evidence
gone. `DELETE FROM "MarketSource"` would have taken the entire observation
graph while leaving the published numbers intact.

**Fixed:** `RESTRICT` on `MarketPostingVersion.firstSeenRunId`,
`MarketPostingSighting.runId`, `MarketRunScopeCoverage.runId` and
`MarketPosting.sourceId`. A run row is about a kilobyte. There is no space
argument for deleting one, and `RESTRICT` makes "raw payloads are
retained" a property of the database rather than a promise in a document.

### The content hash was undefined, and the obvious reading was ruinous

"Stabilized content" appeared three times in the schema and was defined
nowhere. Under the reading the schema's own comment implied — everything
except `capturedAt` — `sourceUpdatedAt` and the raw payload were both in
the hash. Two consequences, both bad:

- an ATS bumps `updated_at` when a recruiter touches a requisition, with
  the advertised text byte-identical. Every internal edit would have minted
  a new version carrying a full description and a full payload. A nightly
  HRIS sync across a 620-job board is megabytes a day of rows recording
  nothing that happened in the market, and the three-table split would have
  degenerated into one row per fetch — worse than the model it exists to
  avoid, because each row is now 20KB instead of 50 bytes;
- Greenhouse returns `education` on some boards and not others. The day it
  starts returning it on the rest, every posting on those boards mints a
  version simultaneously: a vendor schema change recorded as a market
  event.

**Fixed** by defining the hash as an explicit allow-list of the fields this
system reads, with `sourceUpdatedAt` and the whole payload named as
excluded, and by adding `contentHashVersion` to the version's uniqueness
key so that changing the rule later produces a labelled split rather than
a simultaneous phantom edit to everything. The source's update claim is not
lost — it moved to `MarketPostingSighting.sourceUpdatedAt`, where it is
recorded per observation and answers "the source says it changed but the
text did not".

### Smaller repairs, each closing a real hole

- **Four dangling pointers.** `roleAliasId`, `aliasId` and both
  `supersededById` columns had no foreign key. Deleting a mis-curated alias
  would have left every historical mention citing a UUID that resolves to
  nothing — and those rows are the answer to "why did Shipaton map
  'Postgres' to PostgreSQL?". All four are now `RESTRICT` foreign keys.
- **Prevalence could have exceeded 100%.** `MarketPostingSkillMention`
  carried a denormalized `rulesetVersion` with nothing keeping it equal to
  its parent's. A half-finished re-normalization would have put a mention
  in v2's numerator while its posting sat in v1's denominator, and with no
  ratio column and no constraint, nothing anywhere would have noticed. The
  foreign key is now composite on `(normalizationId, rulesetVersion)`, so
  the drift is unrepresentable.
- **A version could have existed with no sighting.** The sighting key was
  `(runId, postingId)`. A paginated source that legitimately returns one
  posting twice in a walk, edited between the two pages, would have written
  the second version and then failed to record a sighting for it — and
  since signal windows filter on sightings, that version would have been
  invisible to every signal ever computed. `versionId` is now in the key.
- **No total ordering for "the current version".** `observedAt` is
  millisecond-resolution and ties are ordinary; the only other unique
  column on a sighting was a uuid4, which is total but *different between
  dev, CI and production* — the same defect that keeps `sourceId` out of
  derived posting identities, one layer down. `MarketIngestionRun.runSeq`
  is now a database sequence, denormalized onto the sighting.
- **Volume was a number that reads as 100%.** `ROLE_POSTING_VOLUME` had
  `numerator == denominator`, so any generic renderer would have shown
  every role as 100%. Its denominator is now every posting that entered
  role resolution, which makes it a real share and lets two windows sum.
- **Four CHECK constraints** were claimed in this document and existed
  nowhere. `MarketSource.slug` and `MarketPosting.sourceScope` now have
  shape constraints, and two biconditional constraints make "unmapped but
  has a role" and "unmapped but has a skill" unstorable.
- **`sourceCategoryRaw` was a singular column over a source field that is
  an array**, and the only way to fill it would have been to take element
  zero — which would make the value depend on the source's array order,
  the one thing every determinism rule here refuses to trust. It is now
  `sourceCategoriesRaw String[]`, ordered by the adapter.
- **`isEnabled` defaulted to true**, so a source became live as a side
  effect of inserting a row — failing open on the single dimension this
  document admits is unresolved. It now defaults to false, is set
  explicitly with the licence note beside it, and ingestion refuses a
  disabled source rather than leaving the column decorative.
  `mayRedistributeDerived` was added and left false: ingesting for internal
  analysis and publishing to users are different permissions.
- **`internal_job_id` was being discarded.** Greenhouse states a
  requisition id alongside the post id, and one requisition advertised in
  three cities is three posts sharing it — so volume overcounts openings.
  It is now stored as `externalGroupKey`. It could not have been recovered
  later: Greenhouse deletes closed postings.
- **`MarketSignalRun` had no idempotency guard** while ingestion had one.
  A partial unique index now allows one running computation per scope.
- **Two semantic timestamps defaulted to `now()`**, falling back to a third
  clock nobody injected. The defaults are gone; both are required.
- **`seniorityTermRaw` named an inference.** No source in scope asserts
  seniority; our parser classified a token. Renamed `titleModifierRaw`,
  which says what it is.
- **"Demand"** was the word in the schema header. A posting is an
  advertisement — ghost jobs, evergreen pipeline reqs and multi-city
  duplicates are all postings and none is an opening. The header now says
  what employers are advertising, because "demand" is the hook a
  `demandIndex` column would later hang from.

---

## What was found by running it, not by reading it

Three defects survived design review and were caught only by execution.
They are recorded because they are the argument for building the thing
rather than only specifying it.

1. **`"Stripe, Inc."` folded to `"stripe,"`.** The legal-suffix strip ran
   after a single trailing-punctuation pass, so the comma survived. That
   makes `stripe,` and `stripe` two distinct employers — inflating
   `distinctCompanyCount`, which is the exact number that exists to reveal
   a single-employer sample. Found by a table-driven test, not by review.
2. **"Director of Engineering" resolved to nothing.** `director` was
   stripped as a title modifier *before* the alias lookup, leaving "of
   engineering", so the alias for the whole phrase could never be reached
   and a real role silently joined the unmapped backlog. The whole title is
   now tried first. Found by running the normalizer over 864 live postings
   and reading the unmapped list.
3. **The determinism guard was unreachable.** `normalizePending` selects
   only versions with no normalization at this ruleset version, so the
   read-compare-throw could never fire. It now also runs on the P2002
   recovery path, where two concurrent normalizers actually meet — which is
   both a real race and the only place the guard can bite.

---

## Verified end to end on 2026-09-08

Against the live Greenhouse API, eleven board tokens, ten real and one
deliberately wrong:

```
ingest    2955 postings accepted, 0 rejected, 0 duplicates
          11 boards requested, 10 read  ->  status PARTIAL, never SUCCEEDED
normalize 2955 normalized, 6826 skill mentions, 1954 titles unresolved
signals   246 signals, coverageComplete true over the 10 readable boards
```

- **Idempotency on live data.** A second identical run created **0
  postings and 0 versions**, and 2955 new sightings. Re-observing is real
  new information; the content is not.
- **The completeness contract fired for real.** `benchling` returned 404
  and the run reported `PARTIAL`. A 404 is recorded as *not read* and *not
  complete*, never as "this employer has no jobs" — the body is identical
  for a typo, a rename and a genuine retirement.
- **The concentration control does its job.** `PostgreSQL` appears in 23 of
  53 Backend Engineer postings — 43% — from **one** employer.
  `distinctCompanyCount = 1` is published next to it, so the number cannot
  be read as a market fact. Likewise `Scala` at 22% of Software Engineer
  postings across three employers.
- **Role resolution reaches about a third of postings** (1001 of 2955).
  The unresolved majority is overwhelmingly non-engineering — account
  executive, program manager, sales — which is the vocabulary being
  honest about its scope rather than force-mapping. The backlog is exposed
  at `GET /v1/market/unresolved-titles`.

Tests: **251 across 10 files** for the Market Graph. The full API suite is
**662 passing, 2 failing** — both failures pre-existing in
`auth.service.spec.ts` on the base branch, unrelated to this phase and
deliberately not fixed here.

---

## Accepted residuals

Known, reasoned about, and not fixed in Phase 8.

- **A value-join could still cross the phase boundary.** The tests forbid a
  foreign key, an import and a Prisma call across the two graphs, but
  nothing stops a future Phase 9 query reading `MarketSkill.slug` values
  and matching them against `Skill.normalizedName` in application code. The
  fix, if it becomes a real risk, is to namespace market slugs so a
  value-join returns nothing.
- **A list-only sighting is not representable.** A two-hop source that
  lists a posting and then fails to fetch its detail has no honest row:
  `MarketPostingSighting.versionId` is NOT NULL, so the choice is to point
  at stale content or to lose the observation. The fix is a nullable
  `versionId` plus a sighting-outcome enum. Not reachable with Greenhouse,
  which returns everything in one response.
- **Market timestamps are `timestamp(3)`, not `timestamptz`.** This matches
  the rest of the schema, and everything goes through Prisma, which
  converts to UTC. The precision risk it creates for ordering is closed by
  `runSeq` instead.
- **Skill terms have no discovery mechanism.** The unmapped backlog is real
  for titles and empty for skills, because extraction is dictionary
  matching: a term we do not know is a term we never saw. Finding unknown
  skills in prose needs a candidate extractor, deliberately not built.
- **Cross-source duplicates are not collapsed**, and the overlap rate is
  unmeasured. Counts are therefore postings, never jobs, and the API says
  so.
- **`ROLE_POSTING_VOLUME` counts posts, not requisitions.**
  `externalGroupKey` is stored so a later phase can count either.

## Not verified

- The iOS simulator. The mobile screen is written, typechecks clean and
  follows the existing UI kit, but it was not run on a device: doing so
  needs Supabase credentials that were deliberately not copied into this
  worktree. What *is* verified is the API it calls — the route table is
  pinned by test, and every endpoint returns 200 to an authenticated
  request and 401 without one.
- Behaviour under a real rate limit. Greenhouse publishes no limit and did
  not throttle; the client's backoff is exercised by scripted responses,
  never by the live service.
- Whether a Greenhouse posting id survives an unpublish and republish. If
  it does not, a repost reads as a new posting with today's `firstSeenAt`.
- Long-run version growth. The content-hash exclusions are reasoned from
  two same-day fetches, not from a week of observation.
