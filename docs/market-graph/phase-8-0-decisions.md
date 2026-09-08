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
purpose.

> **Corrected at 8.9.** The sentence that stood here said it "was null on
> all 864 postings sampled, so freshness does not depend on it today". That
> was true of Greenhouse and is false of the corpus: JobTech supplies
> `application_deadline` on **6671 of 6671** versions, Greenhouse on 16 of
> 2958, so **69% of stored postings now carry an employer-stated expiry**
> and the `SOURCE_STATED` path is live rather than dormant. Wiring
> freshness exposed a defect in that path which the null corpus had hidden:
> the lifetime was `sourceValidThrough - firstSeenAt`, which made a
> posting's advertised life a function of when our crawler started looking
> — an ad first seen the day before its deadline got a one-day lifetime,
> and an ad already expired when we found it got a negative one, which
> `Math.max(lifetimeMs, freshWindowMs)` absorbed into the fresh window and
> made `AGING` unreachable for it. The lifetime is now the minimum of the
> employer's deadline and `lastSeenAt + expectedPostingLifetimeDays`, and
> `lifetimeBasis` names whichever of the two actually bound the answer.

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
- `application_deadline` was null on all 864 postings sampled. (True of
  Greenhouse only; JobTech supplies it on effectively every ad.)

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
- **Two independent computations over the same observations produced
  byte-identical counts.** 246 signals each, compared row by row on
  (type, role, skill, numerator, denominator, company count), with no row
  present in one and absent from the other.
- **An unknown scope fails closed, demonstrated by accident.** A malformed
  invocation passed all ten board tokens as a single scope string. The
  computation returned zero signals and `coverageComplete: false` rather
  than silently falling back to everything it had - which is the intended
  behaviour, and it was observed rather than assumed.
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

---

## Phase 8.8 — hardening, and a second source

Ten parallel reviews were run against the committed implementation: an
audit, an adversarial critic, and one each for employer normalization,
role normalization, source research, contract neutrality, determinism,
provenance, security and test quality. Between them they found four
defects that would have shipped, several claims in this document that the
code did not support, and one class of bug that only a second source could
ever have exposed. What follows is what changed, and what did not.

### The four that would have shipped

**A signal computation silently dropped three quarters of its input, and a
different three quarters per machine.** `MAX_POSTINGS_PER_RUN` was named
for postings and applied as `take` on the SIGHTING query. Sightings
accumulate one row per posting per run, so at this source's own configured
daily poll and the default thirty-day window, 2955 postings produce 88,650
sightings — the ceiling binds on the seventh day. At day thirty the
computation would have seen roughly 667 postings and reported
`postingsInWindow: 667` as though that were the window, with
`coverageComplete` still true. And because the query's leading sort key is
`postingId`, a uuid minted per environment, dev, CI and production would
each have dropped a *different* three quarters. That is precisely the
machine-local ordering this document warns against, in the query those
warnings annotate.

Fixed by paging the walk to exhaustion instead of cutting it, and by
throwing when a genuine posting ceiling is exceeded. A computation that
cannot see all of its input must refuse to answer: an answer from a
silently truncated sample is indistinguishable from a correct one.

**One crashed computation bricked a scope permanently.** The migration
adds a partial unique index allowing one RUNNING signal run per scope, and
argues eight lines earlier — for the *ingestion* index — that "the
constraint and the lease are one mechanism and neither is safe without the
other". The signal run shipped with the constraint and without the lease.
Any throw between opening the run and closing it left a RUNNING row that
no later computation could get past, recoverable only by hand-written SQL.
Fixed with the same thirty-minute reclaim the ingestion run has, plus a
try/catch that fails the run.

