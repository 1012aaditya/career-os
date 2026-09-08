import { Injectable, NotFoundException } from '@nestjs/common';

import { GreenhouseAdapter } from './greenhouse/greenhouse.adapter.js';
import { GreenhouseClient } from './greenhouse/greenhouse.client.js';
import { JobTechAdapter } from './jobtech/jobtech.adapter.js';
import { JobTechClient } from './jobtech/jobtech.client.js';
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
  ) {}

  descriptors(): SourceDescriptor[] {
    return [
      this.greenhouseSource(),
      this.jobtechSource(),
      this.teachingVacanciesSource(),
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
}
