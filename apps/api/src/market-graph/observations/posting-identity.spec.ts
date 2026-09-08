import { describe, expect, it } from 'vitest';

import type { RawPostingRecord } from '../sources/source-adapter.js';
import {
  comparePostings,
  orderAndDedupe,
  postingContentHash,
  postingExternalId,
  rawPayloadHash,
} from './posting-identity.js';

function record(over: Partial<RawPostingRecord> = {}): RawPostingRecord {
  return {
    externalKey: '4012345',
    sourceScope: 'acme',
    titleRaw: 'Backend Engineer',
    companyRaw: 'Acme',
    locationRaw: 'Remote',
    descriptionRaw: '<p>Body</p>',
    descriptionCompleteness: 'FULL',
    sourcePublishedAt: '2026-08-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
    sourceValidThrough: null,
    applyUrlRaw: 'https://example.invalid/1',
    sourceCategoriesRaw: ['Engineering'],
    externalGroupKey: '99',
    payload: { id: 4012345, title: 'Backend Engineer' },
    ...over,
  };
}

describe('posting identity', () => {
  it('is scoped by source and sub-scope, and carries its derivation version', () => {
    expect(
      postingExternalId({
        sourceSlug: 'greenhouse',
        identityBasis: 'SOURCE_ID',
        sourceScope: 'acme',
        externalKey: '4012345',
      }),
    ).toBe('market:greenhouse:sid:1:acme/4012345');
  });

  /*
   * The same numeric id on two different boards is two different jobs.
   * Without the scope in the key they would collapse into one row and one
   * of the two employers would silently vanish from every count.
   */
  it('does not collide when two scopes reuse one id', () => {
    const left = postingExternalId({
      sourceSlug: 'greenhouse',
      identityBasis: 'SOURCE_ID',
      sourceScope: 'acme',
      externalKey: '1',
    });
    const right = postingExternalId({
      sourceSlug: 'greenhouse',
      identityBasis: 'SOURCE_ID',
      sourceScope: 'globex',
      externalKey: '1',
    });

    expect(left).not.toBe(right);
  });

  it('distinguishes identities derived on different bases', () => {
    const byId = postingExternalId({
      sourceSlug: 's',
      identityBasis: 'SOURCE_ID',
      sourceScope: 'a',
      externalKey: 'k',
    });
    const byFingerprint = postingExternalId({
      sourceSlug: 's',
      identityBasis: 'CONTENT_FINGERPRINT',
      sourceScope: 'a',
      externalKey: 'k',
    });

    expect(byId).not.toBe(byFingerprint);
  });
});

describe('content hash', () => {
  it('is identical for two structurally identical records', () => {
    expect(postingContentHash(record())).toBe(postingContentHash(record()));
  });

  it.each([
    ['title', { titleRaw: 'Frontend Engineer' }],
    ['description', { descriptionRaw: '<p>Different</p>' }],
    ['location', { locationRaw: 'London' }],
    ['company', { companyRaw: 'Globex' }],
    ['apply url', { applyUrlRaw: 'https://example.invalid/2' }],
    ['completeness', { descriptionCompleteness: 'TRUNCATED' as const }],
    ['categories', { sourceCategoriesRaw: ['Sales'] }],
    ['published date', { sourcePublishedAt: '2026-01-01T00:00:00.000Z' }],
  ])('changes when the %s changes', (_label, over) => {
    expect(postingContentHash(record(over))).not.toBe(
      postingContentHash(record()),
    );
  });

  /*
   * The load-bearing exclusion.
   *
   * An ATS bumps updated_at when a recruiter touches a requisition, with
   * the advertised text byte-identical. If that minted a version, nightly
   * HRIS syncs would produce one full-description row per posting per day
   * and the three-table split would degenerate into one row per fetch.
   */
  it('does not change when only the source says it was updated', () => {
    expect(
      postingContentHash(
        record({ sourceUpdatedAt: '2026-09-08T23:59:59.000Z' }),
      ),
    ).toBe(postingContentHash(record()));
  });

  /*
   * The other load-bearing exclusion. Greenhouse returns `education` on
   * some boards and not others, so hashing the payload would mint a new
   * version for every posting on a board the day the vendor adds a field -
   * recording an API change as a market event.
   */
  it('does not change when the source adds a field to its payload', () => {
    const widened = record({
      payload: { id: 4012345, title: 'Backend Engineer', education: [] },
    });

    expect(postingContentHash(widened)).toBe(postingContentHash(record()));
    /* Drift is still recorded, just not as a new version. */
    expect(rawPayloadHash(widened)).not.toBe(rawPayloadHash(record()));
  });

  it('does not change when the payload only reorders its keys', () => {
    const reordered = record({
      payload: { title: 'Backend Engineer', id: 4012345 },
    });

    expect(rawPayloadHash(reordered)).toBe(rawPayloadHash(record()));
  });
});

describe('ordering and dedupe', () => {
  const a = record({ externalKey: '1' });
  const b = record({ externalKey: '2' });
  const c = record({ externalKey: '3' });

  it('imposes its own order rather than trusting the response', () => {
    const { ordered } = orderAndDedupe([c, a, b]);

    expect(ordered.map((entry) => entry.externalKey)).toEqual(['1', '2', '3']);
  });

  /*
   * Reversed rather than shuffled, deliberately: a shuffle that happens to
   * be the identity permutation passes a broken implementation, and the
   * failure is not reproducible when it does not.
   */
  it('produces the same order from a reversed response', () => {
    const forward = orderAndDedupe([a, b, c]).ordered;
    const reversed = orderAndDedupe([c, b, a]).ordered;

    expect(reversed.map(postingContentHash)).toEqual(
      forward.map(postingContentHash),
    );
  });

  it('keeps the first occurrence when a response repeats a posting', () => {
    const first = record({ externalKey: '1', titleRaw: 'First' });
    const second = record({ externalKey: '1', titleRaw: 'Second' });

    const { ordered, duplicatesDropped } = orderAndDedupe([first, second]);

    expect(ordered).toHaveLength(1);
    expect(duplicatesDropped).toBe(1);
    /*
     * First and not last, so the result does not depend on how far through
     * a walk the repeat appeared.
     */
    expect(ordered[0]?.titleRaw).toBe('First');
  });

  it('does not merge one id across two scopes', () => {
    const { ordered, duplicatesDropped } = orderAndDedupe([
      record({ externalKey: '1', sourceScope: 'acme' }),
      record({ externalKey: '1', sourceScope: 'globex' }),
    ]);

    expect(ordered).toHaveLength(2);
    expect(duplicatesDropped).toBe(0);
  });

  it('has a total comparator, so no two distinct postings ever tie', () => {
    expect(comparePostings(a, b)).toBeLessThan(0);
    expect(comparePostings(b, a)).toBeGreaterThan(0);
    expect(comparePostings(a, a)).toBe(0);
  });
});