**A mistyped argument could become the published market.** Two runs in the
database carried a single scope containing ten space-separated board
tokens, matched nothing, and were written `SUCCEEDED` with zero signals.
The read side takes the most recent `SUCCEEDED` run, so a typo was one
minute away from serving "the market contains no roles" — the
null-rendered-as-zero failure this contract exists to forbid. Fixed three
ways: scopes are validated against the same shape the migration enforces
on postings, a run that observed nothing is `FAILED` rather than
`SUCCEEDED`, and a run with no signals can never be the snapshot.

**Every P2002 recovery on the ingest path was dead code.** `PrismaService`
uses the `PrismaPg` driver adapter, and under a driver adapter Prisma does
not populate `meta.target` at all — it populates
`meta.driverAdapterError.cause.constraint.index`. Verified against the
live database: a duplicate slug yields `meta.target === undefined`. So the
constraint check returned false for every P2002, and the sighting
insert's "a retry of the same run is a no-op, which is what makes
re-running a failed ingest safe" was in fact "a retry re-throws and kills
the run". Unreachable with a source that returns each posting once per
walk. Reachable on the first walk of a paginated one.

### The publication floor guarded a different number than it published

The rule stated in D8 — a prevalence row is written only if
`distinctCompanyCount >= minDistinctCompanies` — was false of the very
column it named. The floor was applied to the company count of the whole
eligible cohort while the row published the company count of the
*mentioning subset*. Measured: **196 published prevalence rows carried
`distinctCompanyCount = 1`**, below the run's own recorded floor of 2.

Worse, this document then cited one of those rows as evidence the control
worked. Both statements cannot be true, and it was the rule that was
wrong. The floor now guards both counts — the cohort decides whether the
sample is broad enough to ask the question, the subset whether the answer
rests on more than one employer — and after the fix the minimum published
`distinctCompanyCount` is exactly 2 across 177 rows.

### Two normalization bugs found by running it, not reading it

**168 titles had their job word deleted.** `stripSeniority` matched the
head *and* the tail, so any title ending in Director, Lead, Staff or
Associate lost it: "Art Director" became "art", "Team Lead, ARC Software
Engineering" became "team", "Sr. Director, Procure to Pay" became "sr.".
Measured across 2955 live postings: 168 tail strips, of which exactly one
resolved a role. It also scanned the token list in array order, so "Senior
Director" stripped `director` purely because that entry precedes `senior`
— which level word survived was decided by array position rather than by
any rule. Stripping is now leading-only, repeats to a fixed point, and
refuses a strip that would leave a dangling preposition.

**Four employers folded into one.** `normalizeCompany` had no guard
against stripping a name down to nothing, so "The Limited", "The Corp",
"The Co" and "The Inc" all became "the". It was also non-idempotent, which
meant the stored column could never safely be re-fed through the function
and any future backfill was a trap. It now loops to a fixed point and
refuses any removal that would not leave a name.

Both changes alter what already-ingested postings are read to say, so
`RULESET_VERSION` moved to 2 and the v1 normalizations were retained
rather than rewritten.

---

## D11 — The second source is JobTech, and the licence is why

**Decision.** The second source is the JobTech / Arbetsförmedlingen
JobSearch API (Sweden).

**Why.** It is the only source surveyed with an affirmative licence.
Everything else is either silent or prohibitive: Adzuna names aggregation
into vacancy counts in its prohibited list; Arbeitnow's terms limit use to
"personal, non-commercial transitory viewing"; Himalayas bans commercial
use in one clause and invites backfilling job boards in another;
WeWorkRemotely's terms return 403 to every request, and a source whose
terms cannot be read is not one to build a commercial product on. JobTech
is **CC0** — a public-domain dedication, verified in the API's own
`swagger.json` (`"license": { "name": "Ads are licensed under CC0" }`) and
in Arbetsförmedlingen's open-data catalogue. Commercial use, durable
storage and redistribution of derived aggregates are permitted outright.

It is also shaped unlike the first source on almost every axis, which is
what makes it a test of the abstraction rather than more of the same data:

