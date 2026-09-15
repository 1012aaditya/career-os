# The Evidence Reliability Contract

The record of what Career OS records about its own evidence, why each
decision went the way it did, and what was deliberately left out.

Written after implementation, against code that exists. Every claim below
is either enforced by a test or is labelled as unverified.

---

## The problem this solves

Phase 7 already held real reliability properties for GitHub. It attributed
an artifact only when GitHub itself resolved it to the authenticated
account by numeric id, explicitly refusing git author email, login,
repository ownership and name similarity. It distinguished "we did not
look" from "there is nothing there". It reported counts as `null` rather
than `0` when they were not established.

All of it lived inside a metadata blob that only the GitHub adapter could
read.

So a consumer holding an `Evidence` row could not tell an authenticated
API observation from a line somebody typed into a resume, except by
switching on `sourceType` — which names where evidence came from, not how
far it can be trusted. Adding a second connector meant editing every
consumer's switch statement.

Two consequences followed, and the second is the one that mattered:

- **The strongest evidence was invisible.** GitHub evidence creates no
  Career Graph joins by deliberate Phase 7 design, and the only read path
  went through those joins. Fourteen repositories were synced,
  deduplicated and kept fresh — and read by nothing.
- **The weakest evidence drove the graph.** 100% of what a user could see
  came from their own resume.

---

## The ten questions

Every evidence row must be able to answer these. The mechanism is a
column, not a convention.

| | Question | Mechanism |
|---|---|---|
| 1 | WHO does this belong to? | `userId`, set by the persistence layer from the authenticated connection — never by a projection, never by a request |
| 2 | WHERE did it originate? | `sourceType`, `sourceUrl` |
| 3 | WHAT was observed? | `title`, `description`, `metadata` |
| 4 | WHEN? | `occurredAt` · `capturedAt` · `lastObservedAt` |
| 5 | WHY is it theirs? | `attribution` |
| 6 | HOW is it traceable? | `externalId` (immutable at source) + `sourceUrl` |
| 7 | HOW complete? | `completeness` |
| 8 | HOW transformed? | `transformVersion` |
| 9 | Independently corroborated? | `independenceKey` |
| 10 | What does it NOT establish? | The signal layer — see below |

Question 10 is deliberately **not** a column. A limitation is a property
of an inference, not of an observation: the same repository supports
"contributed to a TypeScript project" and refutes nothing at all.

---

## The dimensions

Three stored enums, ordered strongest to weakest. Nothing may promote a
row up any of these lists.

**`authenticity`** — how directly the information came from the thing it
describes.
`DIRECT_API_OBSERVATION` · `VERIFIED_ARTIFACT` · `USER_PROVIDED_ARTIFACT` ·
`USER_CLAIM` · `MODEL_INTERPRETATION`

**`attribution`** — why we believe it belongs to this user.
`AUTHENTICATED_ACCOUNT` · `VERIFIED_OWNERSHIP` · `EXPLICIT_AUTHORSHIP` ·
`USER_ASSERTED` · `WEAK_MATCH`

`WEAK_MATCH` exists so name similarity can be *excluded*, not used. Anyone
can set a git author email to anyone's address.

**`completeness`** — how much of the intended scope was seen.
`COMPLETE` · `PARTIAL` · `NOT_SCANNED` · `ACCESS_LOST` · `UNKNOWN`

The middle values carry the weight. "We did not look" and "we lost access"
are not "there is nothing there", and a consumer that renders either as
zero converts a gap in *our* coverage into a statement about a person's
career.

**Every column default is the weakest value in its enum.** A producer that
forgets to declare is classified as an unverified user claim rather than
inheriting credibility it never earned.

Three more dimensions are **derived at read time and never stored**:
specificity (how checkable), recency (how recently confirmed),
corroboration (how many independent sources).

---

## Independence

`independenceKey` identifies the source **instance**: `github:<accountId>`,
`resume:<resumeImportId>`.

This is the one place a trust system can inflate itself without anybody
lying. Fourteen repositories are fourteen observations — of one source. A
resume mentioning TypeScript in four bullets is one document, not four
witnesses. Counting rows would turn "this person uses GitHub a lot" into
"four independent sources agree", a fabrication assembled entirely out of
true statements.

So volume accrues inside a key; independence only ever accrues across
keys.

The GitHub key is the numeric account id, never the login. A login is
mutable and re-assignable: keying on it would split one source in two on a
rename, and merge two people into one on a re-registration.

This also satisfies, structurally, the Phase 6 freeze's standing
instruction that nothing may build scoring on the Evidence joins — one
resume yields one key however many joins it produced.

---

## Classification

Five named states, derived at read time. **No numeric score, ever.** A
number invites averaging, thresholding and ranking people, and every one
of those operations discards the reason behind the value.

Precedence is **ordered gates**, not overlapping conditions, because the
approved rules genuinely overlap — a stale, partial, direct observation
matches the wording of both STRONG and MODERATE. The order *is* the
specification:

1. `WEAK_MATCH` → **UNVERIFIED**
2. `NOT_SCANNED` → **UNVERIFIED**
3. claims (`USER_ASSERTED` / `USER_CLAIM` / `MODEL_INTERPRETATION`) → **WEAK**
4. `UNKNOWN` completeness → **UNVERIFIED** *(reachable only by observations)*
5. direct + authenticated → **STRONG**, demoted to **MODERATE** if stale or `ACCESS_LOST`
6. artifacts, or direct with weaker attribution → **MODERATE**
7. anything unrecognised → **UNVERIFIED** (fails closed)

