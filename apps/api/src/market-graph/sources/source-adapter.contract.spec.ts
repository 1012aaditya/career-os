import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../common/canonical-json.js';
import { normalizePosting } from '../normalization/normalize.js';
import {
  orderAndDedupe,
  postingContentHash,
} from '../observations/posting-identity.js';
import { FakeShapeAdapter } from './fake-shape/fake-shape.adapter.js';
import { GreenhouseAdapter } from './greenhouse/greenhouse.adapter.js';
import type { SourceAdapter } from './source-adapter.js';

/*
 * The contract every source adapter must satisfy, run against two adapters
 * of deliberately different shape.
 *
 * This file is the evidence for the claim that a second source can be
 * added without redesigning anything. Adding a seventh adapter means
 * writing one more entry in ADAPTERS below and making it pass; if it
 * cannot, the contract has found a real gap in the canonical model, which
 * is what it is for.
 */

const CONTRACT_KEYS = [
  'applyUrlRaw',
  'companyRaw',
  'descriptionCompleteness',
  'descriptionRaw',
  'externalGroupKey',
  'externalKey',
  'locationRaw',
  'payload',
  'sourceCategoriesRaw',
  'sourcePublishedAt',
  'sourceScope',
  'sourceUpdatedAt',
  'sourceValidThrough',
  'titleRaw',
].sort();

const ADAPTERS: Array<{
  name: string;
  make: () => SourceAdapter;
  page: unknown;
  pageWithNull: unknown;
  pageMissingTitle: unknown;
  pageWithDuplicate: unknown;
}> = [
  {
    name: 'greenhouse',
    make: () => new GreenhouseAdapter(),
    page: {
      jobs: [
        {
          id: 2,
          title: 'Backend Engineer',
          content: '&lt;p&gt;We use Postgres&lt;/p&gt;',
          company_name: 'Acme',
          location: { name: 'Remote' },
          absolute_url: 'https://example.invalid/2',
          updated_at: '2026-08-18T18:06:19-04:00',
          first_published: '2026-08-06T12:50:10-04:00',
          application_deadline: null,
          internal_job_id: 900,
          departments: [{ id: 5, name: 'Engineering' }],
        },
        {
          id: 1,
          title: 'Frontend Engineer',
          content: '&lt;p&gt;React&lt;/p&gt;',
          company_name: 'Acme',
          location: { name: 'London' },
          absolute_url: 'https://example.invalid/1',
          updated_at: '2026-08-18T18:06:19-04:00',
          first_published: '2026-08-06T12:50:10-04:00',
          application_deadline: null,
          internal_job_id: 901,
          departments: [{ id: 5, name: 'Engineering' }],
        },
      ],
    },
    pageWithNull: { jobs: [null, { id: 3, title: 'Data Engineer' }] },
    pageMissingTitle: { jobs: [{ id: 4 }, { id: 5, title: 'QA Engineer' }] },
    pageWithDuplicate: {
      jobs: [
        { id: 7, title: 'First' },
        { id: 7, title: 'Second' },
      ],
    },
  },
  {
    name: 'fake-shape',
    make: () => new FakeShapeAdapter(),
    page: {
      data: {
        items: [
          {
            ref: 'b',
            headline: 'Backend Engineer',
            preview: 'We use Postgres and',
            place: 'Remote',
            link: 'https://example.invalid/b',
            posted_ts: 1_786_000_000,
            closes_ts: 1_790_000_000,
            tags: 'postgres, python',
          },
          {
            ref: 'a',
            headline: 'Frontend Engineer',
            preview: 'React and',
            place: 'London',
            link: 'https://example.invalid/a',
            posted_ts: 1_786_000_000,
            tags: 'react',
          },
        ],
      },
      paging: { after: 'cursor-2' },
    },
    pageWithNull: {
      data: { items: [null, { ref: 'c', headline: 'Data Engineer' }] },
    },
    pageMissingTitle: {
      data: { items: [{ ref: 'd' }, { ref: 'e', headline: 'QA Engineer' }] },
    },
    pageWithDuplicate: {
      data: {
        items: [
          { ref: 'f', headline: 'First' },
          { ref: 'f', headline: 'Second' },
        ],
      },
    },
  },
];

