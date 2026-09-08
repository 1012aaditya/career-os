import { describe, expect, it } from 'vitest';

import { parseCsv, toObjects } from './csv.js';
import { MarketDatasetRegistry } from './dataset-registry.js';
import { BlsJoltsDataset } from './bls.dataset.js';
import { IndeedHiringLabDataset } from './indeed-hiring-lab.dataset.js';
import { NocDataset } from './noc.dataset.js';
import { OnetDataset } from './onet.dataset.js';
import { StatCanJvwsDataset } from './statcan.dataset.js';

/*
 * Class B is published evidence, not observed postings, and these are the
 * properties that keep the two from being confused.
 */

function registry(): MarketDatasetRegistry {
  return new MarketDatasetRegistry(
    new OnetDataset(),
    new NocDataset(),
    new IndeedHiringLabDataset(),
    new BlsJoltsDataset(),
    new StatCanJvwsDataset(),
  );
}

describe('the dataset registry', () => {
  it('declares exactly the datasets Phase 8 imports', () => {
    expect(
      registry()
        .descriptors()
        .map((d) => d.slug),
    ).toEqual(['onet', 'noc', 'indeed-hiring-lab', 'bls', 'statcan']);
  });

  /*
   * Attribution is carried on the descriptor and stored with every
   * imported version, because an obligation that lives only in a document
   * is one nobody renders. O*NET, NOC, StatCan and Indeed Hiring Lab all
   * require it.
   */
  it('carries a non-empty attribution string for every dataset', () => {
    for (const descriptor of registry().descriptors()) {
      expect(
        `${descriptor.slug}: ${descriptor.dataset.attribution.length > 40}`,
      ).toBe(`${descriptor.slug}: true`);
    }
  });

  it('enables no dataset whose licence position is unresolved', () => {
    for (const descriptor of registry().descriptors()) {
      if (descriptor.licenceBasis === 'UNADDRESSED_PUBLIC_ENDPOINT') {
        expect(descriptor.isEnabled).toBe(false);
      }
    }
  });

  /*
   * The O*NET trap, asserted so it cannot be undone by a well-meaning
   * refactor. The bulk database is CC BY 4.0 and permits adaptation; the
   * Web Services API is a different licence that forbids modifying the
   * data at all, which is what normalising it into a vocabulary does.
   */
  it('reads O*NET from the bulk download and never the Web Services API', () => {
    const onet = readFileSyncSafe('onet.dataset.ts');

    expect(onet).toContain('onetcenter.org/dl_files/database');
    expect(onet).not.toContain('services.onetcenter.org');
  });

  it('names each dataset kind explicitly', () => {
    const kinds = registry()
      .descriptors()
      .map((d) => d.dataset.kind);

    expect(kinds).toEqual([
      'TAXONOMY',
      'TAXONOMY',
      'AGGREGATE',
      'AGGREGATE',
      'AGGREGATE',
    ]);
  });
});

describe('reading a published file', () => {
  it('refuses a row whose width disagrees with the header', () => {
    /*
     * A short row is not a row with missing fields - every value after the
     * gap belongs to the wrong column, so reading it would put a postcode
     * in a job title silently.
     */
    const rows = toObjects(parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8'));

    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '6', b: '7', c: '8' },
    ]);
  });

  it('keeps a quoted separator inside its field', () => {
    expect(toObjects(parseCsv('a,b\n"x,y",z'))).toEqual([{ a: 'x,y', b: 'z' }]);
  });

  it('unescapes a doubled quote', () => {
    expect(toObjects(parseCsv('a\n"say ""hi"""'))).toEqual([{ a: 'say "hi"' }]);
  });

  it('strips a byte-order mark from the first header name', () => {
    const rows = parseCsv('\uFEFFcode,label\n1,x');

    expect(rows[0]?.[0]).toBe('code');
  });

  it('reads a tab-separated file when told to', () => {
    expect(toObjects(parseCsv('a\tb\n1\t2', '\t'))).toEqual([
      { a: '1', b: '2' },
    ]);
  });
});

function readFileSyncSafe(name: string): string {
  /* eslint-disable-next-line */
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');

  return readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    'utf8',
  );
}
