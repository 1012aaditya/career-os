# Global Market Source Roadmap

## Executive Summary

The product goal is that a user should not have to search LinkedIn, then
Naukri, then Indeed, then a government site, then a remote board. The
constraint on reaching that goal is **not engineering**. Seven adapters
were built through one contract with no schema change; an eighth would
cost two files and a registry entry.

The constraint is **licensing**, and the evidence is now large enough to
state as a finding rather than an impression:

> Of 38 sources assessed with primary evidence, **7 carry a licence that
> permits commercial aggregation. Six of those seven are governments.**

Every commercial job aggregator assessed failed. Every ATS public endpoint
assessed failed. The failures are not ambiguous — Adzuna prohibits
aggregation into vacancy counts *by name*, SmartRecruiters incorporates a
policy prohibiting "systematic and/or large-scale data extraction",
Personio's own legal notice bars redistribution from the host that serves
its feed, and Lever's only sentence addressing third parties is a warning
to its customers rather than a grant to us.

**The strategic consequence:** the fastest route to broad coverage is not
more aggregators. It is (a) more national employment services, which are
the only category that reliably licenses this use, and (b) one or two
commercial partnerships bought deliberately, rather than twenty scraped.

**The honest limit on this document:** 38 sources carry quoted primary
evidence. Everything else is marked RESEARCH_REQUIRED, which per this
project's own rule means *not approved* — not "probably fine".

---

## Source Value Score

A deterministic prioritisation score for **engineering sequencing only**.

> It lives in this document and in the CSV. It is **not** in the codebase,
> it is **not** computed at runtime, and it must never become one. The
> Market Graph publishes counts with denominators; a weighted opinion score
> is precisely the kind of number Phase 8's boundary rules exist to keep
> out. If this score ever appears in `apps/api`, that is a defect.

```
score = legal + coverage + quality + unique + effort      (max 30)

legal     0-10   10 = explicit open licence, quoted, permits commercial aggregation
                  6 = permissive terms found, conditions manageable
                  3 = access obtainable only via contract
                  0 = prohibited, or UNRESOLVED (which is treated as prohibited)

coverage  0-6    postings volume weighted by the size of the labour market served

quality   0-6    2 each for: full description, employer identity, occupational taxonomy

unique    0-5    fills a geographic or category gap no existing source covers

effort    0-3    3 = fits the source contract unchanged
                 0 = requires a contract extension
```

`legal` carries the highest weight because it is the binary gate that
eliminated 30 of 38 assessed sources. A source scoring 20 on everything
else and 0 on legal is worth nothing, and the weighting should say so.

---

## Current Sources (Tier 0)

| Source | Geography | Licence | Status |
|---|---|---|---|
| JobTech | Sweden | CC0, in swagger.json | enabled |
| Canada Job Bank | Canada | OGL–Canada (`ca-ogl-lgo`) | enabled |
| USAJOBS Historic | USA | public domain + "publicly consumable" | enabled |
| Teaching Vacancies | UK | OGL v3, in the API envelope | enabled |
| Jobicy | Global remote | syndication terms grant reuse | enabled |
| Greenhouse | Global | **none exist** | disabled, fail-closed |
| NAV | Norway | statistical use named | disabled, needs cursor persistence |

Note the two disabled entries fail for *different* reasons, and the
distinction matters for planning. Greenhouse is a **licensing** failure and
will stay disabled until someone obtains terms. NAV is an **engineering**
failure — its licence is among the best found, and it is blocked only
because the ingestion model cannot persist a cursor across runs. NAV is
therefore a Tier 1 item, not a dead one.

---

## ATS / First-Party Sources

The category with the largest theoretical coverage and, so far, a **0%
success rate**. Six assessed, none usable.