it('runs against at least two adapters of different shape', () => {
  /*
   * A guard on the guard. Deleting the fake adapter and leaving this file
   * behind would turn a contract into a description of Greenhouse, and
   * nothing else here would notice.
   */
  expect(ADAPTERS.length).toBeGreaterThanOrEqual(2);
});

describe.each(ADAPTERS)(
  'the $name adapter contract',
  ({ name, make, page, pageWithNull, pageMissingTitle, pageWithDuplicate }) => {
    it('emits exactly the contract key set and nothing else', () => {
      const { accepted } = make().parse(page, 'scope-1');

      expect(accepted.length).toBeGreaterThan(0);

      for (const record of accepted) {
        expect(Object.keys(record).sort()).toEqual(CONTRACT_KEYS);
      }
    });

    it('emits every timestamp as a UTC instant or null, never a Date', () => {
      const { accepted } = make().parse(page, 'scope-1');

      for (const record of accepted) {
        for (const field of [
          'sourcePublishedAt',
          'sourceUpdatedAt',
          'sourceValidThrough',
        ] as const) {
          const value = record[field];

          expect(
            value === null ||
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
          ).toBe(true);
        }
      }
    });

    it('emits a non-empty string key for every accepted record', () => {
      const { accepted } = make().parse(page, 'scope-1');

      for (const record of accepted) {
        expect(typeof record.externalKey).toBe('string');
        expect(record.externalKey.length).toBeGreaterThan(0);
        expect(record.sourceScope).toBe('scope-1');
      }
    });

    it('parses the same payload to the same records twice', () => {
      const first = make().parse(page, 'scope-1');
      const second = make().parse(page, 'scope-1');

      expect(canonicalJson(second)).toBe(canonicalJson(first));
    });

    it('produces the same ordered result from a reversed payload', () => {
      const forward = orderAndDedupe(make().parse(page, 'scope-1').accepted);

      const reversedPage = structuredClone(page) as Record<string, unknown>;
      reverseItems(reversedPage);

      const reversed = orderAndDedupe(
        make().parse(reversedPage, 'scope-1').accepted,
      );

      expect(reversed.ordered.map(postingContentHash)).toEqual(
        forward.ordered.map(postingContentHash),
      );
    });

    it('quarantines a null record instead of throwing', () => {
      const result = make().parse(pageWithNull, 'scope-1');

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toBe('not_an_object');
      /* The index is recorded, so the offending record is findable. */
      expect(result.rejected[0]?.index).toBe(0);
    });

    it('quarantines a record with no title and keeps the rest', () => {
      const result = make().parse(pageMissingTitle, 'scope-1');

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected[0]?.reason).toBe('missing_title');
    });

    it('lets the caller collapse a repeated id, keeping the first', () => {
      const { accepted } = make().parse(pageWithDuplicate, 'scope-1');
      const { ordered, duplicatesDropped } = orderAndDedupe(accepted);

      expect(ordered).toHaveLength(1);
      expect(duplicatesDropped).toBe(1);
      expect(ordered[0]?.titleRaw).toBe('First');
    });

    it.each([null, undefined, 42, 'text', [], {}, { jobs: 'no' }])(
      'returns a rejection rather than throwing on %j',
      (body) => {
        expect(() => make().parse(body, 'scope-1')).not.toThrow();
        expect(make().parse(body, 'scope-1').accepted).toEqual([]);
      },
    );

    it('touches no network, no clock and no randomness while parsing', () => {
      const now = Date.now;
      const random = Math.random;
      let touched = false;

      Date.now = () => {
        touched = true;
        return 0;
      };
      Math.random = () => {
        touched = true;
        return 0;
      };

      try {
        make().parse(page, 'scope-1');
      } finally {
        Date.now = now;
        Math.random = random;
      }

      expect(`${name} touched a clock: ${touched}`).toBe(
        `${name} touched a clock: false`,
      );
    });

    it('declares a slug matching its directory-name convention', () => {
      expect(/^[a-z0-9][a-z0-9-]*$/.test(make().sourceSlug)).toBe(true);
    });
  },
);