| | Greenhouse | JobTech |
| --- | --- | --- |
| discovery | per-company board token | national, queried |
| pagination | none — whole board in one response | offset, with a hard server cap |
| envelope | flat `{ jobs }` | `{ hits, total: { value } }` |
| ids | JSON numbers | strings |
| published | ISO with a numeric offset | naive ISO, **no offset at all** |
| updated | ISO | epoch **milliseconds** |
| expiry | null on all 864 sampled | populated on effectively every ad |
| taxonomy | free-text departments | coded concept ids + SSYK |
| employer id | a display string | an organisation number |

**What this cost, stated plainly.**

1. **CC0 does not clear GDPR, and this is the more important constraint.**
   The dedication waives copyright and expressly disclaims privacy rights.
   Swedish ads carry named individuals: measured on a live sample of 25
   postings, **9 carried `application_contacts` holding 13 personal email
   addresses and 13 mobile numbers**. The adapter therefore strips contact
   details before the payload is stored — the one place in either adapter
   where something is deliberately dropped rather than preserved, and a
   deliberate override of the rule that raw observations are kept verbatim.
   The employer, the role and the requirements survive; only the way to
   phone a named recruiter is gone.

   > **Corrected at 8.9, and this correction matters more than the claim it
   > qualifies.** The paragraph above is true of the *structured field* and
   > false of the *ad body*. `application_contacts` and the employer's
   > `email` / `phone_number` are stripped; nobody strips
   > `"Vid frågor vänligen kontakta Rekryteringskonsult <name> på <phone>,
   > eller <email>"` out of the description. Measured on the stored corpus:
   > **2320 of 6671 JobTech `descriptionRaw` rows contain an email address
   > (1420 distinct, 1670 of `firstname.lastname@` shape) and 993 contain a
   > Swedish mobile number**; `MarketPostingNormalization.descriptionText`
   > mirrors it; Greenhouse adds 389. So the phase stores roughly 1400
   > distinct personal email addresses and about a thousand recruiter
   > phone numbers, and the honest statement is that contact stripping
   > reduced the exposure rather than removed it.
   >
   > Nothing leaks today — neither column appears in any read `select` —
   > and as of 8.9 that is enforced by a test rather than by convention.
   > But "the contact block never reaches the database" was too strong, and
   > the deletion path this now needs is the purge, which 8.9 builds.
2. **Sweden only, and only Platsbanken.** Roles posted solely on a company
   site or LinkedIn are absent, so absence is not evidence of absence.
   Descriptions are in Swedish, so the skill dictionary — built for English
   prose — sees far less than it does on the first source.
3. **The id is not promised stable.** It is documented nowhere as
   permanent or non-reused. `MarketIdentityBasis` records `SOURCE_ID` as an
   observed property, which is exactly why the basis is stored beside every
   posting rather than assumed.
4. **Three of five scopes cannot be read completely.** The offset cap is
   2000 and the Data/IT field holds 2535 ads. That is not a defect; it is
   the first time the pipeline has had to say so.

### What the second source proved, and what it broke

The canonical schema needed **no change at all** — no new column, no
migration, no altered semantics. `RawPostingRecord` held every JobTech
field. That half of the multi-source claim was already true.

The *pipeline* was not. `MarketIngestionService` was a Greenhouse driver
under a general name: it constructed the adapter as a field, took the
concrete client in its constructor, exposed one method named after the
source, hard-coded `'SOURCE_ID'` twice while both
`MarketSource.identityBasis` and `SourceAdapter.identityBasis` existed and
neither was read, imported one source's politeness delay as the pipeline's
pacing, and matched one error class to classify every failure. The
contract seam was real for parsing and absent for everything around it.

Fixed by extending the contract to the fetch side — a `SourceClient` with
`fetchScope(scope, cursor)`, `classifyFailure` and its own pacing, and a
`SourceDescriptor` carrying the adapter, the client, the query parameters
and the licence position. Sources are now declared in one registry file
and nothing else names one. The seventh source is a directory and a
registry entry.

