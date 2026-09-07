# Phase 7.0 — External Evidence Layer: architecture decision record

Decided 2026-09-07. Baseline `12d391b` on `feat/career-graph`; implementation
branch `feat/external-evidence`.

This is the approved decision record for Phase 7. It states what was decided,
and — more importantly — why, so the reasoning can be re-argued later rather
than rediscovered. It supersedes nothing in
`docs/career-graph/phase-6-freeze.md`; where the two differ, the difference is
called out explicitly below.

Phase 7 builds the first implementation of the External Evidence Layer. GitHub
is the first source. GitHub is not the Career Graph.

---

## D1 — GitHub authorization: OAuth App, public repositories only

**Decision.** A classic GitHub OAuth App, public repositories only for the
Phase 7 MVP, requesting exactly:

```
scope=user:email
```

`read:user`, `public_repo` and `repo` are NOT requested. The token must have
zero repository write capability.

**Why this and not something broader.** An earlier draft of this phase
proposed `read:user user:email public_repo` on the reasoning that it avoided
`repo` and therefore avoided write access. That reasoning was wrong, and the
correction is the single most important fact in this record.

GitHub's scope table describes `public_repo` as:

> Limits access to public repositories. That includes read/write access to
> code, commit statuses, repository projects, collaborators, and deployment
> statuses for public repositories and organizations.

It is a write scope. It authorizes repository creation, code push, issue and
pull-request mutation, collaborator changes and starring. Of the 43 operations
in GitHub's OpenAPI description that require it, every one is a write, a
repository creation, or a security-alert mutation. Phase 7 needs none of them.

`read:user` is also unnecessary. A zero-scope token still authenticates as its
owner, and `GET /user` returns the public user response — which already
contains `id` and `login`, the only two fields we need. `read:user`'s sole
effect on that endpoint is to *add* `private_gists`, `total_private_repos`,
`owned_private_repos`, `disk_usage`, `collaborators` and
`two_factor_authentication`: private-account metadata that a public-only
product should conspicuously not be asking for.

`user:email` is kept because it is the only scope gating `GET /user/emails`,
and verified addresses are what let us attribute commits to the user. If that
attribution is later dropped, the scope goes with it.

**What this buys.** The claim "we read only your public work and never receive
write access" becomes literally true and checkable against GitHub's own scope
table. The rate limit is unaffected — 5,000/hr is a property of authenticating
as a user, not of scope breadth. And organization OAuth access restrictions,
which are enabled by default on new organizations, do not block it: an
unapproved app "will only be able to access the organization's public
resources", which is exactly and only what we want.

**What this costs, stated plainly.** Users whose best work is private get less
value from Phase 7. That is a deliberate trade. Private-repository support is a
later, separate decision, and the only way to obtain a genuinely read-only code
grant is a GitHub App with `Contents: read` — the OAuth scope model cannot
express one. GitHub says so directly: "Currently, you can't scope source code
access to read-only."

**Two implementation rules that follow, and are not optional.**

1. **Always send `scope` explicitly**, on every authorize request. Omitting it
   does not mean "no scopes" — GitHub grants "the set of scopes the user has
   authorized for the application", i.e. the union of everything that user ever
   approved for us. A later, broader authorization would then be inherited
   silently by a request that asked for nothing.
2. **Read repositories via `GET /users/{login}/repos`**, which is documented as
   returning "public repositories for the specified user" and needs no
   authentication at all. Do NOT use `GET /user/repos`: its behaviour for a
   token with no repository scope is undocumented, and the widespread belief
   that it returns public repositories only is folklore, not contract.

---

## D2 — A new ledger table; `CareerGraphIngestion` is not modified

**Decision.** Phase 7 adds `ExternalSyncRun`. `CareerGraphIngestion` is left
exactly as it is.

**Why this differs from the freeze document.** `phase-6-freeze.md` proposed
making `CareerGraphIngestion.resumeImportId` nullable and adding `sourceType`
and `sourceKey`. That would weaken a `NOT NULL` invariant on an existing table
in order to serve a source with entirely different semantics — a resume is
confirmed once, a GitHub connection is re-synced indefinitely. A separate table
touches nothing, leaves resume ingestion provably unchanged, and is strictly
smaller in blast radius. The freeze document's own instruction was to prefer
the smallest additive change; this is smaller than the one it suggested.

All existing Career Graph invariants — stable-id identity, deterministic
ordering, import-level provenance — are preserved unchanged.

---

## D3 — GitHub creates Evidence, and nothing else

**Decision.** GitHub ingestion writes `Evidence` rows and their joins. It
creates no `Project`, `Experience`, `Skill`, `UserSkill`, `Achievement` or
`Education`.

**Why.** Three problems disappear at once.

