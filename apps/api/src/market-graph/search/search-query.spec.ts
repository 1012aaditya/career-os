import { describe, expect, it } from 'vitest';

import { ROLE_ALIASES } from '../normalization/ruleset.js';
import {
  parseLocationQuery,
  parseSearchQuery,
  projectLocation,
} from './search-query.js';

/*
 * Query understanding, and above all what it REFUSES to understand.
 *
 * Section 9 names five pairs that must never be equated. They are the
 * whole reason this file exists: a search box is where a system reaches
 * for fuzzy matching, and every one of those pairs is what fuzzy matching
 * does to a job market.
 */

describe('a query is read exactly as a posting title is read', () => {
  it('folds case and whitespace the way a title is folded', () => {
    expect(parseSearchQuery('  Software   ENGINEER ').normalized).toBe(
      parseSearchQuery('software engineer').normalized,
    );
  });

  it('resolves a canonical role through the curated alias table', () => {
    const parsed = parseSearchQuery('backend developer');

    expect(parsed.roleSlug).toBe(ROLE_ALIASES['backend developer']);
    expect(parsed.roleSlug).not.toBeNull();
    expect(parsed.roleResolution).toBe('ALIAS');
  });

  it('says so plainly when a query resolves to no role', () => {
    const parsed = parseSearchQuery('purveyor of fine widgets');

    expect(parsed.roleSlug).toBeNull();
    expect(parsed.roleResolution).toBe('UNRESOLVED');
    /* Unresolved is not unusable: the tokens still search. */
    expect(parsed.tokens.length).toBeGreaterThan(0);
  });

  it('strips a leading level word, because the title parser does', () => {
    expect(parseSearchQuery('Senior Backend Developer').roleSlug).toBe(
      parseSearchQuery('Backend Developer').roleSlug,
    );
  });
});

describe('the false merges section 9 forbids', () => {
  /*
   * Each pair is asserted to resolve DIFFERENTLY, or to leave at least
   * one side unresolved. Written as a table so that adding an alias which
   * collapses one of them fails here rather than in production.
   */
  it.each([
    ['Software Engineer', 'Engineering Manager'],
    ['Data Analyst', 'Data Scientist'],
    ['Product Manager', 'Program Manager'],
    ['Developer', 'Engineering Manager'],
    ['Director', 'Manager'],
  ])('never equates %s with %s', (left, right) => {
    const a = parseSearchQuery(left);
    const b = parseSearchQuery(right);

    const bothResolved = a.roleSlug !== null && b.roleSlug !== null;

    expect(bothResolved && a.roleSlug === b.roleSlug).toBe(false);
  });

  /*
   * Non-vacuity. If every query in this codebase resolved to null, the
   * table above would pass over nothing at all.
   */
  it('resolves at least one side of a pair, so the table is not vacuous', () => {
    expect(parseSearchQuery('Software Engineer').roleSlug).not.toBeNull();
    expect(parseSearchQuery('Data Analyst').roleSlug).not.toBeNull();
  });

  it('has no path from a query to a role nobody authored', () => {
    /*
     * The guarantee stated as a property rather than by example: every
     * role a query can reach is a value in the authored alias table.
     * There is no edit distance, no stemmer and no embedding that could
     * mint one.
     */
    const authored = new Set(Object.values(ROLE_ALIASES));

    for (const query of [
      'softwar enginer',
      'engineering manager',
      'data scienist',
      'senior staff principal engineer',
      'manager',
    ]) {
      const slug = parseSearchQuery(query).roleSlug;

      expect(slug === null || authored.has(slug)).toBe(true);
    }
  });
});

describe('what a query may not do', () => {
  it('caps the token list, so a long query cannot grow the query plan', () => {
    const parsed = parseSearchQuery(
      Array.from({ length: 60 }, (_, index) => `word${index}`).join(' '),
    );

    expect(parsed.tokens.length).toBeLessThanOrEqual(12);
  });

  it('removes duplicate tokens but keeps the caller order', () => {
    expect(parseSearchQuery('java java python java').tokens).toEqual([
      'java',
      'python',
    ]);
  });

  it('reports a query of pure punctuation as degenerate rather than empty', () => {
    const parsed = parseSearchQuery('!!! ??? ***');

    expect(parsed.tokens).toEqual([]);
    expect(parsed.degenerate).toBe(true);
  });

  it('does not call an empty query degenerate', () => {
    expect(parseSearchQuery('   ').degenerate).toBe(false);
  });

  /*
   * Injection-shaped input is data, not syntax. Nothing in this file
   * builds SQL, but a tokenizer that choked on a quote would push the
   * problem into something that does.
   */
  it.each([
    '\'; DROP TABLE "MarketPosting"; --',
    "engineer' OR '1'='1",
    '%%%%%',
    'engineer ',
  ])('treats %j as ordinary text', (hostile) => {
    const parsed = parseSearchQuery(hostile);

    expect(Array.isArray(parsed.tokens)).toBe(true);
  });
});

describe('locations', () => {
  it('keeps a comma-separated qualifier the title parser would discard', () => {
    /*
     * normalizeTitle splits on a comma to drop a job title's trailing
     * team name. A location must not go through it: "Toronto, ON" would
     * lose the half that disambiguates it.
     */
    expect(parseLocationQuery('Toronto, ON').tokens).toEqual(['toronto', 'on']);
  });

  it('does not silently equate an accented city with its unaccented spelling', () => {
    /*
     * 1,195 Canada Job Bank postings carry a city spelled with an acute
     * accent. Folding is NFKC plus casefolding; it is NOT accent
     * stripping, so the two spellings do not converge. Recorded here as
     * behaviour rather than left to be discovered, because it is a real
     * limit on what a reader can find and it is named in the phase
     * report.
     */
    const accented = parseLocationQuery('Montréal').tokens;
    const plain = parseLocationQuery('Montreal').tokens;

    expect(accented).not.toEqual(plain);
  });

  it('tokenizes a document and a query with the same function', () => {
    const document = projectLocation('San Francisco, CA | New York City, NY');
    const query = parseLocationQuery('new york city');

    expect(query.tokens.every((token) => document.tokens.includes(token))).toBe(
      true,
    );
  });

  it('returns nothing for a posting with no location, rather than an empty string', () => {
    expect(projectLocation(null)).toEqual({ normalized: null, tokens: [] });
  });

  it('sorts a document location token list, so a hash is stable', () => {
    const tokens = projectLocation('Zurich Bern Aarau').tokens;

    expect(tokens).toEqual([...tokens].sort());
  });
});