| Source | Classification | Deciding evidence |
|---|---|---|
| SmartRecruiters | NOT_FEASIBLE | SAP API Policy: prohibits "scraping, harvesting, or systematic and/or large-scale data extraction" |
| Personio | NOT_FEASIBLE | Legal Notice on the feed's own host bars distribution without written consent; Marketplace ToS §4.2 bars "publicly available directories" |
| Recruitee | NOT_FEASIBLE | T&C §2.4: "An End-User that is not the Subscriber does not derive any rights". Anonymous access ends **10 Feb 2027** |
| Lever | NOT_FEASIBLE | Only third-party sentence is a warning to customers: "These jobs may be scraped by third parties" |
| Greenhouse | NOT_FEASIBLE | No terms of any kind exist for third parties |
| Ashby, Workable | PARTNERSHIP_REQUIRED | Customer-bound ToS, but both run **consent-gated partner feeds** |

**One argument kills the whole category regardless of individual terms:**
none of these vendors owns the posting text. Their own contracts say so —
Lever: *"Customer retains all rights, title and interest in its Customer
Data."* Workable: *"Customer retains all rights, title and ownership
interest in and to the Customer Content."* A friendly conversation with the
vendor yields API *access*, not a copyright licence. The party that could
license it is each individual employer.

**The one route that is not a dead end:** Ashby and Workable operate
partner feeds where the *customer* consents to syndication. That consent is
exactly the missing authority. It is the only ATS path worth pursuing, and
it is a business-development task rather than an engineering one.

A second, unrelated blocker: none of the six publishes a company directory.
Market-wide coverage would need an externally-sourced list of company
slugs, which nobody licenses either.

---

## Global Aggregators

Assessed: 11. Usable: **1** (Jobicy, already built).

| Source | Classification | Deciding evidence |
|---|---|---|
| Adzuna | NOT_FEASIBLE | prohibits use "in aggregation (including but not limited to vacancy counts)" without written consent |
| Jooble | NOT_FEASIBLE | binding "API Terms of Use" published at no reachable URL; 500 requests per key per **lifetime** |
| Lightcast | PARTNERSHIP_REQUIRED | no self-serve access; AI/ML Terms bar generative-AI input with **5× liquidated damages** |
| Talent.com | PARTNERSHIP_REQUIRED | "you must have a prior written agreement with us" |
| Careerjet | NOT_FEASIBLE | requires the triggering end-user's IP and user-agent per call — an unattended pipeline cannot honestly satisfy that |
| The Muse | NOT_FEASIBLE | 2025 ToU: access "solely for your personal and non-commercial purposes" |
| Jobrapido, Joblift, Trovit, Jora, SimplyHired | RESEARCH_REQUIRED | not yet assessed |

Note the Lightcast AI clause is disqualifying for this product
specifically, not merely inconvenient: a Career OS that puts market context
in front of an LLM would be in breach on first use.

---

## Remote / Specialised

| Source | Classification | Deciding evidence |
|---|---|---|
| Jobicy | **BUILD_NOW** (built) | "You may create your own interfaces, summaries, categories…" |
| Remotive | PARTNERSHIP_REQUIRED | "private, paid-for API… starting budget is $5k/mo" |
| Arbeitnow | NOT_FEASIBLE | "personal, non-commercial transitory viewing only" |
| Himalayas | NOT_FEASIBLE | non-commercial, plus explicit anti-data-mining clause |
| WeWorkRemotely | NOT_FEASIBLE | "Scraping, copying, saving, or storing our data is strictly prohibited" |
| RemoteOK | RESEARCH_REQUIRED | `/terms` is 404; highest observed PII of any source surveyed |
| Findwork.dev, Reed.co.uk | RESEARCH_REQUIRED | no public terms addressing API reuse |

---

## Government Sources

The only category with a meaningful success rate: **6 of 13 usable or
near-usable.** This is where roadmap effort belongs.