It makes the hard rule of Phase 7 — GitHub activity is not employment —
structurally impossible to violate, rather than merely forbidden by policy.

It sidesteps the create-only deduplication defect the freeze document records,
where a second record whose parsed dates collapse onto an existing one is
silently discarded along with its description. GitHub would have driven far more
traffic through those keys than resumes ever did.

And it makes disconnect answerable. The freeze document notes that no
first-class entity records its creating source, so a disconnect cannot tell
whether a `Project` was *created by* GitHub or merely *attested by* it. If
GitHub creates nothing, the question never arises: delete the GITHUB Evidence
rows and their joins, and nothing else can have been affected. The
`createdByEvidenceId` column the freeze document called a precondition is
therefore not needed in Phase 7.

Language observations stay verbatim in metadata. No `Skill` row is created, so
the normalization problem ("Node.js" / "NodeJS" / "node") is not made worse.

---

## D4 — Separate branch, and an isolation caveat

**Decision.** Phase 7 work happens on `feat/external-evidence`, branched from
`12d391b`.

**Context worth recording.** During the Phase 7.0 audit, `HEAD` moved from
`efdfcf9` to `12d391b` mid-audit — a legitimate Phase 6.9 completion commit
authored from a second, concurrently open Claude session on this repository.
Nothing was lost and history stayed linear, but it demonstrated that "any
Phase 7 commit contains only Phase 7 changes" is not enforceable while two
sessions share one working directory.

Pre-existing uncommitted work that must not be discarded or absorbed:

- `apps/mobile/src/navigation/MainStackNavigator.tsx` (modified)
- `apps/mobile/src/screens/ResumeReviewScreen.tsx` (modified)
- `apps/api/env` and `apps/api/tsconfig.build.tsbuildinfo` (untracked
  artifacts, never to be staged)

---

## D5 — Sync runs in the API process

**Decision.** GitHub ingestion runs in the NestJS API. The AI worker
(`career-os-worker`) is not used.

**Why.** GitHub ingestion is deterministic HTTP and parsing. No LLM is
involved, so routing it through a separate repository's deployment cycle buys
nothing and costs a second moving part. The worker remains the right home for
Portfolio extraction in 7.8, which genuinely needs AI.

---

## D6 — Token encryption: AES-256-GCM

**Decision.** GitHub access tokens are encrypted at rest with AES-256-GCM,
using `node:crypto`, with the key supplied by configuration and a per-row
`keyVersion` to allow lazy rotation.

Additional Associated Data (AAD) binds each ciphertext to the row that owns it.
Without it, anyone able to `UPDATE` the table could copy a victim's ciphertext
into their own row and sync with the victim's token; GCM authenticates the AAD,
so the copy fails to decrypt.

Five tests are acceptance criteria, not nice-to-haves:

1. encrypt/decrypt round trip
2. ciphertext or tag moved to another user (different AAD) fails to decrypt
3. a unique IV is produced for every encryption
4. a value written under an older `keyVersion` still decrypts after rotation
5. serialized or logged errors never contain a GitHub token prefix

---

## Evidence model — one Evidence row per repository (Model A)

**Decision.** One `Evidence` row per GitHub repository. Commits, pull requests,
issues, languages, counts, timestamps and provenance live in
`Evidence.metadata`. No per-commit or per-pull-request Evidence rows in
Phase 7.

**Why, measured rather than argued.** `getGraph` is unbounded — it has no
`take`, `skip` or cursor, and returns every Evidence row with all five join
collections inlined. Measured against a representative serialized row:

| Model | Evidence rows | Added to every `getGraph` |
|---|---|---|
| Repository-level | 40 | 43 KB |
| Structured-activity (repo + per contribution type) | 120 | 104 KB |
| Per-event, moderate developer | 1,620 | 1.2 MB |
| Per-event, active developer | 7,140 | 5.4 MB |

Payload is not the only cost. `buildEvidenceIndex` in the mobile client maps,
filters and sorts *every* evidence record on each graph load, with no cap, in
order to draw five nodes.

The epistemic argument is the stronger one. A single commit proves almost
nothing on its own; seven thousand rows each asserting that a commit exists is
volume dressed as evidence, and it is precisely the shape that invites the
forbidden inference "1,000 commits, therefore expert".

**What this gives up, honestly.** A specific merged pull request into a
repository the user does not own is genuinely strong evidence, and Model A
flattens it into a count. Promoting "notable" pull requests to their own rows
was considered and rejected: "notable" is a selection heuristic, and a
heuristic is an inference. Event-level evidence may be introduced later only
through an explicit product requirement — never through an implicit
notable-event rule.

---

## Completeness contract

Every GitHub Evidence row carries `metadata.completeness`. No consumer may
present a count without respecting it.

