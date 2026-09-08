import { Injectable } from '@nestjs/common';

import { fetchJson } from './csv.js';
import type {
  AggregateObservationRecord,
  DatasetFetch,
  DatasetSource,
} from './dataset-source.js';

/*
 * BLS JOLTS - US job openings.
 *
 * Everything BLS publishes is in the public domain, so there is no licence
 * to satisfy beyond citing the source. The v1 endpoint needs no key, which
 * is why it is used here: a registered v2 key would raise the daily quota
 * but would put a credential on the ingestion path for data that does not
 * require one.
 *
 * This is the natural validation series for the product's own counts -
 * JOLTS measures actual openings, against which a postings index can be
 * sanity-checked.
 */

const URL_V1 = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';

/** Total nonfarm job openings, seasonally adjusted, level. */
const SERIES = 'JTS000000000000000JOL';

const MONTH: Readonly<Record<string, number>> = {
  M01: 1,
  M02: 2,
  M03: 3,
  M04: 4,
  M05: 5,
  M06: 6,
  M07: 7,
  M08: 8,
  M09: 9,
  M10: 10,
  M11: 11,
  M12: 12,
};

@Injectable()
export class BlsJoltsDataset implements DatasetSource {
  readonly sourceSlug = 'bls';

  readonly datasetKey = 'jolts-job-openings';

  readonly kind = 'AGGREGATE' as const;

  readonly attribution =
    'Source: U.S. Bureau of Labor Statistics, Job Openings and Labor Turnover Survey (JOLTS). BLS data are in the public domain.';

  async fetch(): Promise<DatasetFetch> {
    const year = new Date().getUTCFullYear();

    const body = (await fetchJson(URL_V1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seriesid: [SERIES],
        startyear: String(year - 2),
        endyear: String(year),
      }),
    })) as {
      Results?: {
        series?: Array<{
          seriesID?: string;
          data?: Array<{ year?: string; period?: string; value?: string }>;
        }>;
      };
    };

    const observations: AggregateObservationRecord[] = [];
    let latest = '';

    for (const series of body.Results?.series ?? []) {
      for (const point of series.data ?? []) {
        const month = MONTH[point.period ?? ''];

        if (
          month === undefined ||
          point.year === undefined ||
          point.value === undefined
        ) {
          continue;
        }

        const start = `${point.year}-${String(month).padStart(2, '0')}-01`;
        const endDay = new Date(Date.UTC(Number(point.year), month, 0))
          .toISOString()
          .slice(0, 10);

        if (start > latest) {
          latest = start;
        }

        observations.push({
          seriesKey: series.seriesID ?? SERIES,
          geography: 'US',
          category: null,
          periodStart: `${start}T00:00:00.000Z`,
          periodEnd: `${endDay}T00:00:00.000Z`,
          periodType: 'MONTH',
          metric: 'job_openings_level',
          value: point.value,
          unit: 'thousands_of_jobs',
        });
      }
    }

    return {
      /* The latest reference period, derived from the data not the clock. */
      version: latest === '' ? 'unknown' : latest,
      releasedAt: null,
      terms: [],
      observations: observations.sort((a, b) =>
        a.periodStart < b.periodStart
          ? -1
          : a.periodStart > b.periodStart
            ? 1
            : 0,
      ),
    };
  }
}
