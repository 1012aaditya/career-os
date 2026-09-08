# Phase 8 — market source eligibility

Every source considered for the Market Graph, what its terms actually say,
and the decision. Written down because the previous Adzuna rejection
existed only in somebody's memory, which is why it had to be researched a
second time.

**The rule this document is built on:** a public, unauthenticated endpoint
is not a licence. Where terms could not be found, the position is recorded
as UNRESOLVED and the source is treated as not approved. Nothing was
reclassified to reach a target number.

---

## Decisions

| Source | API | Auth | Commercial | Aggregation | Storage | Decision | Deciding evidence |
|---|---|---|---|---|---|---|---|
| **JobTech** (SE) | yes | none | yes | yes | yes | **ELIGIBLE** | CC0 in the API's own `swagger.json` |
| **Teaching Vacancies** (UK DfE) | yes | none | yes | yes | yes | **ELIGIBLE** | OGL v3 in the response envelope + API terms |
| **USAJOBS HistoricJoa** | yes | none | yes | yes | yes | **ELIGIBLE** | "does not require authorization… publicly consumable" + 17 U.S.C. 105 |
| **NAV Arbeidsplassen** (NO) | yes | token | yes | **named** | conditional | **ELIGIBLE** | terms name "statistiske/analytiske formål" |
| **Jobicy** | yes | none | yes | yes | yes | **ELIGIBLE** | syndication terms grant reuse without individual permission |
| **Canada Job Bank** | CSV | none | yes | yes | yes | **ELIGIBLE, not built** | Open Government Licence – Canada |
| **France Travail** | yes | OAuth2 | yes | yes | conditional | **ELIGIBLE, not built** | Art 1.1 cedes copyright + sui generis rights |
| **Työmarkkinatori** (FI) | yes | OAuth2 | unclear | unclear | conditional | **CONDITIONAL, held** | marketing clause needs written permission |
| **Greenhouse** | yes | none | — | — | — | **UNRESOLVED → disabled** | no terms of any kind exist |
| **Lever** | yes | none | — | — | — | **UNRESOLVED → rejected** | only third-party sentence is a warning to customers |
| **Adzuna** | yes | key | trial only | **prohibited** | unstated | **NOT ELIGIBLE** | terms prohibit aggregation into vacancy counts by name |
| **Lightcast** | yes | OAuth2 | contract | unstated | contract | **NOT ELIGIBLE** | no self-serve access; AI clause with 5× liquidated damages |
| **Jooble** | yes | key | unknown | unknown | unknown | **NOT ELIGIBLE** | API Terms of Use referenced but unpublished |
| **The Muse** | yes | optional | **no** | **no** | unstated | **NOT ELIGIBLE** | ToU: "personal and non-commercial purposes" |
| **Bundesagentur für Arbeit** (DE) | unofficial | — | — | — | — | **NOT ELIGIBLE** | reverse-engineered endpoint; BA responded with CAPTCHAs |
| **EURES** | none | — | — | — | — | **NOT ELIGIBLE** | good licence, no retrieval API exists |
| **SmartRecruiters** | yes | none | — | — | — | **NOT ELIGIBLE** | SAP API Policy prohibits scraping/large-scale extraction |
| **Ashby / Workable / Recruitee / Personio** | yes | none | — | — | — | **NOT ELIGIBLE** | customer-bound terms; no third-party grant |
| **Remotive / Arbeitnow / Himalayas / WeWorkRemotely** | yes | none | **no** | **no** | **no** | **NOT ELIGIBLE** | explicit non-commercial or anti-scraping terms |

## The quotes that decided the rejections

**Adzuna** — *"It may not be used in its original format or in aggregation
(including but not limited to vacancy counts, average salaries etc) to
deliver any ongoing work or research… without written consent."* Names our
exact use case. Licensable in principle; nobody holds that consent.

**Lightcast** — no self-serve access exists (every endpoint 401s, both
access pages route to sales), the Open tier is *"excluding commercial or
for-profit purposes"*, and the AI/ML Development Terms define Prohibited AI
Use to include *"Using the Content as an input into any generative
artificial intelligence"* with liquidated damages at **5× annual fees**.
For a product that puts market context in front of an LLM, that last clause
is disqualifying on its own.

**Jooble** — its documentation binds users to a *"Jooble API Terms of Use"*
that is published at no reachable URL. Also ~500 requests **per key per
lifetime** across 66 country keys, and a documented id
(`8240559805230395300`) that exceeds `MAX_SAFE_INTEGER`, so `JSON.parse`
silently corrupts it.

**The Muse** — the 2015 API terms look permissive, but the 2025 Terms of
Use grant access *"solely for your personal and non-commercial purposes"*
and forbid bots *"to aggregate"*, and API §3.3 conditions the API licence
on compliance with those ToU.

**Lever, Greenhouse, and every other ATS** — the only sentence in Lever's
corpus touching third parties is a warning to its **customers**: *"These
jobs may be scraped by third parties."* That describes what happens; it
grants nothing. Both are fail-closed for the same reason.