```
completeness: {
  commits:      'DEFAULT_BRANCH_ONLY' | 'NOT_SCANNED' | 'ACCESS_LOST',
  scannedSince: ISO instant | null,   // null = since repository creation
  scannedAt:    ISO instant,
  truncated:    boolean,              // a pagination limit was reached
  reposScanned: integer,              // recorded on the sync run
  reposTotal:   integer
}
```

**Why it exists.** Complete commit attribution is not obtainable from GitHub.
Commit search covers only default branches and caps at 1,000 results;
per-repository walks cost one paginated sequence each against a 5,000/hr limit
that belongs to the *user* and is shared with every other GitHub integration
they have authorized. A schema that implies a complete count is therefore
lying, and would surface later as a correctness bug rather than a known limit.

**The four rules.**

1. **Commit counts are lower bounds, never totals.** Only the default branch is
   observable. The UI says "214 commits attributed on the default branch since
   January 2024" — never a bare total, and never a sum across repositories.
2. **`NOT_SCANNED` is never equivalent to zero.** A repository skipped to stay
   within the rate-limit budget must render as not scanned. Rendering it as an
   absence of work is the most likely way for this product to defame a user
   with their own data.
3. **`ACCESS_LOST` retains and marks stale; it never deletes.** A 404 on a
   previously ingested repository means access changed, not that the evidence
   was false. It was true when captured.
4. **`reposScanned < reposTotal` makes the run `PARTIAL`, never `SUCCEEDED`.**

---

## D7 — Multi-source evidence coexistence (scheduled for 7.5)

**The defect.** The mobile client sorts evidence by `capturedAt` descending
(`evidence.ts`), and the graph draws `GRAPH_CAPS.evidence = 5`. A sync writing
roughly forty repository Evidence rows at one instant occupies every drawn
slot, so the map's evidence becomes 100% GitHub and the user's resume evidence
disappears from it.

Nothing here is a data bug. `capturedAt = now` is the honest capture time. The
selection heuristic is simply single-source, and stops being correct the moment
a second source exists.

**The decision.** In Phase 7.5, interleave the evidence selection by
`sourceType` before applying the existing cap. Deterministic ordering is
preserved. The drawn-versus-total disclosure semantics are preserved. A
regression test proving multi-source coexistence is added.

This is a surgical coexistence fix inside an existing selection function, not a
Career Graph redesign. The frozen `getGraph` endpoint, the ingestion
architecture and the broader graph model are not modified.

---

## Out of scope for Phase 7

Market Graph, Opportunity Engine, Next Best Action, career scoring, job
matching, job scraping, skill ontology or normalization, RevenueCat, production
deployment, UI redesign, 3D graph, and generic GitHub analytics.

---

## Verified against official documentation

The following were confirmed against docs.github.com during 7.0, and are
recorded because each would have forced a late architecture change if assumed
wrongly.

- PKCE is supported (`S256` only; `plain` is not), for both OAuth Apps and
  GitHub Apps — but `client_secret` remains required at the token endpoint.
  There is no documented public-client flow, so backend-mediated exchange is
  the only available design, not merely the preferred one.
- `GET /issues?filter=created&state=all&since=` returns the user's pull
  requests *and* issues across all repositories in one paginated, incrementally
  filterable call. Pull requests are identified by the `pull_request` key. This
  removes the Search API — 30 requests/minute, hard 1,000-result cap — from the
  critical path.
- A conditional request returning 304 does not count against the primary rate
  limit.
- The 5,000/hr primary limit belongs to the user and is shared across every
  application they have authorized.
- Organization OAuth access restrictions do not block reads of an
  organization's public repositories.
- Revocation: `DELETE /applications/{client_id}/grant` (whole grant) and
  `DELETE /applications/{client_id}/token` (single token), both via HTTP Basic
  with `client_id` as username and `client_secret` as password.

### Known unknowns

Recorded rather than guessed at, because each is a place where a confident
assumption would be wrong.

- **Repository `id` stability across rename and transfer is not stated in the
  REST documentation.** GitHub's OIDC documentation calls owner and repository
  IDs immutable and stakes a security boundary on it, which is the strongest
  official evidence available; but no REST, rename or transfer page says it, no
  GitHub staff member has answered the community thread asking, and that thread
  contains an unexplained user report of an `id` changing. Key on `id`, store
  `node_id` and `full_name` alongside it, follow `301` redirects, and keep a
  reconciliation path.
- The status code for revoking an already-revoked token is undocumented; only
  `204` and `422` are listed for both DELETE endpoints. Treat 204, 404 and 422
  alike as "gone", and log what is actually observed.
- What `GET /user/repos` returns for a token with no repository scope is
  undocumented — hence rule 2 under D1.
- What GitHub's consent screen renders for a minimal-scope request is
  undocumented.
