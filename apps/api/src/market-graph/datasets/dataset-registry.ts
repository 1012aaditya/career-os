import { Injectable, NotFoundException } from '@nestjs/common';

import { BlsJoltsDataset } from './bls.dataset.js';
import type { DatasetSource } from './dataset-source.js';
import { IndeedHiringLabDataset } from './indeed-hiring-lab.dataset.js';
import { NocDataset } from './noc.dataset.js';
import { OnetDataset } from './onet.dataset.js';
import { StatCanJvwsDataset } from './statcan.dataset.js';

/*
 * The Class B registry: published datasets rather than observed postings.
 *
 * Deliberately separate from MarketSourceRegistry. A posting source has an
 * adapter and a paginating client; a dataset source has a version and a
 * release date. Forcing both through one descriptor would mean a type
 * whose half the fields are always null.
 *
 * The licence position lives here, beside the dataset it governs, for the
 * same reason it does on the posting side - it is a fact about the source,
 * not about our schema.
 */

export type DatasetDescriptor = {
  slug: string;
  displayName: string;
  dataset: DatasetSource;
  licenceBasis: 'EXPLICIT_GRANT' | 'UNADDRESSED_PUBLIC_ENDPOINT' | 'CONTRACTED';
  licenceNote: string;
  licenceReviewedAt: Date;
  isEnabled: boolean;
  mayRedistributeDerived: boolean;
  /** Where the evidence describes, so a reader knows what it does not cover. */
  geography: string;
};

@Injectable()
export class MarketDatasetRegistry {
  constructor(
    private readonly onet: OnetDataset,
    private readonly noc: NocDataset,
    private readonly indeed: IndeedHiringLabDataset,
    private readonly bls: BlsJoltsDataset,
    private readonly statcan: StatCanJvwsDataset,
  ) {}

  descriptors(): DatasetDescriptor[] {
    return [
      {
        slug: 'onet',
        displayName: 'O*NET (US Department of Labor)',
        dataset: this.onet,
        licenceBasis: 'EXPLICIT_GRANT',
        licenceNote:
          'O*NET 31.0 Database Content License is CC BY 4.0, granting copying and adaptation with attribution. CRITICAL: this applies to the BULK DOWNLOAD only. The O*NET Web Services API is governed by a separate, non-transferable, account-bound licence whose term 10a requires data be presented without alteration or modification - which normalising terms into a vocabulary is. This adapter reads the bulk files and must never be repointed at the API. Wages and employment volumes surfaced through O*NET are BLS data, carved out of both O*NET licences.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        isEnabled: true,
        mayRedistributeDerived: true,
        geography: 'US (taxonomy, globally applicable)',
      },
      {
        slug: 'noc',
        displayName: 'NOC 2021 (Statistics Canada)',
        dataset: this.noc,
        licenceBasis: 'EXPLICIT_GRANT',
        licenceNote:
          'Open Government Licence - Canada, granting worldwide royalty-free use including commercial purposes, with mandatory attribution. Codes carry significant leading zeros and are handled as strings throughout.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        isEnabled: true,
        mayRedistributeDerived: true,
        geography: 'Canada (taxonomy, bilingual en/fr)',
      },
      {
        slug: 'indeed-hiring-lab',
        displayName: 'Indeed Hiring Lab',
        dataset: this.indeed,
        licenceBasis: 'EXPLICIT_GRANT',
        licenceNote:
          'CC BY 4.0, published by Indeed Hiring Lab with the requirement that Hiring Lab is cited as the source. Note this is an INDEX against a 2020-02-01 = 100 baseline, not a count of jobs; Indeed states that postings "do not reflect a precise number of available jobs". Aggregate only - it carries no individual postings, and Indeed API terms separately forbid building a competing product from its postings.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        isEnabled: true,
        mayRedistributeDerived: true,
        geography: 'US (national, sector, state, metro)',
      },
      {
        slug: 'bls',
        displayName: 'US Bureau of Labor Statistics (JOLTS)',
        dataset: this.bls,
        licenceBasis: 'EXPLICIT_GRANT',
        licenceNote:
          'Everything BLS publishes is in the public domain; BLS asks only that it be cited as the source. The unregistered v1 endpoint is used deliberately - a registered v2 key would raise the daily quota but would put a credential on an ingestion path that does not need one. BLS asks that users state it cannot vouch for analyses derived from its data after retrieval.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        isEnabled: true,
        mayRedistributeDerived: true,
        geography: 'US (national)',
      },
      {
        slug: 'statcan',
        displayName: 'Statistics Canada (Job Vacancy and Wage Survey)',
        dataset: this.statcan,
        licenceBasis: 'EXPLICIT_GRANT',
        licenceNote:
          'Statistics Canada Open Licence grants a worldwide royalty-free licence to use, reproduce, publish, freely distribute, or sell the Information and value-added products. One condition shapes the design: it forbids merging the Information with other databases for the purpose of attempting to identify an individual person, business or organization - so these cells are never joined to employer identity. Table 14-10-0444 is used because 14-10-0325/0326/0328/0356 are ARCHIVED and frozen at Q3 2023.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        isEnabled: true,
        mayRedistributeDerived: true,
        geography: 'Canada (national)',
      },
    ];
  }

  get(slug: string): DatasetDescriptor {
    const found = this.descriptors().find((d) => d.slug === slug);

    if (found === undefined) {
      throw new NotFoundException(`Unknown market dataset: ${slug}`);
    }

    return found;
  }
}
