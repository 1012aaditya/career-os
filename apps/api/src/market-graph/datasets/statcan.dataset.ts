import { Injectable } from '@nestjs/common';

import { fetchJson } from './csv.js';
import type {
  AggregateObservationRecord,
  DatasetFetch,
  DatasetSource,
} from './dataset-source.js';

/*
 * Statistics Canada Job Vacancy and Wage Survey, table 14-10-0444.
 *
 * The StatCan Open Licence grants "use, reproduce, publish, freely
 * distribute, or sell", which is among the most permissive terms of any
 * source here. No key and no registration.
 *
 * 14-10-0444 rather than the widely-cited 14-10-0325/0326/0328/0356: those
 * four are ARCHIVED and frozen at Q3 2023. Building against a dead table
 * would produce a series that silently stops.
 *
 * One licence condition shapes the design: the Open Licence forbids
 * merging the data with other databases "for the purpose of attempting to
 * identify an individual person, business or organization". These rows are
 * kept as published cells and are never joined to employer identity.
 */

const WDS =
  'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods';

const PRODUCT_ID = 14100444;

/* Canada, all occupations, job vacancies. Verified against the live API. */
const COORDINATE = '1.1.1.0.0.0.0.0.0.0';

const PERIODS = 24;

@Injectable()
export class StatCanJvwsDataset implements DatasetSource {
  readonly sourceSlug = 'statcan';

  readonly datasetKey = 'jvws-14-10-0444';

  readonly kind = 'AGGREGATE' as const;

  readonly attribution =
    'Source: Statistics Canada, Table 14-10-0444-01, Job vacancies and average offered hourly wage. Reproduced and distributed on an "as is" basis with the permission of Statistics Canada.';

  async fetch(): Promise<DatasetFetch> {
    const body = (await fetchJson(WDS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { productId: PRODUCT_ID, coordinate: COORDINATE, latestN: PERIODS },
      ]),
    })) as Array<{
      status?: string;
      object?: {
        vectorId?: number;
        vectorDataPoint?: Array<{
          refPer?: string;
          refPer2?: string;
          value?: number | string;
          scalarFactorCode?: number;
        }>;
      };
    }>;

    const first = body[0];

    if (first?.status !== 'SUCCESS') {
      throw new Error(`StatCan refused the coordinate: ${first?.status}`);
    }

    const observations: AggregateObservationRecord[] = [];
    let latest = '';

    for (const point of first.object?.vectorDataPoint ?? []) {
      const start = point.refPer ?? '';

      if (start === '' || point.value === undefined || point.value === null) {
        continue;
      }

      if (start > latest) {
        latest = start;
      }

      observations.push({
        seriesKey: `v${first.object?.vectorId ?? 0}`,
        geography: 'Canada',
        category: 'all-occupations',
        periodStart: `${start}T00:00:00.000Z`,
        periodEnd: `${point.refPer2 !== undefined && point.refPer2 !== '' ? point.refPer2 : start}T00:00:00.000Z`,
        periodType: 'QUARTER',
        metric: 'job_vacancies',
        /* String, so the published figure is reproduced exactly. */
        value: String(point.value),
        unit: 'vacancies',
      });
    }

    return {
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