| Source | Classification | Note |
|---|---|---|
| JobTech (SE) | built | CC0 — the strongest licence found anywhere |
| Canada Job Bank | built | OGL–Canada; no employer, no description |
| USAJOBS Historic | built | usable **because** we do not register |
| Teaching Vacancies (UK) | built | OGL v3; sector-narrow |
| **France Travail** | **BUILD_AFTER_ACCESS** | Art 1.1 cedes copyright + sui generis rights. Needs OAuth2 credentials |
| **NAV (NO)** | **BUILD_AFTER_ACCESS** | licence fine; needs cursor persistence in the ingestion model |
| Finland Työmarkkinatori | RESEARCH_REQUIRED | ESCO taxonomy; marketing clause needs written permission |
| UWV (NL), jobindsats (DK), AMS (AT) | RESEARCH_REQUIRED | **aggregate counts only, not postings** — validation data, not sources |
| VDAB (BE) | PARTNERSHIP_REQUIRED | signed cooperation agreement required |
| Bundesagentur (DE) | NOT_FEASIBLE | reverse-engineered endpoint; the agency responded with CAPTCHAs |
| EURES | NOT_FEASIBLE | good licence, **no retrieval API exists** |
| DWP Find a job (UK) | NOT_FEASIBLE | no API; automated access refused |
| werk.nl (NL), Job-Room (CH) | NOT_FEASIBLE | no retrieval API; Job-Room is inbound publishing only |

**The recurring pattern worth naming:** the government failures are almost
never licensing failures. EURES, UWV, AMS and jobindsats all have clean or
clean-enough licences and simply have **no posting retrieval API**. That is
a very different problem from the commercial category, and a more tractable
one — it can be solved by asking, or by a bulk-file arrangement.

---

## Legal Risks

1. **UNRESOLVED is treated as prohibited, and that is load-bearing.** Six
   sources would be technically trivial and are excluded solely because
   nobody publishes terms. Relaxing this rule once would make every
   classification in this document meaningless.
2. **Licence evidence found in-band can be wrong.** NAV's OpenAPI declares
   `"license": {"name": "MIT"}` — that is NAV's *source code* licence, not
   the data licence. The method that found JobTech's CC0 returns a false
   positive here. Any future in-band licence discovery must be corroborated
   against a terms document.
3. **Attribution obligations are unrendered.** OGL v3, OGL–Canada and
   Jobicy all require attribution. Nothing in the product displays it. This
   is a production gate for the sources already shipped, not a future one.
4. **Retention.** Raw payloads are permanent by design; the only deletion
   path is a source-scoped purge. There is no per-individual erasure
   mechanism, which is a documented residual and would become a real
   problem in any jurisdiction with an active erasure right.
5. **Derived-data and AI clauses are the emerging risk.** Lightcast's is
   the sharpest example, and it is aimed squarely at products like this
   one. Expect more of them.

---

## Technical Risks

1. **The source contract has one known limit.** Four pagination models fit
   it unchanged — none, page number, continuation token, byte offset. An
   **append-only event feed requiring cursor persistence across runs** does
   not, which is why NAV is disabled. Closing that gap unblocks NAV and any
   future feed-shaped source. It is the single highest-value engineering
   item on this roadmap.
2. **`TOKEN_CHARS` is ASCII-only.** Non-English titles fragment
   (`Mjukvaruingenjör` → `mjukvaruingenj` + `r`). This is why four of six
   live sources resolve almost no roles. Fixing it is a `RULESET_VERSION`
   bump and a full re-normalization — cheaper now than after five more
   non-English sources.
3. **`persistPosting` issues six sequential round-trips per posting.**
   Canada's 53,799 rows took roughly 40 minutes. This is a measured
   problem, and it is the one performance item that would actually bite at
   scale.
4. **No cross-source aggregation exists, deliberately.** Counts are
   postings, not jobs, and there is no cross-source dedup. Adding sources
   increases what can be observed faster than it increases what can be
   *published*, and the read API returns one source's view at a time.
   Consolidating them into one number is a genuine design problem that has
   not been solved and must not be faked.

---

## India

Assessed: 13. Legitimately licensed: **1** — and it does not carry job
postings.

### The one usable source, and a distinction that matters

`data.gov.in` splits into two different verdicts depending on what you ask
it for:

- **as a source of individual job POSTINGS → NOT_FEASIBLE.** Not a
  licensing problem. Every NCS resource is a state/sector/year count, and
  the employment corpus follows a pivoted parliamentary-answer pattern —
  one dataset traces to a Rajya Sabha question. The data shape is wrong at
  source, so no key, partnership or further research changes it. There is
  nothing to license.
