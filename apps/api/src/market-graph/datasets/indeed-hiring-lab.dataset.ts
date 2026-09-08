import { Injectable } from '@nestjs/common';

import { fetchText, parseCsv, toObjects } from './csv.js';
import type {
  AggregateObservationRecord,
  DatasetFetch,
  DatasetSource,
} from './dataset-source.js';

/*
 * Indeed Hiring Lab job-postings index.
 *
 * CC BY 4.0, published by Indeed's own economics arm on GitHub with no
 * credential. Worth noting that Indeed publishes this while its API terms
 * forbid building a competing product from its postings - the aggregate
 * door is open at exactly the company whose posting door is bolted.
 *
 * The index is a percentage change against a 2020-02-01 = 100 baseline,
 * NOT a count of jobs. Indeed says so themselves, and the metric name
 * carries it so no reader can mistake it for a vacancy total.
 */

const BASE =
  'https://raw.githubusercontent.com/hiring-lab/job_postings_tracker/master/US';

@Injectable()
export class IndeedHiringLabDataset implements DatasetSource {
  readonly sourceSlug = 'indeed-hiring-lab';

  readonly datasetKey = 'job-postings-index';

  readonly kind = 'AGGREGATE' as const;

  readonly attribution =
    'Data from Indeed Hiring Lab, used under the CC BY 4.0 license. Source: Indeed Hiring Lab Job Postings Index.';

  async fetch(): Promise<DatasetFetch> {
    const rows = toObjects(
      parseCsv(await fetchText(`${BASE}/aggregate_job_postings_US.csv`)),
    );

    const observations: AggregateObservationRecord[] = [];
    let latest = '';

    for (const row of rows) {
      const date = row['date'] ?? '';
      const value = row['indeed_job_postings_index_SA'] ?? '';

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || value === '') {
        continue;
      }

      if (date > latest) {
        latest = date;
      }

      observations.push({
        seriesKey: 'job_postings_index',
        geography: row['jobcountry'] ?? 'US',
        category: row['variable'] ?? null,
        periodStart: `${date}T00:00:00.000Z`,
        periodEnd: `${date}T00:00:00.000Z`,
        periodType: 'DAY',
        metric: 'job_postings_index_sa_vs_2020_02_01_baseline',
        /* Kept as the published string; see the model comment on value. */
        value,
        unit: 'index',
      });
    }

    return {
      /*
       * The publisher issues no version number, so the latest observation
       * date is the version. It is derived from the data rather than from
       * our clock, so re-importing an unchanged file is idempotent.
       */
      version: latest === '' ? 'unknown' : latest,
      releasedAt: latest === '' ? null : `${latest}T00:00:00.000Z`,
      terms: [],
      observations: observations.sort((a, b) => {
        const ka = `${a.periodStart}\u0000${a.category ?? ''}`;
        const kb = `${b.periodStart}\u0000${b.category ?? ''}`;

        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    };
  }
}
