import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  orderingFingerprint,
} from './search-cursor.js';

/*
 * Pagination that cannot skip and cannot repeat.
 *
 * The failure a cursor exists to prevent is silent: with OFFSET, a
 * projection rebuild between page 1 and page 2 drops results the reader
 * never sees and repeats ones they already did, and nothing in either
 * response indicates it happened. So every property below is about a
 * failure being LOUD.
 */

const FINGERPRINT = orderingFingerprint({ q: 'software engineer' });

const POSITION = {
  relevance: 1290,
  publishedAtMs: Date.UTC(2026, 8, 1),
  externalId: 'market:jobtech:SOURCE_ID:1:data-it/29184756',
};

describe('a cursor round-trips exactly', () => {
  it('returns the position it was given', () => {
    expect(
      decodeCursor(encodeCursor(POSITION, FINGERPRINT), FINGERPRINT),
    ).toEqual(POSITION);
  });

  it('survives an external id containing the separator characters', () => {
    /*
     * An externalId is `market:<slug>:<basis>:<version>:<scope>/<key>`,
     * so it carries both a colon and a slash. Encoding it separately is
     * what stops it colliding with the cursor's own separator - and this
     * is the test that would have caught doing it by escaping instead.
     */
    const awkward = {
      ...POSITION,
      externalId: 'market:a:SOURCE_ID:1:with|pipe/and:colons',
    };

    expect(
      decodeCursor(encodeCursor(awkward, FINGERPRINT), FINGERPRINT),
    ).toEqual(awkward);
  });

  it('carries a null publication date without turning it into a number', () => {
    const undated = { ...POSITION, publishedAtMs: null };

    expect(
      decodeCursor(encodeCursor(undated, FINGERPRINT), FINGERPRINT),
    ).toEqual(undated);
  });

  it('is URL-safe, so it survives a query string unescaped', () => {
    expect(encodeCursor(POSITION, FINGERPRINT)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('a cursor is refused rather than misread', () => {
  it('refuses one issued for a different query', () => {
    const other = orderingFingerprint({ q: 'nurse' });

    expect(() =>
      decodeCursor(encodeCursor(POSITION, FINGERPRINT), other),
    ).toThrow(InvalidCursorError);
  });

  /*
   * The heart of it. A cursor from one search replayed against another
   * would resume from a position that means nothing in the second
   * ordering - returning a page that is neither correct nor detectably
   * wrong. Every ingredient of the ordering is therefore in the
   * fingerprint, and each of these must produce a different one.
   */
  it.each([
    ['the query text', { q: 'a' }, { q: 'b' }],
    ['the sort', { q: 'a', sort: 'relevance' }, { q: 'a', sort: 'published' }],
    ['the day', { q: 'a', day: '2026-09-09' }, { q: 'a', day: '2026-09-10' }],
    ['the filters', { q: 'a', role: null }, { q: 'a', role: 'cook' }],
    [
      'the source list',
      { q: 'a', sources: ['jobtech'] },
      { q: 'a', sources: ['jobicy'] },
    ],
  ])('changes the fingerprint when %s changes', (_label, left, right) => {
    expect(orderingFingerprint(left)).not.toBe(orderingFingerprint(right));
  });

  it('gives the same fingerprint for the same inputs', () => {
    expect(orderingFingerprint({ q: 'a', sources: ['x', 'y'] })).toBe(
      orderingFingerprint({ q: 'a', sources: ['x', 'y'] }),
    );
  });

  it.each([
    ['not base64url at all', '!!!!'],
    ['the wrong number of fields', Buffer.from('1|abc').toString('base64url')],
    ['an unknown version', Buffer.from('9|abc|1|1|aa').toString('base64url')],
    [
      'a non-integer position',
      Buffer.from(`1|${FINGERPRINT}|nope|1|aa`).toString('base64url'),
    ],
    [
      'an empty external id',
      Buffer.from(`1|${FINGERPRINT}|1|1|`).toString('base64url'),
    ],
  ])('refuses a cursor that is %s', (_label, encoded) => {
    expect(() => decodeCursor(encoded, FINGERPRINT)).toThrow(
      InvalidCursorError,
    );
  });

  /*
   * Never a silent fallback to page one. The caller believes it is on
   * page 4 and is served page 1, so the list appears to loop and nothing
   * in the response says why.
   */
  it('throws rather than returning a default position', () => {
    let returned: unknown = 'not thrown';

    try {
      returned = decodeCursor('!!!!', FINGERPRINT);
    } catch (error) {
      returned = error;
    }

    expect(returned).toBeInstanceOf(InvalidCursorError);
  });
});