- **as a source of AGGREGATE labour-market statistics →
  BUILD_AFTER_ACCESS.**

**data.gov.in under GODL-India — BUILD_AFTER_ACCESS, aggregate only.**

The licence is genuinely permissive. §3, verbatim:

> "…a worldwide, royalty-free, non-exclusive license to **use, adapt,
> publish** (either in original, or in adapted and/or derivative forms),
> translate, display, add value, and create derivative works (including
> products and services), **for all lawful commercial and non-commercial
> purposes**…"

Four conditions that shape any build:

- **§4(a) attribution must be user-facing** — "explicitly publishing the
  attribution statement", in the §5 format, with DOI/URL. A consolidated
  attributions page is permitted by §4(b). This is a **production gate**,
  not a documentation task.
- **§4(c)** forbids suggesting the provider endorses us.
- **§6(a) excludes Personal Information from the grant entirely.** So a
  government dataset containing HR contact details would fall *outside*
  the licence that makes it usable — an unusual and important interaction.
- **§7(c) is revocable.** Unlike CC-BY, a provider may terminate the
  licence and retract the dataset. Any build must snapshot, version and
  record retrieval dates rather than assume permanence.

The §6(a) and §7(c) interaction cuts in a useful direction. Aggregate
counts can never trip the personal-information exclusion, so aggregate use
is permanently safe. An individual-vacancy dataset is precisely the kind
that carries employer contact details — and if one were published and later
found to contain personal information, §7(c) permits retracting the legal
basis **retroactively, with no notice**. That asymmetry is an independent
reason the aggregate route is the honest one for India.

**Access rule, verified:** `data.gov.in/robots.txt` is `User-agent: *` /
`Disallow: /`, and the state mirrors (Kerala, J&K, Odisha) are identical —
a platform-wide default, not a per-host quirk. **The portal must not be
crawled.** The sanctioned path is the documented REST API at
`api.data.gov.in` with a registered key.

Usefully, `api.data.gov.in/lists` enumerates the resource catalogue **with
no key at all**, which is the legitimate way to inventory what is actually
published without touching a disallowed host.

**A correction: the platform is not uniformly GODL-licensed.** That is the
footer's claim, but every resource carries a declared **Access Type** —
"Open, Priced, Registered Access or Restricted Access (G2G)". Only *Open*
is straightforwardly GODL-open; "Priced" implies paid licensing and
"Restricted (G2G)" is the same government-to-government posture that
defeats API Setu. **Access Type must be checked per resource** and recorded
alongside the retrieval date. Generalising from the platform footer would
have been wrong.

Usefully, **Frequency** and **Granularity of Data** are also declared
machine-readable metadata fields per dataset, so freshness is something a
build can read rather than infer.

**What still blocks BUILD_NOW** — three items, roughly a day's work:
1. **Whether a private commercial company may register for a key is
   unverified.** No eligibility terms were found in either direction. The
   licence permits commercial *use*; whether a company may hold a *key* is
   a separate question, and a reachable signup form is not an answer to it.
2. No API-specific terms located — the portal Terms of Use is silent on the
   API entirely.
3. Rate limits and maximum page size are undocumented, though 429s are
   confirmed real.

**A correction to a common assumption:** NDSAP-2012 is *silent* on
commercial use — no mention of "commercial", "licence" or "royalty"
anywhere in it. The commercial grant rests entirely on GODL-India (2017),
which was created precisely because "the open license for data sets
published under NDSAP … remained unspecified till now". NDSAP
Implementation Guidelines v2.2 (2014) predate GODL and cannot reference it;
the citation runs the other way.

**A structural residual worth stating:** GODL's §6(b) exclusion is defined
by direct reference to NDSAP §2.10, which is itself a renvoi to unnamed
Acts, and departmental negative lists are not published. **The boundary of
the GODL grant is therefore not fully knowable from the documents.** That
is a property of the instrument, not a gap in the research.

### Two different sources share the name "NCS" — do not conflate them

