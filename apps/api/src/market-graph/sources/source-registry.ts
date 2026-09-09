import { Injectable, NotFoundException } from '@nestjs/common';

import { AshbyAdapter } from './ashby/ashby.adapter.js';
import { AshbyClient, ASHBY_CREDENTIALS } from './ashby/ashby.client.js';
import { CanadaJobBankAdapter } from './canada-job-bank/canada-job-bank.adapter.js';
import { CanadaJobBankClient } from './canada-job-bank/canada-job-bank.client.js';
import { GreenhouseAdapter } from './greenhouse/greenhouse.adapter.js';
import { GreenhouseClient } from './greenhouse/greenhouse.client.js';
import { JobTechAdapter } from './jobtech/jobtech.adapter.js';
import { JobicyAdapter } from './jobicy/jobicy.adapter.js';
import { JobicyClient } from './jobicy/jobicy.client.js';
import { JobTechClient } from './jobtech/jobtech.client.js';
import { NavAdapter } from './nav-no/nav-no.adapter.js';
import { NavClient } from './nav-no/nav-no.client.js';
import { UsaJobsHistoricAdapter } from './usajobs-historic/usajobs-historic.adapter.js';
import { UsaJobsHistoricClient } from './usajobs-historic/usajobs-historic.client.js';
import type { SourceDescriptor } from './source-adapter.js';
import { TeachingVacanciesAdapter } from './teaching-vacancies/teaching-vacancies.adapter.js';
import { TeachingVacanciesClient } from './teaching-vacancies/teaching-vacancies.client.js';

/*
 * Every source the pipeline can ingest, and everything about each of them
 * that is source-specific.
 *
 * This file is where a source is DECLARED. It is the only place outside
 * `sources/<name>/` that names one, and adding the seventh means adding an
 * entry here plus a directory - not editing the ingestion service, the run
 * ledger, the vocabulary service or the CLI, all of which previously had
 * `greenhouse` written into them.
 *
 * The licence position lives here too, beside the adapter it governs,
 * because it is a fact about the source rather than about our schema. The
 * two entries below are deliberately different, and the difference is the
 * point: one is an affirmative public-domain grant, the other is an
 * absence of any statement at all, and the pipeline treats them
 * differently rather than averaging them into "public".
 */
@Injectable()
export class MarketSourceRegistry {
  constructor(
    private readonly greenhouse: GreenhouseClient,
    private readonly jobtech: JobTechClient,
    private readonly teachingVacancies: TeachingVacanciesClient,
    private readonly usajobs: UsaJobsHistoricClient,
    private readonly nav: NavClient,
    private readonly jobicy: JobicyClient,
    private readonly canada: CanadaJobBankClient,
    private readonly ashby: AshbyClient,
  ) {}

  descriptors(): SourceDescriptor[] {
    return [
      this.greenhouseSource(),
      this.jobtechSource(),
      this.teachingVacanciesSource(),
      this.usaJobsHistoricSource(),
      this.navSource(),
      this.jobicySource(),
      this.canadaJobBankSource(),
      this.ashbySource(),
    ];
  }

  get(slug: string): SourceDescriptor {
    const descriptor = this.descriptors().find(
      (candidate) => candidate.slug === slug,
    );

    if (descriptor === undefined) {
      throw new NotFoundException(`Unknown market source: ${slug}`);
    }

    return descriptor;
  }