**The bug only a second source could expose:** `read` and
`completeForScope` were two columns set from one boolean, and
`deriveRunStatus` branched only on whether a scope was read. A paginated
source that fetched page 1 of 40 on every scope would have reported
`SUCCEEDED`. On the first live JobTech run, three of five scopes hit the
offset cap — the run correctly reported `PARTIAL`, `scopesRead: 5`,
`scopesComplete: 2`.

---

## Verified end to end on 2026-09-08, both sources

```
jobtech    5 scopes, 20 pages each on the three that hit the cap
           6671 postings accepted, 0 rejected, 1 duplicate across pages
           scopesRead 5, scopesComplete 2  ->  PARTIAL
           signals 55, coverageComplete FALSE

greenhouse 11 scopes requested, 10 read, 10 complete  ->  PARTIAL (one 404)
           2955 postings, 2 created, 3 new versions, 2955 sightings
           signals 158, coverageComplete TRUE
```

- **Both sources reach the same canonical graph.** `python` is observed in
  both, and every observation retains its source and scope:
  `greenhouse/databricks 334`, `jobtech/data-it 330`,
  `greenhouse/anthropic 174`, `jobtech/teknik 94`. Nothing is collapsed.
- **The coverage flags differ honestly.** Greenhouse's signals carry
  `coverageComplete: true`; JobTech's carry `false`, because three of its
  scopes were read but not read to the end.
- **A paginated source really did return one posting twice**, and the
  per-scope dedupe caught it — `duplicatesDropped: 1`. Per-page dedupe
  would have missed it.
- **Re-ingesting Greenhouse created 2 postings and 3 versions** out of
  2955 — real drift at the source since the previous run, not churn.
- Tests: **321 Market Graph tests**, up from 251. Full API suite **732
  passing, 2 failing** — the same two pre-existing `auth.service.spec.ts`
  failures on the base branch, unrelated to this phase.

---

## Accepted residuals, restated honestly

Several claims in the sections above this one were found to overstate what
was built. They are corrected here rather than quietly edited, because the
overstatement is itself worth recording.

- **Freshness is written and tested, and not delivered.**
  `classifyFreshness` has zero production callers. Nothing computes
  `lastCompleteCoverageAt`, no API response carries a verdict, and the two
  `MarketSource` columns that exist to feed it are only ever echoed back.
  D7 describes it in the present tense throughout; it should be read as a
  design that is implemented at the unit level and not wired up.
- ~~**`explainSignal` shows an approximation of the contributing set.**~~
  **Resolved at 8.9, and this entry understated it.** The claim that it was
  "right on the current corpus by coincidence" was wrong: measured on the
  run the read side was actually serving, the endpoint returned **168
  mention rows for a signal whose numerator was 22, 145 of them from the
  other source**, and returned the *identical* rows as the explanation for
  a different signal whose numerator was 145 — so the explanation carried
  no information about which signal it explained. The failure did not exist
  while there was one source and was introduced silently by the second.
- **`distinctCompanyCount` is a board count on the first source.**
  Greenhouse's `company_name` is a board-level constant — one company per
  board, always — so an employer running two board tokens counts as two
  employers and clears the floor. JobTech's `organization_number` is a real
  legal-entity id, so the second source is the first one where this number
  means what it says.
- **`mayRedistributeDerived` is recorded and surfaced but not enforced.**
  No read endpoint checks it. Gating reads on it today would silently empty
  the market for the source whose position is unresolved rather than raise
  the question, so it is exposed instead of enforced — and named here so
  the choice is visible.
- ~~**There is no purge path.**~~ **Resolved at 8.9.** See the 8.9 section.
  The observation about direction stands and is now load-bearing rather
  than incidental: `DELETE FROM "MarketPosting"` cascades to five tables in
  one statement and the RESTRICT graph does not stop it, so the guard
  against that is a reviewed method and a test, not a constraint.