This distinction is easy to lose and expensive to lose:

- **NCS data published on data.gov.in** — aggregate counts, GODL-licensed,
  NOT_FEASIBLE as a postings source. This is a *data shape* problem that no
  partnership fixes, because there are no vacancy rows to license.
- **ncs.gov.in itself** — a separate source, holding ~1.77M live vacancies,
  with an unknown licence and no published API. This is a *permission*
  problem, and it is the one a partnership could solve.

Everything below concerns the second.

### NCS (ncs.gov.in) — PARTNERSHIP_REQUIRED, and the reason is structural

NCS publishes individual postings and has no robots.txt. It also has two
contradictory copyright policies live at once; the current one (v6.14,
20/12/2024) permits free reproduction with acknowledgement **but carves
out** "any material which is identified as being copyright of a third
party."

That carve-out is fatal here specifically, because **NCS's vacancy corpus
is substantially supplied inbound by private job boards under MoUs** — TCS
iON, HireMee, TeamLease, foundit, Quess, Quikr and others, ~25 MoUs by mid
2025. NCS cannot sub-license to us what it received from Foundit.

**And the ask is bigger than "send us a file".** NDSAP §2.8 defines the
negative list as "Non-sharable data as declared by the departments/
organizations", and preparing it is a named duty of each department's Data
Controller. So whether NCS vacancy-level data is open is **DGE's unilateral
call** — and the aggregate-only character of what has been published is
consistent with DGE having already placed vacancy data on its own negative
list. A partnership approach is therefore a request to change a
departmental classification, not merely to obtain a file. Price that in.

There is a concrete entry point rather than a generic ministry address:
**`ndsap@gov.in`** (the NDSAP programme office) and a public register of
nominated Data Controllers per ministry at `data.gov.in/datacontrollers`.
That register is how to identify the named DGE official to approach.

The partnership route is nonetheless real and precedented: DGE / Ministry
of Labour & Employment runs an active MoU programme with API integration
and a named granting authority. The narrow ask most likely to succeed is
the **government-vacancy subset** (`isGovernmentJob`), which is least
encumbered by third-party rights. Note this is the *reverse* direction of
every MoU they have signed, so it is a novel request rather than a form.

### The rest

| Source | Classification | Deciding evidence |
|---|---|---|
| API Setu | NOT_FEASIBLE | All 181 collections enumerated: zero vacancy APIs. It is a consent-based per-citizen document exchange — every endpoint requires a `consentArtifact`. Architecturally the wrong shape, not a licensing problem |
| IndianAPI | NOT_FEASIBLE | Own spec: data is "scraped from all over the internet". Its unusually generous grant is void |
| Jobvetta | NOT_FEASIBLE | No legal entity named; 500 records/day hard ceiling; operates a rights-holder takedown channel — what a crawler needs and a licensee does not |
| Cutshort | NOT_FEASIBLE (for this product) | Genuinely first-party and clean, but the API reads *candidates*; there is no market-wide job-read endpoint |
| Foundit | NOT_FEASIBLE | robots.txt names **ClaudeBot** and disallows `/jobs/` and `/search/` |
| Wellfound | NOT_FEASIBLE | Historical API dead; permission runs to public search engines "excluding any caches or archives" — i.e. excluding exactly the store a statistics product needs |
| Naukri, Hirist, Shine, Freshersworld | PARTNERSHIP_REQUIRED | anti-crawl + written-consent-only terms |
| TimesJobs, Instahyre | RESEARCH_REQUIRED | TimesJobs live but operating entity unresolved; Instahyre 403s all automated access |

**The Info Edge finding, and it is the most commercially useful result in
the Indian study.** `hirist.tech/terms` and `iimjobs.com/terms` carry the
same sentences with only the brand token swapped, both contracted in the
name of **Info Edge (India) Limited**, under a single privacy policy, with
Hirist's terms using the abbreviation "IEIL" without defining it — the
signature of a group master template. **One negotiation with Info Edge
plausibly covers Naukri, iimjobs, hirist, AmbitionBox, Jobhai, 99acres and
Shiksha.**

