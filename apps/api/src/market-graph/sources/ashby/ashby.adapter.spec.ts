import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../common/canonical-json.js';
import { redactRecord } from '../../observations/redaction.js';
import { AshbyAdapter } from './ashby.adapter.js';

/*
 * The Ashby adapter, against the shape the live API really returns.
 *
 * The FIXTURE is synthetic and the SHAPE is not. Every key, the envelope,
 * the timestamp format and the two rejection cases below were read off a
 * live response on 2026-09-09 (70 postings, apiVersion 1); the values are
 * invented, because committing a real board's bodies would put a named
 * hiring manager and their personal LinkedIn URL into this repository -
 * which is precisely the material the redaction test below exists to
 * remove from the database.
 */

const adapter = new AshbyAdapter();

/*
 * One posting carrying every field the live sample carried, including the
 * two that make this source structurally different from the other ATS: a
 * uuid id, and no employer field anywhere.
 */
const page = {
  apiVersion: 1,
  jobs: [
    {
      id: '7458d4e9-da2e-47bd-98cb-adfda43d42b2',
      title: 'Engineering Manager - EU',
      department: 'Engineering',
      team: 'EMEA Engineering',
      employmentType: 'FullTime',
      location: 'Remote - European Union',
      shouldDisplayCompensationOnJobPostings: true,
      secondaryLocations: [
        { location: 'Berlin', address: { postalAddress: { addressCountry: 'Germany' } } },
        { location: 'Madrid', address: { postalAddress: { addressCountry: 'Spain' } } },
      ],
      publishedAt: '2026-03-04T14:29:08.532+00:00',
      isListed: true,
      isRemote: true,
      workplaceType: 'Remote',
      address: { postalAddress: { addressCountry: 'European Union' } },
      jobUrl: 'https://example.invalid/acme/7458d4e9',
      applyUrl: 'https://example.invalid/acme/7458d4e9/application',
      descriptionHtml:
        '<p>Hi, I am Alex. Reach me at alex.doe@example.invalid or +46 70 123 45 67. We use Postgres and Kubernetes.</p>',
      descriptionPlain:
        'Hi, I am Alex. Reach me at alex.doe@example.invalid or +46 70 123 45 67. We use Postgres and Kubernetes.',
      compensation: { compensationTierSummary: 'EUR110K - EUR185K' },
    },
  ],
};