- **No historical recomputation has been exercised.** `compute` now takes
  a `rulesetVersion`, so a v1 signal *can* be recomputed under v1 rules,
  but nothing has done it and no test covers it.
- **Cross-source deduplication is deliberately absent.** The same job on
  two sources stays two observations. Counts are postings, never jobs, and
  the API says so.
- **Live rate limiting is still unobserved.** Neither source throttled.
  Backoff is exercised only against scripted responses.
- **The iOS simulator has still not been run**, for the same reason: the
  Supabase credentials are deliberately not in this worktree.
- **The tombstone feed is not modelled.** JobTech's stream emits removals
  as a stub with no title; the adapter refuses and counts them. Recording a
  delisting — which would give true posting lifespans — is unbuilt.

---

# Phase 8.9 — the three blockers

The 8.8 review ended at **NOT READY** with three named blockers: freshness
was implemented but unwired, `explainSignal` described a population that
was not the one the signal came from, and there was no way to honour a
takedown. This section records how each was closed, and what is still not
true afterwards.

Six review agents worked the problem in parallel before any code changed.
They disagreed in three places that mattered, and the disagreements are
recorded here because the resolutions are the design.

## Blocker 1 — freshness, wired

**Where it went, and the argument that decided it.** One agent proposed a
per-*scope* verdict on `GET /v1/market/sources`, deriving a scope's
`lastSeenAt` from its coverage rows. Two others rejected it, and correctly:
freshness is a property of an **observation**, coverage is a property of a
**sampling frame**, and reporting the second under the first imports a
claim about the market onto a claim about our crawler. A scope has no
`lastSeenAt`, and manufacturing one as `MAX(posting.lastSeenAt)` is very
nearly `MAX(coverage.finishedAt)` for the same scope — so the coverage gate
would compare a number against itself and `UNAVAILABLE` would become
structurally unreachable.

So the verdict stays per-posting, and it surfaces on **`GET
/v1/market/signals/:id`**, where each contributing row *is* a posting and
"can I trust this evidence?" is the endpoint's whole job. No new route, no
new column, no new resource.

**The derivation, and the two mutations it exists to stop.**
`lastCompleteCoverageAt` is `MAX(finishedAt)` over `MarketRunScopeCoverage`
**grouped by `(sourceId, sourceScope)`** and **filtered to
`completeForScope = true`**. Both halves were measured against the live
corpus:

| derivation | UNAVAILABLE | FRESH |
|---|---|---|
| correct — per scope, complete reads only | 5999 | 3629 |
| grouped per **source** | 2000 | 7628 |
| **without** the `completeForScope` filter | 0 | 9628 |

Grouping per source lends one scope's completion certificate to another:
JobTech's `naturvetenskap` finished at 09:19:23, and the per-source maximum
relabels **3999 postings on two scopes the offset cap made it impossible to
finish reading** as FRESH. Dropping the completeness filter is worse —
`finishedAt` is populated even on a scope that 404'd, so a failed read
counts as coverage and `UNAVAILABLE` disappears entirely for all 9628
postings. A single fixture row guards both: a scope whose only *complete*
read predates its postings' last sighting, with a *later incomplete* read
on a second run.

**The defect wiring exposed.** See the correction at D7 above: the
`SOURCE_STATED` lifetime was computed from `firstSeenAt` and is now the
minimum of the employer's deadline and `lastSeenAt + expectedPostingLifetimeDays`.

**Anti-fabrication.** `classifyFreshness` takes seven named values and no
rows, and `MarketRunScopeCoverage` has no `createdAt` or `updatedAt` at
all. The read path selects neither. `asOf` is read once, in the controller,
and echoed in the response so a verdict is reproducible by hand; the
boundary spec's no-clock scan was widened to cover `market-graph.service.ts`,
which it did not — a `new Date()` inserted there passed all 321 tests.

## Blocker 2 — `explainSignal`, filtered to its own population