  private greenhouseSource(): SourceDescriptor {
    return {
      slug: 'greenhouse',
      displayName: 'Greenhouse Job Boards',
      adapter: new GreenhouseAdapter(),
      client: this.greenhouse,
      queryParams: { contentIncluded: true },
      category: 'ATS',
      access: {
        /*
         * Assessed and refused, which is a decision rather than a delay.
         * No terms of service govern the public Job Board API in either
         * direction - and the argument that settles it is not about terms
         * at all: the ATS vendor does not own the posting text. Greenhouse
         * hosts what its customers wrote, so vendor access could never be
         * a copyright licence even if it were offered. Recorded as
         * REJECTED so the endpoint answering is not mistaken for the
         * question being open.
         */
        state: 'REJECTED',
        note: 'Assessed 2026-09-08 and refused. No third-party terms exist in either direction, and the posting text belongs to the employer rather than to the ATS vendor - so vendor-side access would not be a copyright licence. Reopening this needs an employer-side or partner-side grant, not another look at the endpoint.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution: null,
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published. Twenty rapid sequential requests were not throttled on 2026-09-08, which is an observation and not a promise; the client waits 250ms between boards regardless.',
      },
      /*
       * Not a grant. No terms of service governing the public Job Board API
       * were found; the endpoint is documented as public, unauthenticated
       * and intended for third parties, and carries no clause forbidding
       * aggregation or requiring deletion - which is the inverse of Adzuna,
       * whose terms name aggregation into vacancy counts in their
       * prohibited list. An unresolved position, recorded as one.
       */
      licenceBasis: 'UNADDRESSED_PUBLIC_ENDPOINT',
      licenceNote:
        'No terms of service governing the public Job Board API were found on 2026-09-08. Documented as public, unauthenticated and intended for third-party job boards, with no clause forbidding aggregation or requiring deletion. This is an unresolved position, not a grant.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      /*
       * False, and it must stay false while the licence position is
       * UNADDRESSED_PUBLIC_ENDPOINT.
       *
       * This read `true` until 8.9, with a comment arguing that setting it
       * explicitly made enabling a source "an act somebody performed". It
       * did not. The schema default of false was never reached, because
       * ensureSource always supplies a value - so every fresh database got
       * an enabled Greenhouse, and the fail-closed behaviour existed only
       * in the column definition. An unresolved licence that ingests
       * anyway is an unresolved licence being ignored.
       *
       * The consequence is intended: `sync greenhouse` refuses until an
       * operator flips the column by hand. ensureSource's update block is
       * empty, so that decision then survives every later sync - and so
       * does a purge's decision to turn it back off.
       */
      isEnabled: false,
      /*
       * Left false, and the difference from JobTech below is deliberate.
       * Ingesting for internal analysis and publishing derived aggregates
       * to users are different permissions, and only the first has been
       * reasoned about for this source.
       */
      mayRedistributeDerived: false,
    };
  }

  private jobtechSource(): SourceDescriptor {
    return {
      slug: 'jobtech',
      displayName: 'JobTech / Arbetsförmedlingen (Platsbanken)',
      adapter: new JobTechAdapter(),
      client: this.jobtech,
      queryParams: { sort: 'pubdate-desc', pageSize: 100, offsetCap: 2000 },
      category: 'PUBLIC_OPEN_DATA',
      access: {
        state: 'ENABLED',
        note: 'Open public API, no registration, no credential. The CC0 dedication is published in the API swagger.json and in the Arbetsformedlingen open-data catalogue; nothing was requested of anybody because nothing needed to be.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      /*
       * Null, and it is the only source here where null means "the licence
       * says so" rather than "we did not find one". CC0 waives attribution
       * expressly, and inventing a credit line would misstate the licence
       * in the direction of looking diligent.
       */
      attribution: null,
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published for the search API. The offset cap of 2000 in queryParams is the provider\'s own documented ceiling on deep paging, not a rate limit.',
      },
      /*
       * The only affirmative licence found across every source surveyed.
       * CC0 is a public-domain dedication: commercial use, durable storage
       * and redistribution of derived aggregates are all permitted, and
       * attribution is not required. Verified in the API's own
       * swagger.json and in Arbetsförmedlingen's open-data catalogue.
       */
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        'CC0 1.0 public domain dedication, stated in the API swagger.json ("Ads are licensed under CC0") and in the Arbetsförmedlingen open-data catalogue, verified 2026-09-08. Commercial use, durable storage and redistribution of derived aggregates permitted; attribution not required. NOTE: CC0 waives copyright and expressly does NOT waive privacy rights - live ads carry named recruiter contacts, so the adapter strips contact details before storage.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      isEnabled: true,
      /*
       * True, and it is the first source for which that is defensible. CC0
       * permits redistribution outright, so aggregates derived from this
       * source may be shown to users where Greenhouse's may not.
       */
      mayRedistributeDerived: true,
    };
  }