Two caveats stated plainly: hirist/iimjobs sharing the template is
*verified*; Naukri sharing it is *inferred* and a human should confirm it
in an ordinary browser. And Info Edge already publishes the monthly Naukri
JobSpeak Index — the aggregate output of roughly this product, given away
free — so the ask is being made to a competitor.

### A general lesson worth carrying

**A broad grant from a party with no rights is a negative signal, not a
positive one.** IndianAPI offers the most permissive terms in the entire
study and is the least usable source in it. The generosity is the tell that
nobody did the rights work.

---

## The aggregate-only category, and a contract limit it exposes

This is the most important architectural finding in the roadmap, and it did
not come from any single source.

Four licensed sources — **data.gov.in (IN), UWV (NL), jobindsats (DK), AMS
Austria (AT)** — carry clean or clean-enough licences and publish
**aggregate vacancy counts rather than individual postings**.

The Market Graph cannot ingest them. Its contract is
`RawPostingRecord` → `MarketPosting` → `Version` → `Sighting` →
normalization → signal. Every stage assumes an individual observed posting.
There is no honest way to turn "47,000 vacancies registered in 2023" into
posting rows — doing so would fabricate 47,000 observations that were never
observed, which is precisely the failure mode the whole phase is built to
prevent.

**This is a genuine CONTRACT EXTENSION, and it should not be attempted
casually.** It would need a second ingestion path with its own model —
something like an attested aggregate measurement carrying its own
provenance, publisher, period and methodology — kept strictly separate from
posting-derived signals so the two can never be silently summed. That is a
phase of work, not an adapter.

**The product consequence for India is the one that matters:** the only
legitimately licensed Indian data is aggregate, and the pipeline cannot
currently accept aggregate data. So India is not "one adapter away". It is
either a DGE partnership, a paid vendor licence, or a contract extension —
and it must be labelled honestly in the product as statistics-only until
one of those lands.

---

## Geographic Coverage Gaps

Coverage measured by what is **live and enabled today**, not by what is
licensed or planned. A source that is disabled contributes nothing.

| Region | Coverage | Live sources | Honest assessment |
|---|---|---|---|
| **Nordics** | MODERATE | JobTech (SE) | 6,671 postings, full descriptions. NAV (NO) licensed but disabled |
| **USA** | MODERATE | USAJOBS Historic | 10,000 postings, but **federal only and historic only** — a record of past demand, no descriptions |
| **Canada** | MODERATE | Canada Job Bank | 53,799 postings — the largest single source — but **no employer and no description** |
| **UK** | WEAK | Teaching Vacancies | 3,338 postings, **schools only**. Not a UK labour market view |
| **Global remote** | WEAK | Jobicy | 200 postings on a rolling window. A signal, not a census |
| **EU (non-Nordic)** | **NONE** | — | France Travail licensed and unbuilt; Germany, NL, DK, AT all blocked or aggregate-only |
| **India** | **NONE** | — | No legitimate postings source exists |
| **APAC** | **NONE** | — | Research in flight |
| **LATAM** | **NONE** | — | Research in flight |
| **Middle East** | **NONE** | — | Research in flight |
| **Africa** | **NONE** | — | Research in flight |

**The uncomfortable summary: five regions have zero coverage, and no region
has strong coverage.** The two largest sources by volume (Canada, USAJOBS)
are the two that carry no job descriptions, so they contribute to role
volume and to no skill-prevalence denominator at all.

The single largest addressable gap is **France Travail** — licensed, a real
national labour market, full descriptions, ROME occupational codes, and
blocked only on obtaining OAuth2 credentials. It is the highest-value
unbuilt item on this roadmap.

---

## Market Category Gaps