There is also an argument that kills the ATS category regardless of terms:
**none of these vendors owns the posting text.** Their own contracts say so
— Lever: *"Customer retains all rights, title and interest in its Customer
Data."* A friendly conversation with the vendor yields API access, not a
copyright licence.

## Two traps worth remembering

**NAV's OpenAPI declares `"license": {"name": "MIT License"}`.** That is
NAV's *source code* licence, not the data licence. Finding CC0 inside
JobTech's swagger is exactly how this project learned to look for in-band
licence evidence — and here the same method returns the wrong answer. The
governing document is the separate `termsOfService` URL.

**USAJOBS' public-domain status is real and does not help the Search API.**
17 U.S.C. 105 denies copyright to US Government works, but the Search API
is reached by registering, and registration binds you to terms forbidding
derivative works. The restriction is contractual, not a copyright claim.
The Historic endpoint needs no registration, which is precisely why it is
usable — the licence position exists *because* we do not sign up.

## Obligations accepted

- **Teaching Vacancies** — attribution; no fee for contacting, interviewing
  or hiring a respondent to a listing.
- **NAV** — ads removed immediately once inactive; independent GDPR
  controller. The adapter refuses non-ACTIVE entries, but the pipeline
  records no delisting, so "immediately" is bounded by sync cadence. Named
  as a residual rather than claimed as solved.
- **Jobicy** — attribution, canonical URL retention, one poll per hour. The
  polling limit is an operator scheduling obligation; no code enforces it.
- **France Travail** (if ever built) — Art 3 forbids re-exposing raw
  postings through our own API; Art 4 requires **publishing the
  normalization method**; Art 5.2 mandates a refresh at least every 24
  hours; Art 7 requires anonymising retained content once delisted.

## Coverage limitations

Recorded because a market graph that hides what it cannot see is worse than
one that has fewer sources.

| Source | Language | Description | Role resolution |
|---|---|---|---|
| JobTech | Swedish | full HTML | 3.22% — ASCII tokenizer splits `Mjukvaruingenjör` |
| Teaching Vacancies | English | full HTML | 0% — teaching roles, tech vocabulary |
| USAJOBS Historic | English | **none** | volume only; every posting ABSENT |
| NAV | Norwegian | **none in the feed** | volume only; ESCO codes are behind a per-posting detail endpoint |
| Jobicy | English | full HTML | rolling window only — a signal source, never a census |
| Greenhouse | English | full HTML | 39.49% |

Two consequences follow and neither is hidden:

- **Four of six sources contribute to `ROLE_POSTING_VOLUME` and to no
  `ROLE_SKILL_PREVALENCE` denominator**, because they publish no readable
  description or no resolvable role. That is the completeness contract
  working, not a defect: a posting whose requirements we have never read
  must not dilute a statistic about requirements.
- **`TOKEN_CHARS` is ASCII-only**, so non-English titles fragment. Fixing it
  is a `RULESET_VERSION` bump and a full re-normalization — one migration
  now, or five after five non-English sources land. Deferred, deliberately,
  and named here so the cost is visible.

---

## Live verification, 2026-09-08

| Source | Status | Live verified | Scopes read/complete | Postings | Role-resolved |
|---|---|---|---|---|---|
| jobtech | enabled | yes | 5 / 2 | 6671 | 215 |
| teaching-vacancies | enabled | yes | 1 / 1 | 3140 | **0** |
| usajobs-historic | enabled | yes | 1 / **0** | 10000 | 31 |
| jobicy | enabled | yes | 1 / 1 | 200 | 42 |
| canada-job-bank | enabled | yes | 1 / 1 | 53,800-scale | **0** |
| greenhouse | **disabled** | previously | 10 / 10 | 2957 | 2169 |
| nav-no | **disabled** | yes — and it is why it is disabled | 1 / **0** | 0 accepted, 20000 refused | 0 |

Three distinct real-world causes of PARTIAL are now live and reproducible,
which is worth more than the count: a dead scope (Greenhouse's `benchling`
404s), a server-side result cap (JobTech's 2000-ad offset ceiling), and a
client page ceiling reached against a larger corpus (USAJOBS, 10,000 of
125,717). None of them reports SUCCEEDED.

## Redaction is not retroactive, and that matters

Every source ingested after contact redaction landed stores **zero** email
addresses in either `descriptionRaw` or `rawPayload` — verified across
Teaching Vacancies, USAJOBS, Jobicy and Canada. The pre-existing JobTech
rows still carry 2320 in descriptions and 2700 in payloads, and Greenhouse
389.

Re-ingesting does **not** clean them. `CONTENT_HASH_VERSION` moved to 2, so
a re-ingest mints new, redacted versions alongside the old ones rather than
replacing them — which is the labelled split working as designed, and is
visible in the corpus as 9,629 versions at version 1 and 58,126 at
version 2. The only mechanism that removes the old rows is the source
purge.

**So the honest position is: redaction protects every future observation
and no past one.** Remediating the existing JobTech and Greenhouse rows is
a purge-and-re-ingest, and it has not been done.