Five filters were missing, not two: **source**, **scopes**, the
**eligibility conjunction** (both halves), the **latest-in-window version**
rule, and a **deterministic ordering**. The old query also counted mention
rows rather than postings, so a "sample of 10" could be five postings
against a numerator of 22, and it ordered by a uuid — making the sample a
reader saw machine-local, in the endpoint whose purpose is that two people
can check the same claim by hand.

**Recovering the source without a schema change.** `MarketSignalRun` stores
`scopes` and `sourceScopeKey` and **no source column** — the source exists
only inside `canonicalHash({source, scopes})`, which is one-way. Four of
six agents wanted a `sourceId` column. It is not added. The owner is
recovered by recomputing that key for every registered source and matching,
which is deterministic, O(number of sources), reproduces every key in this
database — including the two malformed-scope runs whose scope string
matches no posting scope on any source and which scope-name matching would
misattribute — and **fails closed**: zero matches or more than one refuses
rather than serving unfiltered evidence.

**Volume signals** return the postings that resolved to the role, labelled
`kind: 'ROLE_RESOLVED_POSTINGS'`, alongside the run's own stats as the
denominator's composition. A bare `[]` is indistinguishable from "we looked
and found nothing supports this number", which for an auditability endpoint
is the worst available answer. Eligibility is deliberately **not** applied
here: volume's denominator is every posting that entered role resolution,
and filtering it would be the same defect as omitting it from prevalence,
in the other direction.

**Not by re-derivation.** Calling the computation's own walk would
guarantee agreement and prove nothing — an audit endpoint that re-runs the
thing it audits confirms its own bugs, and would have reported the 8.8
sighting-truncation defect as correct. The predicates are written
independently and then checked against the stored number.

**Verified: 705 of 705 signals across all six runs reconstruct to exactly
their stored `numeratorCount`**, with zero cross-source and zero
out-of-scope rows — on the live corpus, not a fixture.

## Blocker 3 — a source purge

`node dist/market-graph/market-graph.cli.js purge <source> --reason=<code> [--confirm]`.
CLI only; a dry run unless `--confirm`; the route table still pins exactly
eight GET routes and no write route.

- **One transaction**, `Serializable`, 300s timeout, ordered children-first
  through the RESTRICT graph. Not chunked across transactions: a
  half-completed purge is worse than either endpoint.
- **Explicit per-table deletes, not the cascade.** `deleteMany` on
  `MarketPosting` alone would take 31,919 rows across five tables in one
  statement and report none of it. The cascade is demoted to a backstop
  that must read zero.
- **Proven inside the same transaction.** Global row counts before and
  after; every table's delta must equal exactly what the manifest claims
  and the four vocabulary tables' deltas must be zero; then every purge
  predicate is re-counted and must return zero. Anything else rolls back.
- **Signal runs attributed by scope-key preimage**, computed before
  anything is deleted, refusing the whole purge on zero or multiple owners.
  Never by scope name; never by timestamp — the two source runs in this
  database were computed **591 milliseconds apart**.
- **Vocabulary is never touched.** 17 of 19 roles and 59 of 61 skills are
  shared. They come from `ruleset.ts`, which is code, not source data;
  deleting one would be undone by the next sync with a *new* uuid, which
  converts a shared row into a silent identity split.
- **The `MarketSource` row is retained**, `isEnabled` forced false as the
  first write (conditionally, so a second purge writes nothing at all).
  Retention is what makes a repeat purge a no-op rather than a `NotFound`
  indistinguishable from a typo, and what keeps every historical run
  attributable — the slug is the preimage attribution depends on.

**Verified on a clone of the live database**, never on the live one:
Greenhouse purged (650 signals, 5 signal runs, 13657 mentions, 5913
normalizations, 8865 sightings, 2958 versions, 2957 postings, 33 coverage
rows, 3 ingestion runs); JobTech intact to the row; vocabulary unchanged at
19/61/159/232; **zero orphans across every single-column Market foreign
key**; a second purge a clean no-op; and all 55 surviving signals still
explaining correctly afterwards.