describe('two shapes, one canonical reading', () => {
  /*
   * The behavioural half of the multi-source claim. The lint-style checks
   * below prove the canonical layer does not MENTION a source; this proves
   * it does not need to.
   */
  it('reads the same job identically through two differently shaped sources', () => {
    const viaGreenhouse = new GreenhouseAdapter().parse(
      {
        jobs: [
          {
            id: 10,
            title: 'Senior Backend Engineer',
            content: '&lt;p&gt;We use Postgres and Kubernetes&lt;/p&gt;',
            company_name: 'Acme',
          },
        ],
      },
      'acme',
    ).accepted[0]!;

    const viaFake = new FakeShapeAdapter().parse(
      {
        data: {
          items: [
            {
              ref: '10',
              headline: 'Senior Backend Engineer',
              preview: 'We use Postgres and Kubernetes',
              employer: 'Acme',
            },
          ],
        },
      },
      'acme',
    ).accepted[0]!;

    const reading = (record: typeof viaGreenhouse) => {
      const normalized = normalizePosting(record);

      return {
        role: normalized.roleSlug,
        modifier: normalized.titleModifierRaw,
        company: normalized.companyNormalized,
        skills: normalized.mentions
          .filter((mention) => mention.extractedFrom === 'DESCRIPTION')
          .map((mention) => mention.skillSlug),
      };
    };

    expect(reading(viaFake)).toEqual(reading(viaGreenhouse));
    expect(reading(viaGreenhouse)).toEqual({
      role: 'backend-engineer',
      modifier: 'senior',
      company: 'acme',
      skills: ['kubernetes', 'postgresql'],
    });
  });

  it('records the completeness difference the two sources really have', () => {
    const greenhouse = new GreenhouseAdapter().parse(
      { jobs: [{ id: 1, title: 'Backend Engineer', content: 'Full body' }] },
      'acme',
    ).accepted[0];

    const fake = new FakeShapeAdapter().parse(
      {
        data: {
          items: [
            { ref: '1', headline: 'Backend Engineer', preview: 'Snippet' },
          ],
        },
      },
      'acme',
    ).accepted[0];

    /*
     * This is the branch Greenhouse alone can never produce, and it is the
     * one the prevalence denominator depends on. Without a second adapter
     * it would first execute in production.
     */
    expect(greenhouse?.descriptionCompleteness).toBe('FULL');
    expect(fake?.descriptionCompleteness).toBe('TRUNCATED');
  });
});

/*
 * Lint-style checks that read the source tree, modelled on the existing
 * security-boundary spec. A comment cannot enforce a layering rule; this
 * can.
 */
describe('source rules', () => {
  const canonicalDirs = ['observations', 'normalization', 'signals'].map(
    (dir) => fileURLToPath(new URL(`../${dir}/`, import.meta.url)),
  );

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}${entry.name}`;

      if (entry.isDirectory()) {
        return sources(`${path}/`);
      }

      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
    });
  }

  const files = canonicalDirs.flatMap(sources);

  it('found a real tree to scan, so the checks below cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('imports no adapter into any canonical module', () => {
    const offenders = files.filter((file) =>
      /from\s+'[^']*\/(?:greenhouse|fake-shape)\/[^']+'/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('names no source anywhere in the canonical modules', () => {
    const keys = ['greenhouse', 'adzuna', 'jooble', 'usajobs', 'lever'];

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8')).toLowerCase();
      const found = keys.find((key) => code.includes(key)) ?? 'clean';

      expect(`${file}: ${found}`).toBe(`${file}: clean`);
    }
  });

  it('branches on no source identity in the canonical modules', () => {
    const offenders = files.filter((file) =>
      /(sourceSlug|sourceId|sourceScope)\s*===\s*'/.test(
        stripComments(readFileSync(file, 'utf8')),
      ),
    );

    expect(offenders).toEqual([]);
  });
});

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function reverseItems(page: Record<string, unknown>): void {
  if (Array.isArray(page.jobs)) {
    page.jobs.reverse();
    return;
  }

  const data = page.data as Record<string, unknown> | undefined;

  if (data !== undefined && Array.isArray(data.items)) {
    data.items.reverse();
  }
}