| Category | Coverage | Where it comes from |
|---|---|---|
| Government / public administration | MODERATE | USAJOBS (US federal), NCS unavailable |
| Education | MODERATE | Teaching Vacancies — but UK schools only |
| Software / engineering | **WEAK** | Jobicy only (200 postings). Greenhouse was the best source for this and is disabled |
| Data / AI | **WEAK** | Same |
| Healthcare | **NONE** | No live source |
| Finance | **NONE** | No live source |
| Product, Design, Marketing, Sales, Operations, Legal | **NONE** | No live source |
| Skilled trades | **WEAK** | Canada Job Bank has NOC codes but no descriptions |
| Entry-level / internships | **NONE** | Freshersworld and equivalents all blocked |
| Remote | WEAK | Jobicy |

**The most consequential gap is software/engineering**, because it is both
the product's likely primary audience and the category where the pipeline's
skills vocabulary is strongest. The single best source for it — Greenhouse,
at 39.49% role resolution, by far the highest of any source — is disabled
on licensing. That is worth stating plainly: **the vocabulary works best on
exactly the data the product is not allowed to use.**

---

## Recommended Priority

### TIER 0 — implemented
JobTech, Canada Job Bank, USAJOBS Historic, Teaching Vacancies, Jobicy.
Greenhouse and NAV implemented but disabled.

### TIER 1 — build next, no new permission needed
1. **NAV cursor persistence** — an *engineering* item, not a licensing one.
   NAV's licence explicitly names statistical use; it is disabled purely
   because the ingestion model cannot persist a feed cursor across runs.
   Fixing that unblocks a fully licensed national source and every future
   feed-shaped source.
2. **`TOKEN_CHARS` Unicode support** — a `RULESET_VERSION` bump. Currently
   four of six live sources resolve almost no roles. This raises the value
   of every non-English source already ingested, and costs less now than
   after more of them land.

### TIER 2 — build after credentials
3. **France Travail** — the largest addressable geographic gap. Needs a
   free self-serve OAuth2 registration. Obligations are real and shape the
   design: no re-exposure of raw postings, mandatory 24-hour refresh,
   anonymisation on delist, and publication of the normalization method.
4. **data.gov.in aggregates** — needs a key plus resolution of whether a
   commercial entity may register, **and** the aggregate-ingestion contract
   extension below. Not a quick win.

### TIER 3 — partnership targets, in order of expected value
5. **Ashby / Workable consent-gated partner feeds** — the only ATS route
   that solves the ownership problem, because the employer consents.
6. **DGE / Ministry of Labour & Employment (NCS)** — the only route to
   Indian postings. Ask narrowly for the government-vacancy subset. Note it
   is a request to change a departmental classification.
7. **Info Edge (India) Ltd** — one conversation, potentially seven
   properties. Tempered by the fact that they publish JobSpeak and would be
   licensing a competitor.
8. **Lightcast** — excellent data, but the AI clause is disqualifying for
   this product unless specifically waived.

### TIER 4 — research
Finland, TimesJobs, Instahyre, RemoteOK, Reed, Findwork, and the
aggregate-only European sources.

### TIER 5 — do not use
Adzuna, Jooble, The Muse, Arbeitnow, Himalayas, WeWorkRemotely, Careerjet,
Bundesagentur, Foundit, Wellfound, IndianAPI, Jobvetta, API Setu,
SmartRecruiters, Personio, Recruitee, Lever, Greenhouse, and every source
classified SCRAPING_ONLY. **None of these may be implemented**, and the
reasons are recorded per source above so the question is not reopened.

---

## Phase 8 Future Expansion

Ordered by value per unit of effort, which is not the same as ordered by
source size:

1. **Fix NAV** (engineering, days) — unlocks a licensed national source.
2. **Unicode tokenizer** (engineering, days) — raises the yield of every
   non-English source already ingested.
3. **France Travail** (credentials + adapter, ~a week) — closes the largest
   geographic gap with a real labour market.
4. **Aggregate ingestion contract extension** (a phase) — unlocks India,
   the Netherlands, Denmark and Austria simultaneously. This is the highest
   *ceiling* item and the highest *cost* item, and it must not be attempted
   by pretending counts are postings.
5. **Partnership outreach** (business development, months) — Ashby/Workable
   first, DGE second.

**What should not be done:** adding more aggregators. Eleven were assessed
and one was usable. The category has been tested sufficiently to stop
spending engineering time on it.