  private teachingVacanciesSource(): SourceDescriptor {
    return {
      slug: 'teaching-vacancies',
      displayName: 'Teaching Vacancies (UK Department for Education)',
      adapter: new TeachingVacanciesAdapter(),
      client: this.teachingVacancies,
      queryParams: { pageSize: 100 },
      category: 'PUBLIC_OPEN_DATA',
      access: {
        state: 'ENABLED',
        note: 'Open API published by the UK Department for Education. No registration and no credential; the licence is declared in the response envelope itself.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution:
        'Contains public sector information licensed under the Open Government Licence v3.0.',
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published. Pages are 100 vacancies and the whole service is ~3.6k live vacancies, so a complete walk is under 40 requests.',
      },
      /*
       * An affirmative grant, and unusually it is machine-readable: every
       * response envelope carries
       *   "license": { "name": "Open Government License", "url": ... }
       * which is the same kind of in-band evidence that made JobTech the
       * first source with a real licence rather than an absence of terms.
       *
       * OGL v3 grants commercial exploitation by name. The service's own
       * API terms restate it for job listings with one exception - no fee
       * for contacting, interviewing or hiring a respondent to a listing -
       * which a market statistic does not engage.
       */
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        'Open Government Licence v3, declared in the API response envelope itself and restated in the service API terms, verified live 2026-09-08. OGL v3 grants the right to "exploit the Information commercially and non-commercially". One exception applies: a reuser must not charge any fee or commission for contacting, interviewing or hiring a respondent to a listing - which a market-statistics product does not do. Attribution required. Scope: UK schools only, ~3649 live vacancies, so absence of a role here is not evidence of absence in the wider UK market. PII: no structured contact fields; a live sample of 100 vacancies carried an email in 17 bodies, mostly role aliases, removed by the shared redactor before storage.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      isEnabled: true,
      /*
       * True, on the same footing as JobTech: OGL v3 permits commercial
       * exploitation and redistribution outright, so aggregates derived
       * from this source may be shown to a reader.
       */
      mayRedistributeDerived: true,
    };
  }

  private usaJobsHistoricSource(): SourceDescriptor {
    return {
      slug: 'usajobs-historic',
      displayName: 'USAJOBS Historic Announcements (US OPM)',
      adapter: new UsaJobsHistoricAdapter(),
      client: this.usajobs,
      queryParams: { pageSize: 500 },
      category: 'PUBLIC_OPEN_DATA',
      access: {
        state: 'ENABLED',
        /*
         * The access position depends on NOT holding a credential, which
         * inverts the usual direction of this field and is the reason it
         * is spelled out here as well as in the licence note. Registering
         * for the Search API would bind us to terms forbidding derivative
         * works; this endpoint needs no registration and is documented as
         * publicly consumable.
         */
        note: 'Unauthenticated by design. The Historic JOA endpoint is documented as requiring no authorization; the separate Search API is reachable only by registering, and registration binds the caller to terms whose section 2 forbids creating derivative works. Obtaining a key here would REMOVE our right to use the data, so no key is to be requested.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution: 'Source: USAJOBS, U.S. Office of Personnel Management.',
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published for the unauthenticated historic endpoint. Pages are 500 records and the client walks by continuation token.',
      },
      /*
       * An affirmative statement on a live primary page, and it is
       * available only because we do NOT register for a key.
       *
       * The USAJOBS Search API is reached by registration, and
       * registration binds you to terms whose section 2 reads "You may not
       * rent, lease, loan, sell, trade or create derivative works of
       * USAJOBS API services and data, in whole or in part". A vacancy
       * statistic is a derivative work, so that API is unusable here. This
       * endpoint requires no registration and USAJOBS documents it as
       * needing no authorization and being "publicly consumable".
       */
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        'USAJOBS documents the Historic JOA endpoint as requiring no authorization or authentication, with data that is "publicly consumable" - verified live and unauthenticated on 2026-09-08 (125,717 records for series 2210). Backed by 17 U.S.C. 105, which denies copyright to US Government works. IMPORTANT: this position depends on NOT registering for an API key. The separate Search API is gated by a registration contract whose section 2 forbids creating derivative works, so it must not be used. Coverage: closed historic announcements only, US federal employers only - this is a record of past demand, not current vacancies. PII: verified across all 40 fields of a live record, none is a contact, email, phone or person name; the Search API and the AnnouncementText endpoint do carry named HR contacts and neither is read here.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      isEnabled: true,
      mayRedistributeDerived: true,
    };
  }