## The test tier this needed

Nothing in the repository constructed `MarketGraphService`,
`MarketSignalService`, `MarketIngestionService` or
`MarketNormalizationService` — the entire database-touching half of Phase 8
had no test of any kind, which is why both defects shipped. Deleting the
whole evidence query from `explainSignal` passed all 321 tests.

A new tier (`pnpm test:db`, `test/market-graph/*.db.spec.ts`, 39 tests)
runs against a real Postgres. That is not a preference: the two things it
proves — a purge's atomicity under RESTRICT and CASCADE, and a five-table
nested filter reproducing a signal's population — **are** the database's
semantics, and the existing in-memory double's `$transaction` is a
passthrough with no rollback, so "a failed purge leaves no partial state"
would pass there against a purge with no transaction at all. The tier
**fails** rather than skipping when its database URL is absent.

Mutation-tested, every mutation caught: removing the source filter, the
scope filter, the eligibility conjunction, **half** the eligibility
conjunction, the latest-in-window rule, returning `[]` for volume again;
and on the purge, tidying up "orphaned" vocabulary, leaving signals whose
evidence was deleted, and attributing runs by scope name.

## A correction found while auditing, not while building

**Greenhouse was enabled by default, and both briefs forbade it.**
`MarketSource.isEnabled` has a schema default of `false`, and the 8.8 work
recorded that as fail-closed behaviour — but the registry descriptor set
`isEnabled: true`, and `ensureSource` always supplies a value, so the
default was never reached. Every fresh database got an enabled Greenhouse
whose licence position is `UNADDRESSED_PUBLIC_ENDPOINT`. The comment beside
it argued that setting the flag explicitly made enabling a source "an act
somebody performed"; it did not, because the act was performed once, in
code, for everyone.

It is now `false`. `sync greenhouse` refuses until an operator flips the
column by hand, `ensureSource`'s empty update block means that decision
survives every later sync, and a new spec asserts that **no source whose
licence position is unresolved is enabled** — the rule rather than the
instance, so the next source cannot repeat it. Nothing tested this before;
that is why it drifted.

## What is still not true

- **`AGING` and `STALE` are fixture-verified only.** The whole corpus was
  observed inside 70 minutes, so nothing can reach `AGING` before
  2026-09-10 or `STALE` before 2026-10-08 — and not then if ingestion runs.
  **FRESH and UNAVAILABLE are observed on live data; the other two are
  not.**
- **The eligibility filter is fixture-verified only.** All 9629
  normalizations are `EXTRACTED` + `FULL`, so adding the conjunction
  changed not one row in this corpus.
- **`MarketSignalRun` still records no source.** Deferred deliberately
  rather than smuggled in as an additive column. Both the explain filter
  and the purge depend on inverting a hash, which works, is deterministic
  and fails closed — but a column would make both trivially correct, and
  the preimage stops working the day a run legitimately spans two sources.
  That day is a Phase 9 decision, and the refusal is the tripwire.
- **The purge leaves no durable record inside the database.** The manifest
  is returned, printed and hashed; it is not stored. Storing it needs
  either a second migration or a fifteenth model, and the phase's "one
  migration, and the second source needed none" claim is now pinned by a
  test. An operator who does not keep the manifest keeps no audit trail.
- **The advisory lock excludes other purges, not ingestion.** Ingestion is
  excluded by the pre-flight `RUNNING` check, the `isEnabled` interlock and
  the residue assertion — not by the lock.
- **A CLI-only purge is protected by nothing but shell access** to the
  machine holding `DATABASE_URL`. `--confirm` and the mandatory reason code
  are the whole of the control.
- **`mayRedistributeDerived` is now surfaced on the evidence** but still
  not enforced. The source filter incidentally removed the live leak — a
  non-redistributable source's postings were being served as evidence for a
  redistributable source's signal — but the column still gates nothing.
