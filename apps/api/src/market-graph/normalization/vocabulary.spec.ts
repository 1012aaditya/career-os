import { describe, expect, it } from 'vitest';

import {
  OCCUPATION_ROLES,
  ROLES,
  ROLE_ALIASES,
  TECH_ROLES,
  VOCABULARY_VERSION,
  VOCABULARY_V1_ROLES,
} from './ruleset.js';
import { roleFromOccupationCode } from './normalize.js';

/*
 * The canonical vocabulary, and the rules that keep it honest.
 *
 * Vocabulary v1 exists because a measurement, not a hunch: the Unicode
 * tokenizer fix moved role resolution by exactly zero, and the reason was
 * that resolution read titles against 159 English aliases while every
 * source was already publishing its own occupational code.
 */

describe('the occupational-code matcher', () => {
  it('resolves a role from the publisher code rather than the title', () => {
    expect(roleFromOccupationCode('noc', ['63200', 'Cooks'])).toBe('cook');
  });

  it('finds the code wherever it sits in the array', () => {
    /* The array is ordered by the adapter for hash stability, so the
     * code's position is not fixed. */
    expect(
      roleFromOccupationCode('dfe-occupational-category', [
        'Education',
        'PART_TIME',
        'teacher',
      ]),
    ).toBe('teacher');
  });

  it('resolves a Swedish label with no Swedish alias in the vocabulary', () => {
    /* This is what a code buys that an alias list cannot: the title is
     * Swedish and no alias matches it, but the publisher classified it. */
    expect(
      roleFromOccupationCode('ssyk-label', [
        'Data/IT',
        'Systemutvecklare/Programmerare',
      ]),
    ).toBe('software-engineer');
  });

  /*
   * Ambiguity safety. Two of the publisher's own codes disagreeing is
   * exactly the case where picking the first would be worst.
   */
  it('refuses to choose when two codes assert different roles', () => {
    expect(roleFromOccupationCode('noc', ['63200', '72310'])).toBeNull();
  });

  it('returns null for an unmapped code rather than a nearest guess', () => {
    expect(roleFromOccupationCode('noc', ['99999'])).toBeNull();
  });

  it.each([
    ['no scheme declared', null, ['63200']],
    ['an unknown scheme', 'esco', ['63200']],
    ['no categories', 'noc', []],
  ])('returns null for %s', (_label, scheme, categories) => {
    expect(roleFromOccupationCode(scheme, categories)).toBeNull();
  });
});

describe('false merges the vocabulary must not make', () => {
  /*
   * Each pair is a distinct occupation that a careless mapping would
   * collapse. The brief names these; the vocabulary keeps them apart.
   */
  it.each([
    ['cooks and chefs', '63200', '62200'],
    ['food service supervisors and restaurant managers', '62020', '0631'],
    ['retail salespersons and retail supervisors', '64100', '62010'],
    ['retail supervisors and retail managers', '62010', '0621'],
    ['nurse aides and licensed practical nurses', '33102', '32101'],
  ])('keeps %s distinct', (_label, a, b) => {
    const roleA = roleFromOccupationCode('noc', [a]);
    const roleB = roleFromOccupationCode('noc', [b]);

    expect(roleA).not.toBeNull();
    expect(roleA).not.toBe(roleB);
  });

  /*
   * OPM 2210 is "Information Technology Management" and covers 9,959
   * federal postings. It spans administration, security, networks and
   * applications, so folding it into software-engineer would be the
   * largest false merge available in this corpus.
   */
  it('does not fold the broad federal IT series into software engineering', () => {
    const role = roleFromOccupationCode('opm-series', ['2210']);

    expect(role).toBe('it-specialist');
    expect(role).not.toBe('software-engineer');
  });

  it('keeps systems analysts distinct from software engineers', () => {
    expect(roleFromOccupationCode('noc', ['21222'])).toBe('systems-analyst');
  });
});

describe('vocabulary integrity', () => {
  it('is versioned separately from the ruleset', () => {
    expect(Number.isInteger(VOCABULARY_VERSION)).toBe(true);
    expect(VOCABULARY_VERSION).toBeGreaterThan(0);
  });

  it('preserves every original tech role', () => {
    for (const role of TECH_ROLES) {
      expect(ROLES.some((r) => r.slug === role.slug)).toBe(true);
    }
  });

  it('preserves every one of the original role aliases', () => {
    /*
     * 83 authored entries, which expand to 159 alias ROWS once variants
     * are generated - the 159 figure quoted elsewhere is the database
     * count, not the authored one. Vocabulary growth must never remove a
     * mapping that already worked, so this is a floor.
     */
    expect(Object.keys(ROLE_ALIASES).length).toBeGreaterThanOrEqual(83);
  });

  it('declares a canonical role for every code it maps to', () => {
    const slugs = new Set(ROLES.map((role) => role.slug));

    for (const [scheme, table] of Object.entries(OCCUPATION_ROLES)) {
      for (const [code, slug] of Object.entries(table)) {
        expect(`${scheme}/${code} -> ${slug}: ${slugs.has(slug)}`).toBe(
          `${scheme}/${code} -> ${slug}: true`,
        );
      }
    }
  });

  it('has no duplicate role slug', () => {
    const slugs = ROLES.map((role) => role.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps the two vocabulary origins visible and non-overlapping', () => {
    const tech = new Set(TECH_ROLES.map((r) => r.slug));

    for (const [slug] of VOCABULARY_V1_ROLES) {
      expect(`${slug} in tech set: ${tech.has(slug)}`).toBe(
        `${slug} in tech set: false`,
      );
    }
  });
});