  private navSource(): SourceDescriptor {
    return {
      slug: 'nav-no',
      displayName: 'NAV Arbeidsplassen (Norway)',
      adapter: new NavAdapter(),
      client: this.nav,
      queryParams: { pageSize: 100 },
      category: 'PUBLIC_OPEN_DATA',
      access: {
        /*
         * DISABLED, and the distinction from REJECTED is the whole reason
         * the state exists. Nothing about this source was refused - its
         * terms name statistical use explicitly and are among the best
         * found anywhere. The blocker is ours: the feed is append-only
         * from 2019 and needs a cursor persisted across runs, which the
         * ingestion model does not have.
         */
        state: 'DISABLED',
        note: 'Access granted and unused. Blocked by our own ingestion model, which starts every run from a null cursor and so re-reads an append-only feed from 2019 - a live 20-page walk returned 20,000 records, all INACTIVE, which NAV\'s terms forbid retaining. Re-enable when cursor persistence exists, not before.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution: 'Data from NAV (Arbeidsplassen), Norway.',
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published. Not exercised: the source is disabled for an ingestion-model reason before any pacing question arises.',
      },
      /*
       * The only source surveyed whose terms name statistical use in so
       * many words. Note the trap: NAV's OpenAPI declares an MIT licence,
       * which covers NAV's source code and NOT the data. The governing
       * terms are the separate termsOfService document.
       */
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        "NAV API terms (arbeidsplassen.nav.no/vilkar-api) grant consumers the right to republish received job ads \"og/eller bruke dei til statistiske/analytiske formaal\" - and/or use them for statistical and analytical purposes - free of charge and open to anyone. Verified live 2026-09-08. CAUTION: NAV's OpenAPI document declares an MIT licence which covers their SOURCE CODE, not the data; do not read it as a data grant. Obligations accepted: ads must be removed immediately once inactive (the adapter refuses non-ACTIVE entries, but there is no delisting record, which is a named residual), and the consumer is an independent GDPR controller. Coverage: Norway only, Norwegian-language titles, and the feed list carries no description - only the per-posting detail endpoint does, and it is not read - so this source contributes to volume and to no prevalence denominator. PII: the detail endpoint carries contactList with named individuals, email and phone; it is declared in the adapter's redaction profile against the day it is read. DISABLED: the feed is append-only from 2019 and requires cursor persistence across runs, which the ingestion model does not have - a live walk returned 20,000 records, all INACTIVE, and NAV's terms forbid retaining inactive ads.",
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      /*
       * DISABLED, and not for a licence reason - the licence here is one
       * of the best available. The pipeline cannot currently use this
       * source honestly.
       *
       * NAV publishes an append-only EVENT feed, ordered oldest-first from
       * 2019, and a consumer is expected to walk it once and persist its
       * cursor. This pipeline starts every run from a null cursor, so it
       * always re-reads the beginning: a live 20-page walk returned 20,000
       * records of which 20,000 were INACTIVE, and `last=true` returns
       * exactly one item rather than a page of recent ones.
       *
       * Storing the inactive ones is not an option either, and that is a
       * licence question rather than a taste one: NAV's terms require ads
       * to be removed from a consumer's results immediately once inactive.
       * So the adapter refuses them, correctly, and the source ingests
       * nothing.
       *
       * This is the first real limit the source contract has hit. Four
       * other pagination models fitted it unchanged; a feed that requires
       * cursor persistence across runs does not, and that is a gap in the
       * ingestion model rather than in this adapter. Left implemented so
       * the shape is covered by the contract tests, and disabled so it
       * cannot pretend to contribute.
       */
      isEnabled: false,
      mayRedistributeDerived: true,
    };
  }

