import { Injectable } from '@nestjs/common';

import { fetchText, parseCsv, toObjects } from './csv.js';
import type {
  DatasetFetch,
  DatasetSource,
  TaxonomyTermRecord,
} from './dataset-source.js';

/*
 * O*NET 31.0 occupational taxonomy.
 *
 * From the BULK DOWNLOAD, never the Web Services API, and that distinction
 * is the whole design. The bulk database is CC BY 4.0 and grants
 * adaptation outright. The API's data licence is NOT CC BY - it is
 * account-bound, non-transferable, and its term 10a requires the data be
 * presented "without alteration or modification", which is precisely what
 * mapping terms into a vocabulary does. Using the API here would breach it
 * on the first mapping.
 */

const BASE = 'https://www.onetcenter.org/dl_files/database/db_31_0_csv';

const VERSION = '31.0';

@Injectable()
export class OnetDataset implements DatasetSource {
  readonly sourceSlug = 'onet';

  readonly datasetKey = 'onet-occupations';

  readonly kind = 'TAXONOMY' as const;

  readonly attribution =
    'This page includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET is a trademark of USDOL/ETA. Career OS has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.';

  async fetch(): Promise<DatasetFetch> {
    const [occupations, titles] = await Promise.all([
      fetchText(`${BASE}/occupation_data.csv`),
      fetchText(`${BASE}/job_titles.csv`),
    ]);

    const terms: TaxonomyTermRecord[] = [];

    for (const row of toObjects(parseCsv(occupations))) {
      const externalCode = row['O*NET-SOC Code'] ?? '';
      const label = row['Title'] ?? '';

      if (externalCode !== '' && label !== '') {
        terms.push({
          kind: 'OCCUPATION',
          externalCode,
          label,
          language: 'en',
          parentCode: null,
        });
      }
    }

    for (const row of toObjects(parseCsv(titles))) {
      const externalCode = row['O*NET-SOC Code'] ?? '';
      const label = row['Alternate Title'] ?? row['Job Title'] ?? '';

      if (externalCode !== '' && label !== '') {
        terms.push({
          kind: 'ALTERNATE_TITLE',
          externalCode,
          label,
          language: 'en',
          parentCode: externalCode,
        });
      }
    }

    return {
      version: VERSION,
      /* The publisher's release date, never our fetch date. */
      releasedAt: '2026-08-25T00:00:00.000Z',
      terms: order(terms),
      observations: [],
    };
  }
}

/*
 * Ordered and de-duplicated by us, because the source's row order is not
 * promised. Leaving it alone would make the content hash depend on how the
 * publisher happened to sort a CSV.
 */
function order(terms: TaxonomyTermRecord[]): TaxonomyTermRecord[] {
  const seen = new Map<string, TaxonomyTermRecord>();

  for (const term of terms) {
    seen.set(`${term.kind}\u0000${term.externalCode}\u0000${term.label}`, term);
  }

  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, term]) => term);
}
