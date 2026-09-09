# Phase 11 — partner, company and ATS access

Phase 11 built the machinery for ingesting **authorized** employer, ATS and
partner feeds into the existing Market Graph, and then declined to ingest
one, because no such authorization is currently held. Both halves of that
sentence are the deliverable.

## What changed in the model

The source registry already carried a licence position per source. It did
not carry two things that decide whether a source may be walked at all, and
Phase 11 adds them as columns on `MarketSource` — not as a second registry.

**`category`** — what kind of relationship supplies the data:
`PUBLIC_OPEN_DATA`, `DIRECT_EMPLOYER`, `ATS`, `LICENSED_AGGREGATOR`,
`PARTNER_FEED`. About the relationship, never about the employer. A Google
vacancy arriving through an ATS is an ATS posting; there is deliberately no
value here that could ever be a company name.

**`accessState`** — where the source stands in its lifecycle:

```
DISCOVERED → ACCESS_REQUESTED → ACCESS_GRANTED → CREDENTIALS_REQUIRED
           → CREDENTIALS_CONFIGURED → LEGAL_REVIEW → ENABLED
terminal:  BLOCKED_EXTERNAL_ACCESS · DISABLED · REJECTED · EXPIRED
```

`ENABLED` is the **only** ingestible state. Everything else fails closed.

## The bug this found

`isEnabled` was written once by `ensureSource`'s CREATE and never updated,
because the UPDATE block was empty — deliberately, so that operator tuning
survived a deploy. Two descriptors later moved to `isEnabled: false`
(Greenhouse on licence grounds, NAV on ours) and **neither row changed**.
The live database held `greenhouse.isEnabled = true` against a reviewed
decision in code that said otherwise, and `sync greenhouse` would have
walked it.

Three changes close it, and the redundancy is intentional:

1. `ensureSource` now writes REVIEW columns on every sync (access state,
   category, attribution, licence) while still leaving OPERATIONAL columns
   alone — and forces `isEnabled` false whenever the declared state is not
   `ENABLED`. An operator can still switch an approved source off; nobody
   can switch an unapproved one on.
2. The ingestion gate reads both the code declaration and the row, and
   refuses when they disagree rather than picking a winner.
3. A CHECK constraint, `isEnabled = false OR accessState = 'ENABLED'`, makes
   the rule true of the data even against a hand-edited row.

## The first provider: Ashby, implemented and blocked

Phase 11's priority list was iCIMS, Oracle Recruiting, Ashby, Workable,
Lever, Greenhouse. **Ashby** was chosen, and it ingests nothing.

*Why not iCIMS or Oracle.* Both are reached only through an executed
partner agreement with issued credentials, and their payload shapes sit
behind that agreement. An adapter for either would be an adapter for an
imagined shape, tested against fixtures written by the same person who
imagined it. That is a drawing of an integration, not an integration.

*Why Ashby.* This project's own source roadmap had already found that
Ashby and Workable are the only ATS route that is not a dead end, for a
reason that is about ownership rather than terms: their partner feeds are
consent-gated, and the consenting party is the **employer** — who is the
one party that can license the posting text.

*What is blocked.* Not the endpoint. `api.ashbyhq.com/posting-api/job-board/
<board>` answers unauthenticated, and one response was read on 2026-09-09
(70 postings, apiVersion 1) so the adapter could be written against
something real. What is blocked is the **partner feed**: terms not public,
access not requested and not held. Ingesting the public endpoint instead
would be helping ourselves to employers' text because a vendor left a door
open — the exact reasoning the phase forbids.

The source is therefore `BLOCKED_EXTERNAL_ACCESS`: the adapter is complete,
passes every generic contract test, handles 401/403/404/429/timeout/
malformed responses, and the source is not searchable and cannot be walked.

## What would unblock it

An Ashby (or Workable) partner agreement, at which point:
`ACCESS_REQUESTED` → `ACCESS_GRANTED` → `CREDENTIALS_CONFIGURED`
(`ASHBY_API_KEY` is already declared and its path already tested) →
`LEGAL_REVIEW` → `ENABLED`, with `licenceBasis` moving to `CONTRACTED` and
an `attribution` string taken from whatever the agreement obliges. No code
change is required for the state moves themselves.

The same path serves a `DIRECT_EMPLOYER` feed: a large employer publishing
its own vacancies under its own terms is one descriptor and one adapter,
with no new table and no company-specific structure anywhere.

## Operator commands

```
market-graph.cli.js sources          # what this build declares
market-graph.cli.js health [source]  # access, credentials, runs, corpus
```

`health` is CLI-only and stays that way: it names credential VARIABLES and
quotes access notes recording who was asked what. A boundary test keeps it
off every HTTP surface.