  private jobicySource(): SourceDescriptor {
    return {
      slug: 'jobicy',
      displayName: 'Jobicy (remote roles)',
      adapter: new JobicyAdapter(),
      client: this.jobicy,
      queryParams: { count: 200 },
      /*
       * LICENSED_AGGREGATOR rather than PUBLIC_OPEN_DATA, and the
       * difference is that this grant was made to reusers rather than to
       * the world - so it can be withdrawn, and a category that said
       * "open data" would suggest otherwise.
       */
      category: 'LICENSED_AGGREGATOR',
      access: {
        state: 'ENABLED',
        note: 'Published syndication terms grant reuse without individual permission. No application and no credential. One obligation is an OPERATOR obligation this code cannot enforce: polling is limited to once per hour, which is a scheduling decision outside the pipeline.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution: 'Job listings provided by Jobicy.',
      rateLimit: {
        requestsPerMinute: 1,
        note: 'The syndication terms limit polling to once per hour. Expressed here as the provider\'s stated ceiling; the pipeline does not schedule itself, so honouring it is an operator obligation and is recorded as one.',
      },
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        'Jobicy syndication terms grant reuse without individual permission: "You may use Jobicy listings in your own products and user experiences without requesting individual permission... You may create your own interfaces, summaries, categories, search experiences, and additional context around listings." Attribution and canonical URL retention required; polling limited to once per hour, which is an operator scheduling obligation this code does not enforce. Verified live 2026-09-08. Coverage limitation, and it is severe: the API serves a rolling window of the most recent listings with NO pagination, so a scope reads as complete because the source served everything it will serve - which is not the same as having read the market. Treat as a signal source, never a census.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      isEnabled: true,
      mayRedistributeDerived: true,
    };
  }

  private canadaJobBankSource(): SourceDescriptor {
    return {
      slug: 'canada-job-bank',
      displayName: 'Canada Job Bank (Employment and Social Development Canada)',
      adapter: new CanadaJobBankAdapter(),
      client: this.canada,
      queryParams: { fileEncoding: 'utf-16le', separator: 'tab' },
      category: 'PUBLIC_OPEN_DATA',
      access: {
        state: 'ENABLED',
        note: 'Open bulk file published through the open.canada.ca CKAN catalogue. No registration and no credential; the licence id is machine-readable in the package metadata.',
        reviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      credentials: null,
      attribution:
        'Contains information licensed under the Open Government Licence - Canada.',
      rateLimit: {
        requestsPerMinute: null,
        note: 'None published. One monthly file per walk, so the question barely arises.',
      },
      /*
       * The licence is machine-readable in the publisher's own catalogue:
       * CKAN returns "license_id": "ca-ogl-lgo". OGL - Canada grants use
       * "in any medium, mode or format for any lawful purpose", which
       * covers commercial use and aggregation without further conditions
       * beyond attribution.
       */
      licenceBasis: 'EXPLICIT_GRANT',
      licenceNote:
        'Open Government Licence - Canada, read from the open.canada.ca CKAN package metadata as "license_id": "ca-ogl-lgo", verified live 2026-09-08. Grants copying, adaptation, publication and distribution "in any medium, mode or format for any lawful purpose"; attribution required ("Contains information licensed under the Open Government Licence - Canada"). Excludes personal information and third-party rights, neither of which appears here. Coverage limitation, and it is significant: the file carries NO employer name and NO job description in any of its 65 columns, so every posting is descriptionCompleteness ABSENT with a null company - this source contributes to role volume and can never contribute to a prevalence denominator or clear the distinct-employer floor. Published monthly, so it is a monthly snapshot rather than a live feed. PII: none - all 65 columns enumerated, no contact, name, employer or free text of any kind, making it the lowest privacy risk of any source surveyed.',
      licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
      isEnabled: true,
      mayRedistributeDerived: true,
    };
  }

  /*
   * Phase 11's first partner-shaped source, and the honest outcome of it.
   *
   * TECHNICALLY COMPLETE, EXTERNALLY BLOCKED. The adapter parses the real
   * payload, the client handles the real failure modes, both are covered
   * by the same contract tests every other source passes, and the source
   * ingests nothing - because the right to ingest it has not been
   * established and technical availability is not permission.
   *
   * WHY THIS PROVIDER AND NOT THE FIRST ON THE LIST. Phase 11 names iCIMS,
   * then Oracle Recruiting, then Ashby. Neither of the first two can be
   * built faithfully from here: both are reached only through an executed
   * partner agreement with issued credentials, and their payload shapes
   * are behind that agreement - so an adapter for either would be an
   * adapter for a shape somebody imagined, tested against fixtures the
   * same person invented. That is not an integration; it is a drawing of
   * one. Ashby was chosen because this project's own source roadmap had
   * already identified Ashby and Workable as the ONLY ATS route that is
   * not a dead end, for a reason that is about ownership rather than about
   * terms: their partner feeds are consent-gated, and the consenting party
   * is the EMPLOYER - which is the missing authority, because the employer
   * is who owns the posting text.
   *
   * WHAT IS ACTUALLY BLOCKED. Not the endpoint. The public job board API
   * answers unauthenticated, and its shape was read from one live response
   * on 2026-09-09 to write the adapter against something real. What is
   * blocked is the PARTNER feed, whose terms are not public and whose
   * access is a business-development conversation, not an engineering
   * task. Ingesting the public endpoint instead would be helping ourselves
   * to employers' text on the grounds that a vendor left a door open,
   * which is the exact reasoning Part U forbids.
   */
  private ashbySource(): SourceDescriptor {
    return {
      slug: 'ashby',
      displayName: 'Ashby (ATS job boards)',
      adapter: new AshbyAdapter(),
      client: this.ashby,
      queryParams: { boardPerScope: true },
      category: 'ATS',
      access: {
        state: 'BLOCKED_EXTERNAL_ACCESS',
        note: 'Adapter and client complete and tested against a live response shape read on 2026-09-09 (70 postings, apiVersion 1). NOT ingesting. The public posting API is unauthenticated, and that is not a grant: Ashby hosts text its customers own, so vendor-side availability cannot license employer-owned content. The route that would license it is Ashby\'s consent-gated partner feed, where the employer agrees to syndication - terms not public, access not requested and not held, and obtaining it is business development rather than engineering. Move to ACCESS_REQUESTED when an approach is actually made; nothing here may reach ENABLED without partner terms in hand.',
        reviewedAt: new Date('2026-09-09T00:00:00.000Z'),
      },
      /*
       * Declared by NAME, and inert. The public endpoint needs nothing, so
       * an unset ASHBY_API_KEY is not a misconfiguration - it is the
       * normal state. The requirement is carried anyway so that the day
       * partner access exists, the credential path is one that has been
       * tested rather than one written in a hurry.
       */
      credentials: ASHBY_CREDENTIALS,
      /*
       * Null because no permission has been established, so no permission
       * has told us what it obliges. It is not "no attribution required" -
       * it is a question that has not been asked of anybody, and a credit
       * line invented here would imply a relationship that does not exist.
       */
      attribution: null,
      rateLimit: {
        requestsPerMinute: 60,
        note: 'None published for the posting API. 60/min is OUR ceiling, not theirs: the client enforces a one-second minimum interval between requests and a one-second delay between boards. A self-imposed limit on an ungranted endpoint, which is the only defensible setting for one.',
      },
      /*
       * Unresolved, and REJECTED would be wrong. Greenhouse's position was
       * assessed and refused; this one has a real route that nobody has
       * walked yet. The basis stays UNADDRESSED_PUBLIC_ENDPOINT because
       * that is precisely what the public endpoint is - available, and
       * governed by nothing that speaks to us.
       */
      licenceBasis: 'UNADDRESSED_PUBLIC_ENDPOINT',
      licenceNote:
        'No terms governing third-party reuse of the public job board API were found on 2026-09-09. The endpoint is unauthenticated and documented for embedding a customer\'s OWN board, which is a different act from aggregating many. The decisive point is ownership rather than terms: Ashby\'s customer agreement leaves the customer holding rights in its content, so Ashby cannot license the posting text to us and an open endpoint does not either. PII: no structured contact fields across the eighteen keys observed, but bodies are hiring-manager prose and the live sample opened with a named manager and a personal LinkedIn URL - the universal email and phone patterns apply, and names in prose remain the pipeline-wide stated residual.',
      licenceReviewedAt: new Date('2026-09-09T00:00:00.000Z'),
      /*
       * False, and the CHECK constraint on MarketSource now makes it
       * impossible for this to be true while the access state is anything
       * but ENABLED - so this cannot drift the way Greenhouse's row did.
       */
      isEnabled: false,
      mayRedistributeDerived: false,
    };
  }

}
