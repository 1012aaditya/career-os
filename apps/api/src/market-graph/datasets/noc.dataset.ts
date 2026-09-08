import { Injectable } from '@nestjs/common';

import { fetchText, parseCsv, toObjects } from './csv.js';
import type {
  DatasetFetch,
  DatasetSource,
  TaxonomyTermRecord,
} from './dataset-source.js';

/*
 * NOC 2021 v1.0 - Canada's National Occupational Classification.
 *
 * Open Government Licence - Canada, granting worldwide royalty-free use
 * including commercial. Its codes are STRINGS: NOC codes carry significant
 * leading zeros ("00010"), and parsing them as integers silently merges
 * distinct occupations.
 */

const URL_STRUCTURE =
  'https://www.statcan.gc.ca/en/subjects/standard/noc/2021/indexV1/noc-2021-v1.0-classification-structure.csv';

const VERSION = '2021-v1.0';

@Injectable()
export class NocDataset implements DatasetSource {
  readonly sourceSlug = 'noc';

  readonly datasetKey = 'noc-structure';

  readonly kind = 'TAXONOMY' as const;

  readonly attribution =
    'Contains information licensed under the Open Government Licence - Canada. Source: Statistics Canada, National Occupational Classification (NOC) 2021 Version 1.0.';

  async fetch(): Promise<DatasetFetch> {
    const rows = toObjects(parseCsv(await fetchText(URL_STRUCTURE)));
    const terms: TaxonomyTermRecord[] = [];

    for (const row of rows) {
      const externalCode = pick(row, [
        'Code - NOC 2021 V1.0',
        'Code',
        'NOC Code',
      ]);
      const label = pick(row, ['Class title', 'Class Title', 'Title']);

      if (externalCode === '' || label === '') {
        continue;
      }

      terms.push({
        kind: 'OCCUPATION',
        externalCode,
        label,
        language: 'en',
        /*
         * The NOC hierarchy is expressed by code length: a 4-digit code's
         * parent is its 3-digit prefix. Derived only where that is exact,
         * never guessed.
         */
        parentCode: externalCode.length > 1 ? externalCode.slice(0, -1) : null,
      });
    }

    return {
      version: VERSION,
      releasedAt: '2021-09-21T00:00:00.000Z',
      terms: terms.sort((a, b) => {
        const ka = `${a.externalCode}\u0000${a.label}`;
        const kb = `${b.externalCode}\u0000${b.label}`;

        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
      observations: [],
    };
  }
}

function pick(row: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const value = row[name];

    if (value !== undefined && value.trim() !== '') {
      return value.trim();
    }
  }

  return '';
}