describe('the ashby adapter', () => {
  it('reads a uuid key that the numeric validator would have refused', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.externalKey).toBe('7458d4e9-da2e-47bd-98cb-adfda43d42b2');
    expect(Number.isNaN(Number(record?.externalKey))).toBe(true);
  });

  /*
   * The source publishes no company. This is the decision that fills the
   * gap, and it is worth a test because it is the one place this adapter
   * puts something in a field the record did not contain: the board token
   * is the employer's own identifier on this source, and the alternative -
   * null - would show a job with no employer at all and put every Ashby
   * posting below the distinct-employer floor.
   */
  it('takes the employer from the board token, because the payload has none', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.companyRaw).toBe('acme');
    expect(JSON.stringify(page)).not.toContain('"companyName"');
  });

  it('reads the offset-bearing publish timestamp as a UTC instant', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.sourcePublishedAt).toBe('2026-03-04T14:29:08.532Z');
  });

  /*
   * The source states neither, and neither is invented. Copying publishedAt
   * into sourceUpdatedAt would assert nothing has ever been edited;
   * copying a retrieval time into either would make imported data look
   * newly published, which is the one thing freshness must never be told.
   */
  it('invents no update time and no expiry', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.sourceUpdatedAt).toBeNull();
    expect(record?.sourceValidThrough).toBeNull();
  });

  it('prefers the application form over the posting page', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.applyUrlRaw).toBe(
      'https://example.invalid/acme/7458d4e9/application',
    );

    const pageOnly = adapter.parse(
      {
        jobs: [
          {
            id: 'x1',
            title: 'Engineer',
            jobUrl: 'https://example.invalid/acme/x1',
          },
        ],
      },
      'acme',
    ).accepted[0];

    expect(pageOnly?.applyUrlRaw).toBe('https://example.invalid/acme/x1');
  });

  /*
   * `department` and `team` are scalars, so there is no provider array
   * order to inherit - but a board that sets them equal would otherwise
   * emit the same label twice and hash differently from one that leaves
   * team unset.
   */
  it('orders and de-duplicates its category labels', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.sourceCategoriesRaw).toEqual([
      'EMEA Engineering',
      'Engineering',
    ]);

    const same = adapter.parse(
      {
        jobs: [
          { id: 'y1', title: 'Engineer', department: 'Sales', team: 'Sales' },
        ],
      },
      'acme',
    ).accepted[0];

    expect(same?.sourceCategoriesRaw).toEqual(['Sales']);
  });

  /*
   * An org chart is not a taxonomy. Declaring a scheme for "Engineering"
   * would let the canonical layer treat a department name as an
   * occupational code and resolve thousands of postings from it.
   */
  it('declares no occupational scheme for a company org chart', () => {
    const [record] = adapter.parse(page, 'acme').accepted;

    expect(record?.occupationScheme).toBeNull();
    expect(record?.externalGroupKey).toBeNull();
  });

  /*
   * The employer has taken this off its own board while the API still
   * returns it. Refused and COUNTED - the same refusal the Norwegian
   * adapter makes for INACTIVE entries, and for the same reason: storing
   * it would be storing something the publisher withdrew.
   */
  it('refuses a delisted posting rather than storing a withdrawn one', () => {
    const result = adapter.parse(
      {
        jobs: [
          { id: 'z1', title: 'Withdrawn Role', isListed: false },
          { id: 'z2', title: 'Live Role', isListed: true },
        ],
      },
      'acme',
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.titleRaw).toBe('Live Role');
    expect(result.rejected[0]?.reason).toBe('unlisted_posting');
    expect(result.rejected[0]?.index).toBe(0);
  });

  /*
   * Absent is treated as listed. Every record in the live sample carried
   * the field as true, and inventing a delisting from a missing field
   * would delete real postings on the day the provider drops it.
   */
  it('treats a missing isListed as listed rather than as withdrawn', () => {
    const result = adapter.parse(
      { jobs: [{ id: 'z3', title: 'Live Role' }] },
      'acme',
    );

    expect(result.accepted).toHaveLength(1);
  });

  /*
   * The privacy case this source really has. Ashby boards are written by
   * hiring managers in a rich-text editor rather than generated from a
   * recruiting CMS template, and the live sample opened with a named
   * manager and a personal LinkedIn URL in the first sentence.
   *
   * The adapter declares no structured contact fields because the payload
   * has none - the protection comes from the SHARED pre-persistence
   * sanitizer, which is the point: a partner source passes through exactly
   * the same redaction as every open-data source, and gets it without
   * having to remember to ask.
   */
  it('passes through the shared sanitizer, which removes body contacts', () => {
    const [record] = adapter.parse(page, 'acme').accepted;
    const redacted = redactRecord(record!, adapter.contactRedaction);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('alex.doe@example.invalid');
    expect(serialized).not.toContain('+46 70 123 45 67');
    expect(serialized).toContain('[redacted:email]');
    expect(serialized).toContain('[redacted:phone]');
    /* Both copies of the body, not just the one the record reads. */
    expect(serialized).not.toContain('alex.doe');
    /* The job itself survives. */
    expect(redacted.titleRaw).toBe('Engineering Manager - EU');
    expect(serialized).toContain('Postgres');
  });

  it('detects a planted contact, so the check above cannot pass vacuously', () => {
    expect(JSON.stringify(page)).toContain('alex.doe@example.invalid');
  });

  /*
   * The failure mode a partner feed actually has, and the reason the apply
   * URL lost its exemption from redaction. A per-employer signed apply
   * link would otherwise write a live token into a version row, a search
   * document and an API response.
   */
  it('strips a credential-shaped apply-link parameter before storage', () => {
    const [record] = adapter.parse(
      {
        jobs: [
          {
            id: 'k1',
            title: 'Engineer',
            applyUrl:
              'https://example.invalid/apply?job=k1&auth_token=s3cr3t-live-value&utm_source=board',
          },
        ],
      },
      'acme',
    ).accepted;

    const redacted = redactRecord(record!, adapter.contactRedaction);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('s3cr3t-live-value');
    /* The link still works, and still says a token was there. */
    expect(redacted.applyUrlRaw).toContain('job=k1');
    expect(redacted.applyUrlRaw).toContain('utm_source=board');
    expect(redacted.applyUrlRaw).toContain('auth_token=redacted');
  });

  it('parses the same payload to the same records twice', () => {
    expect(canonicalJson(adapter.parse(page, 'acme'))).toBe(
      canonicalJson(adapter.parse(page, 'acme')),
    );
  });
});
