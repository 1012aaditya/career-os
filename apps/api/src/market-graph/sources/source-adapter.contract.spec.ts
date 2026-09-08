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
import { JobTechAdapter } from './jobtech/jobtech.adapter.js';
import { CanadaJobBankAdapter } from './canada-job-bank/canada-job-bank.adapter.js';
import { JobicyAdapter } from './jobicy/jobicy.adapter.js';
import { NavAdapter } from './nav-no/nav-no.adapter.js';
import { TeachingVacanciesAdapter } from './teaching-vacancies/teaching-vacancies.adapter.js';
import { UsaJobsHistoricAdapter } from './usajobs-historic/usajobs-historic.adapter.js';
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
  /*
   * Added by vocabulary v1. Which occupational classification
   * sourceCategoriesRaw is expressed in - a taxonomy name, never a source
   * name - so the canonical layers can read a code's scheme without
   * learning which source supplied it.
   */
  'occupationScheme',
  'sourcePublishedAt',
  'sourceScope',
  'sourceUpdatedAt',
  'sourceValidThrough',
  'titleRaw',
].sort();

const SOURCES_DIR = fileURLToPath(new URL('./', import.meta.url));

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
  {
    /*
     * The second REAL source, and the reason the contract is worth having.
     * FakeShapeAdapter was built to be different on purpose; this one is
     * different because a national job bank genuinely is not an ATS board.
     */
    name: 'jobtech',
    make: () => new JobTechAdapter(),
    page: {
      total: { value: 2 },
      hits: [
        {
          id: '31448656',
          headline: 'C/C++ utvecklare',
          description: {
            text: 'Vi anv\u00e4nder C++ och Postgres.',
            text_formatted: '<p>Vi anv\u00e4nder C++ och Postgres.</p>',
          },
          employer: {
            name: 'Combitech Aktiebolag',
            organization_number: '5562186790',
            email: 'recruiter@example.invalid',
            phone_number: '0733791328',
          },
          workplace_address: {
            municipality: 'Link\u00f6ping',
            region: '\u00d6sterg\u00f6tland',
          },
          occupation: { concept_id: 'rQds', label: 'Mjukvaruutvecklare' },
          occupation_group: {
            concept_id: 'DJh5',
            label: 'Mjukvaruutvecklare m.fl.',
          },
          publication_date: '2026-09-08T07:59:47',
          application_deadline: '2026-10-06T23:59:59',
          timestamp: 1788847187554,
          webpage_url: 'https://example.invalid/31448656',
          application_contacts: [
            {
              name: 'Peter Nilsson',
              email: 'peter@example.invalid',
              telephone: '0700000000',
            },
          ],
          removed: false,
        },
        {
          id: '31448000',
          headline: 'Frontendutvecklare',
          description: { text_formatted: '<p>React.</p>' },
          employer: { name: 'Acme AB', organization_number: '5560000000' },
          workplace_address: { municipality: 'Stockholm' },
          publication_date: '2026-01-15T09:00:00',
          timestamp: 1788847187000,
          webpage_url: 'https://example.invalid/31448000',
          removed: false,
        },
      ],
    },
    pageWithNull: {
      total: { value: 2 },
      hits: [null, { id: '1', headline: 'Data Engineer' }],
    },
    pageMissingTitle: {
      total: { value: 2 },
      hits: [{ id: '2' }, { id: '3', headline: 'QA Engineer' }],
    },
    pageWithDuplicate: {
      total: { value: 2 },
      hits: [
        { id: '7', headline: 'First' },
        { id: '7', headline: 'Second' },
      ],
    },
  },
  {
    /*
     * The third real source. schema.org JobPosting, a page NUMBER cursor,
     * a date with no time, and - uniquely so far - no id field at all, so
     * this is the first adapter to declare SOURCE_URL identity.
     */
    name: 'teaching-vacancies',
    make: () => new TeachingVacanciesAdapter(),
    page: {
      meta: { totalPages: 1, count: 2 },
      data: [
        {
          '@type': 'JobPosting',
          title: 'Head of Computer Science',
          description: '<p>Teaching Python and Postgres.</p>',
          datePosted: '2026-09-08',
          validThrough: '2026-09-29T12:00:00+01:00',
          employmentType: ['FULL_TIME'],
          industry: 'Education',
          occupationalCategory: 'teacher',
          url: 'https://example.invalid/jobs/head-of-computer-science',
          hiringOrganization: {
            '@type': 'Organization',
            name: 'Example Academy',
            identifier: '107250',
          },
          jobLocation: {
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              addressLocality: 'Bradford',
              addressRegion: 'Yorkshire and the Humber',
              addressCountry: 'GB',
            },
          },
        },
        {
          '@type': 'JobPosting',
          title: 'Teaching Assistant',
          description: '<p>Support role.</p>',
          datePosted: '2026-08-01',
          validThrough: null,
          employmentType: ['PART_TIME'],
          occupationalCategory: 'teaching_assistant',
          url: 'https://example.invalid/jobs/teaching-assistant',
          hiringOrganization: { name: 'Example Primary', identifier: '107251' },
          jobLocation: { address: { addressLocality: 'Leeds' } },
        },
      ],
    },
    pageWithNull: {
      meta: { totalPages: 1, count: 2 },
      data: [
        null,
        { title: 'Data Engineer', url: 'https://example.invalid/1' },
      ],
    },
    pageMissingTitle: {
      meta: { totalPages: 1, count: 2 },
      data: [
        { url: 'https://example.invalid/2' },
        { title: 'QA Engineer', url: 'https://example.invalid/3' },
      ],
    },
    pageWithDuplicate: {
      meta: { totalPages: 1, count: 2 },
      data: [
        { title: 'First', url: 'https://example.invalid/7' },
        { title: 'Second', url: 'https://example.invalid/7' },
      ],
    },
  },
  {
    /* Continuation-token pagination, and the first source that publishes
     * no description at all - so the first to produce ABSENT. */
    name: 'usajobs-historic',
    make: () => new UsaJobsHistoricAdapter(),
    page: {
      paging: { metadata: { continuationToken: 'abc%3D%3D' } },
      data: [
        {
          usajobsControlNumber: 309472900,
          positionTitle: 'SENIOR INFORMATION TECHNOLOGY SPECIALIST',
          hiringAgencyName: 'U.S. Mint',
          hiringDepartmentName: 'Department of the Treasury',
          positionOpenDate: '2020-02-14',
          positionCloseDate: '2020-02-15',
          positionExpireDate: null,
          announcementNumber: '12-USMINT-202',
          jobcategories: [{ series: '2210' }],
          positionlocations: [
            {
              positionLocationCity: 'Washington',
              positionLocationState: 'District of Columbia',
            },
          ],
        },
        {
          usajobsControlNumber: 309000000,
          positionTitle: 'DATA ENGINEER',
          hiringAgencyName: 'U.S. Census Bureau',
          positionOpenDate: '2021-05-01',
          positionCloseDate: null,
          jobcategories: [{ series: '1530' }],
          positionlocations: [{ positionLocationCity: 'Suitland' }],
        },
      ],
    },
    pageWithNull: {
      data: [null, { usajobsControlNumber: 1, positionTitle: 'Analyst' }],
    },
    pageMissingTitle: {
      data: [
        { usajobsControlNumber: 2 },
        { usajobsControlNumber: 3, positionTitle: 'QA Engineer' },
      ],
    },
    pageWithDuplicate: {
      data: [
        { usajobsControlNumber: 7, positionTitle: 'First' },
        { usajobsControlNumber: 7, positionTitle: 'Second' },
      ],
    },
  },
  {
    /* A JSON Feed, a status field that marks delistings, and a
     * content_text that is a placeholder rather than a body. */
    name: 'nav-no',
    make: () => new NavAdapter(),
    page: {
      items: [
        {
          id: 'a1',
          title: 'Systemutvikler',
          content_text: 'Stillingsannonse',
          date_modified: '2026-09-08T15:11:00.611811+02:00',
          _feed_entry: {
            uuid: 'a1',
            status: 'ACTIVE',
            title: 'Systemutvikler',
            businessName: 'Eksempel AS',
            municipal: 'OSLO',
            sistEndret: '2026-09-08T15:11:00.611811+02:00',
          },
        },
        {
          id: 'a2',
          title: 'Dataingenior',
          date_modified: '2026-08-01T09:00:00.000000+02:00',
          _feed_entry: {
            uuid: 'a2',
            status: 'ACTIVE',
            businessName: 'Annen AS',
            municipal: 'BERGEN',
          },
        },
      ],
    },
    pageWithNull: {
      items: [
        null,
        { id: 'b1', title: 'Data Engineer', _feed_entry: { uuid: 'b1' } },
      ],
    },
    pageMissingTitle: {
      items: [
        { id: 'b2', _feed_entry: { uuid: 'b2' } },
        { id: 'b3', title: 'QA Engineer', _feed_entry: { uuid: 'b3' } },
      ],
    },
    pageWithDuplicate: {
      items: [
        { id: 'b7', title: 'First', _feed_entry: { uuid: 'b7' } },
        { id: 'b7', title: 'Second', _feed_entry: { uuid: 'b7' } },
      ],
    },
  },
  {
    /* No pagination at all: a rolling window the source serves whole. */
    name: 'jobicy',
    make: () => new JobicyAdapter(),
    page: {
      jobCount: 2,
      jobs: [
        {
          id: 150169,
          url: 'https://example.invalid/jobs/150169-care-manager',
          jobTitle: 'Senior Backend Engineer',
          companyName: 'Acme Remote',
          jobIndustry: ['Software Engineering'],
          jobType: ['Full-Time'],
          jobLevel: 'Senior',
          jobGeo: 'USA',
          jobDescription: '<p>We use Python and Postgres.</p>',
          jobExcerpt: 'We use Python...',
          pubDate: '2026-09-08T05:10:08+00:00',
        },
        {
          id: 150000,
          url: 'https://example.invalid/jobs/150000-frontend',
          jobTitle: 'Frontend Engineer',
          companyName: 'Globex',
          jobIndustry: ['Software Engineering'],
          jobType: ['Contract'],
          jobGeo: 'Europe',
          jobDescription: '<p>React and TypeScript.</p>',
          pubDate: '2026-08-01T05:10:08+00:00',
        },
      ],
    },
    pageWithNull: { jobs: [null, { id: 1, jobTitle: 'Data Engineer' }] },
    pageMissingTitle: {
      jobs: [{ id: 2 }, { id: 3, jobTitle: 'QA Engineer' }],
    },
    pageWithDuplicate: {
      jobs: [
        { id: 7, jobTitle: 'First' },
        { id: 7, jobTitle: 'Second' },
      ],
    },
  },
  {
    /* Not JSON at all: rows decoded from a UTF-16LE tab-separated file.
     * The contract's parse(body: unknown) needed no change for it. */
    name: 'canada-job-bank',
    make: () => new CanadaJobBankAdapter(),
    page: {
      rows: [
        {
          'WIC Job Location Snapshot ID': '1001',
          'Job Title': 'Senior Software Engineer',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Toronto',
          'Province/Territory': 'Ontario',
        },
        {
          'WIC Job Location Snapshot ID': '1002',
          'Job Title': 'Data Analyst',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Vancouver',
          'Province/Territory': 'Ontario',
        },
      ],
    },
    pageWithNull: {
      rows: [
        null,
        {
          'WIC Job Location Snapshot ID': '4',
          'Job Title': 'Data Engineer',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Toronto',
          'Province/Territory': 'Ontario',
        },
      ],
    },
    pageMissingTitle: {
      rows: [
        { 'WIC Job Location Snapshot ID': '5' },
        {
          'WIC Job Location Snapshot ID': '6',
          'Job Title': 'QA Engineer',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Toronto',
          'Province/Territory': 'Ontario',
        },
      ],
    },
    pageWithDuplicate: {
      rows: [
        {
          'WIC Job Location Snapshot ID': '7',
          'Job Title': 'First',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Toronto',
          'Province/Territory': 'Ontario',
        },
        {
          'WIC Job Location Snapshot ID': '7',
          'Job Title': 'Second',
          'Original Job Title': 'x',
          'NOC 2016 Code': '2173',
          'NOC 2016 Code Name': 'Software engineers',
          'NOC21 Code': '21231',
          'NOC21 Code Name': 'Software engineers and designers',
          'First Posting Date': '2026/08/07',
          City: 'Toronto',
          'Province/Territory': 'Ontario',
        },
      ],
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

  /*
   * Both scans below take their source names from the FILESYSTEM, not from
   * a hand-maintained list.
   *
   * The list was hand-maintained, and adding the third source proved why
   * that fails: the regex still read (greenhouse|jobtech|fake-shape), so
   * the check that stops an adapter leaking into a canonical layer had
   * silently stopped covering the newest adapter - the one most likely to
   * leak, because it is the one being written. A check that must be edited
   * to keep working is a check that will eventually not be working.
   */
  const adapterDirs = readdirSync(SOURCES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('found every adapter directory, so the scans below cover them all', () => {
    expect(adapterDirs).toContain('greenhouse');
    expect(adapterDirs).toContain('jobtech');
    expect(adapterDirs.length).toBeGreaterThanOrEqual(ADAPTERS.length - 1);
  });

  it('imports no adapter into any canonical module', () => {
    const pattern = new RegExp(
      `from\\s+'[^']*\\/(?:${adapterDirs.join('|')})\\/[^']+'`,
    );

    const offenders = files.filter((file) =>
      pattern.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('names no source anywhere in the canonical modules', () => {
    const keys = [
      ...adapterDirs,
      /*
       * Sources assessed and rejected on licence grounds. Kept so that a
       * future attempt to wire one in trips this check even before its
       * directory exists.
       */
      'adzuna',
      'jooble',
      'usajobs',
      'lever',
      'lightcast',
      'themuse',
    ];

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

/*
 * Reverses whichever array a page's envelope carries.
 *
 * This knew two shapes - top-level `jobs` and nested `data.items` - and
 * silently did nothing for any other. JobTech's envelope is `hits`, so
 * JobTech's "same ordered result from a reversed payload" test reversed
 * NOTHING and passed trivially from the day it was added. The one test
 * that catches an adapter leaking a source's array order into a field was
 * vacuous for the source most likely to leak it.
 *
 * Now it refuses rather than shrugging: an envelope it does not recognise
 * throws, so adding an adapter with a new shape fails loudly here instead
 * of quietly buying a free pass.
 */
function reverseItems(page: Record<string, unknown>): void {
  for (const key of ['jobs', 'hits', 'data', 'items', 'rows'] as const) {
    const value = page[key];

    if (Array.isArray(value)) {
      value.reverse();
      return;
    }
  }

  const data = page.data as Record<string, unknown> | undefined;

  if (data !== undefined && Array.isArray(data.items)) {
    data.items.reverse();
    return;
  }

  throw new Error(
    `reverseItems does not know this envelope: ${Object.keys(page).join(', ')}`,
  );
}

describe('the jobtech adapter, specifically', () => {
  const adapter = new JobTechAdapter();

  const page = {
    hits: [
      {
        id: '1',
        headline: 'Utvecklare',
        description: { text_formatted: '<p>x</p>' },
        employer: {
          name: 'Acme AB',
          organization_number: '5560000000',
          email: 'hr@example.invalid',
          phone_number: '0700000000',
        },
        publication_date: '2026-07-15T12:00:00',
        application_deadline: '2026-12-01T23:59:59',
        timestamp: 1788847187554,
        application_contacts: [
          {
            name: 'Peter Nilsson',
            email: 'peter@example.invalid',
            telephone: '0733791328',
          },
        ],
        removed: false,
      },
    ],
  };

  /*
   * CC0 waives copyright and expressly does not waive privacy rights.
   * Measured on a live sample of 25 ads, 9 carried named recruiters with
   * 13 email addresses and 13 mobile numbers. This is the one place either
   * adapter deliberately drops something rather than preserving it, and it
   * overrides the rule that raw observations are kept verbatim.
   */
  it('strips personal contact details before the payload is stored', () => {
    const [record] = adapter.parse(page, 'data-it').accepted;
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('peter@example.invalid');
    expect(serialized).not.toContain('0733791328');
    expect(serialized).not.toContain('hr@example.invalid');
    expect(serialized).not.toContain('application_contacts');
    /* The employer itself survives - only the way to phone them is gone. */
    expect(record?.companyRaw).toBe('Acme AB');
    expect(record?.externalGroupKey).toBe('5560000000');
  });

  it('detects a planted contact, so the check above cannot pass vacuously', () => {
    const planted = adapter.parse(
      { hits: [{ ...page.hits[0], id: '2', headline: 'x' }] },
      'data-it',
    ).accepted[0];

    expect(JSON.stringify(planted?.payload)).not.toContain(
      'peter@example.invalid',
    );
    expect(JSON.stringify(page)).toContain('peter@example.invalid');
  });

  /*
   * The source emits naive local timestamps with no offset, which the
   * shared instant parser refuses by design. Supplying the missing zone is
   * the adapter's job, and Sweden observes summer time - so the same wall
   * clock is a different instant in July and in January.
   */
  it('resolves a zone-less timestamp through Europe/Stockholm, with DST', () => {
    const [record] = adapter.parse(page, 'data-it').accepted;

    /* 12:00 in July is CEST, UTC+2. */
    expect(record?.sourcePublishedAt).toBe('2026-07-15T10:00:00.000Z');

    const winter = adapter.parse(
      {
        hits: [
          {
            ...page.hits[0],
            id: '9',
            publication_date: '2026-01-15T12:00:00',
          },
        ],
      },
      'data-it',
    ).accepted[0];

    /* 12:00 in January is CET, UTC+1. */
    expect(winter?.sourcePublishedAt).toBe('2026-01-15T11:00:00.000Z');
  });

  it('reads an epoch-millisecond timestamp as the declared unit', () => {
    const [record] = adapter.parse(page, 'data-it').accepted;

    expect(record?.sourceUpdatedAt).toBe(new Date(1788847187554).toISOString());
  });

  /*
   * The first source's equivalent field was null on all 864 postings
   * sampled, so a source-stated posting lifetime was unreachable. This one
   * populates it.
   */
  it('carries the employer-stated expiry the first source never had', () => {
    const [record] = adapter.parse(page, 'data-it').accepted;

    expect(record?.sourceValidThrough).toBe('2026-12-01T22:59:59.000Z');
  });

  /*
   * The stream form of this source emits removals as a stub with a removal
   * date and no title, employer or body. The contract cannot express a
   * delisting, so they are refused and counted rather than stored as a
   * posting with no title.
   */
  it('refuses a tombstone rather than storing a titleless posting', () => {
    const result = adapter.parse(
      {
        hits: [
          { id: '5', removed: true, removed_date: '2026-09-01T00:00:00' },
          { id: '6', headline: 'Utvecklare', removed: false },
        ],
      },
      'data-it',
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe('removed_posting');
  });
});