Set level: the best row's class, promoted to **VERY_STRONG** when a STRONG
row is backed by a second independent source. No averaging — ten weak rows
stay weak.

### Two ambiguities, resolved and recorded

**`PARTIAL` qualifies for STRONG.** `DEFAULT_BRANCH_ONLY → PARTIAL` is the
normal state of *every* GitHub row — no producer emits `COMPLETE` — so
demoting it would make STRONG unreachable and quietly retire the class
while leaving VERY_STRONG reachable. Incoherent.

**The claim floor sits above the `UNKNOWN` check.** A resume is both
`USER_CLAIM` and `UNKNOWN`. Letting `UNKNOWN` win classified *every*
resume as UNVERIFIED — and resume evidence is currently the only evidence
the Career Graph consumes, so a user's entire graph would have read as
unverified on a technicality about a field that does not apply to it. A
resume was never scanned; its completeness is *inapplicable*, not failed.
**WEAK** is the honest answer: a known claim, not an unexamined gap.

---

## Signals

`deriveSignals()` is pure, tested, and **deliberately not exposed**.

Three structural properties make forbidden inference unreachable rather
than merely absent:

1. **A closed vocabulary** — five kinds, no free-text path out.
2. **A frozen table** — every sentence is a literal looked up by kind;
   nothing is concatenated or interpolated, so no input can influence the
   words. This is what makes the vocabulary test *exhaustive* rather than
   a sample.
3. **`doesNotEstablish` is part of the type** and every entry is
   non-empty — a signal without stated limits does not typecheck.

`INSUFFICIENT_EVIDENCE` is the most important member. When nothing is
admissible it is returned alone, and it is a statement about *our records*
— explicitly not that the person lacks the skill, that no such work
exists, or that an unconnected source would show nothing. **No evidence is
not evidence of absence**, enforced by there being no branch that can
produce a claim about a person from an empty set.

`trustClass` is carried through and never re-read as ability. VERY_STRONG
means the evidence is dependable; it does not mean the person is good.
That shortcut — reliability standing in for competence — is the single
most tempting error available here, and a test plants it to prove it is
caught.

Deliberately absent: any model or interpretation step. A generic LLM at
this seam would defeat all three properties at once.

---

## Producers

| | GitHub | Resume |
|---|---|---|
| authenticity | `DIRECT_API_OBSERVATION` | `USER_CLAIM` |
| attribution | `AUTHENTICATED_ACCOUNT` | `USER_ASSERTED` |
| completeness | `PARTIAL` / `NOT_SCANNED` / `ACCESS_LOST` | `UNKNOWN` |
| lastObservedAt | run's `scannedAt`, when actually observed | `= capturedAt`, never advances |
| independenceKey | `github:<accountId>` | `resume:<importId>` |

Both declare literal types rather than the wide enums, so a producer
cannot emit a stronger claim than it supports: `completeness: 'COMPLETE'`
does not compile in the GitHub projection.

`MODEL_INTERPRETATION` was considered for resume evidence and rejected.
The extraction is a model reading a document, but what the row attests is
the *document*, and the user confirms the content before ingestion runs.
Calling it a model interpretation would attribute the person's own
statement to a machine.

### The `lastObservedAt` heartbeat

Phase 7's no-churn guard meant an unchanged re-sync wrote nothing — which
was right, because re-stamping `capturedAt` reorders the evidence sheet.
The cost was that "unchanged" and "unverified" became indistinguishable.

So the guard has exactly one approved exception: `lastObservedAt`
advances; `capturedAt`, `occurredAt`, title, description, `sourceUrl`,
`externalId` and `metadata` do not. One `updateMany` per run, not one per
repository.

**It means the evidence was successfully observed again — not that the
sync ran.** It stays null when the repository was not scanned, when access
was lost, when a carry-forward silently failed, and when the run's
cross-repository activity query failed.

---

## Deliberately not built

- **A numeric trust score.** The central refusal.
- **Technology-level signals** (`PRACTICAL_EXPOSURE`). Nothing in the
  contract carries a subject; the only place a technology appears is
  GitHub's language bytes inside `metadata`, and reading that here would
  make the universal layer GitHub-shaped again.
- **A skill-level rollup.** Requires the Career Graph joins, which exist
  only for resume evidence — labelling a skill "strong" on the strength of
  the weakest source in the system.
- **User dispute / correction.** Required future capability, not built.
- **Event sourcing / immutable observation history.** `revalidatedBy`,
  the completeness record and `ExternalSyncRun` already answer how a value
  survived a run that did not re-derive it.
- **Career Graph changes of any kind.** The freeze held throughout. The
  resume producer's diff is 97 insertions and zero deletions.

---

## Verification

| | |
|---|---|
| Migration | additive; unique index untouched; verified against a scratch database seeded with malformed `scannedAt`, absent account id, NULL metadata, scalar metadata, unrecognised completeness, and a second user |
| Mutation checks | 6 + 5 + 9 + 7 planted defects, every one caught |
| API tests | 1474 |
| Infrastructure tests | 150 (real Postgres + Redis) |
| Mobile tests | 364 |

Verified against real production data copied into a local database: 14
GitHub rows classify **STRONG**, one resume **WEAK**, `independentSources`
**2** — confirmed by running the real service, not asserted.

**Not verified:** the migration has never run against the production
database, and the Evidence frontend has not been visually walked through
on a simulator.
