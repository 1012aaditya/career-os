import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../common/canonical-json.js';
import type { RawPostingRecord } from '../sources/source-adapter.js';
import {
  extractSkillMentions,
  normalizeCompany,
  normalizePosting,
  normalizeTitle,
  tokenize,
} from './normalize.js';
import { AMBIGUOUS_TERMS_REFUSED, SKILL_ALIASES } from './ruleset.js';

/*
 * The normalizer is where this phase either earns trust or loses it.
 *
 * A market graph that maps "Java" to JavaScript is not a market graph with
 * a small bug in it; it is a system publishing a false statement about the
 * job market, indistinguishable from a true one. The negative table below
 * is therefore the most important thing in this file, and several of its
 * rows describe mistakes a substring matcher makes by default.
 */

function record(over: Partial<RawPostingRecord> = {}): RawPostingRecord {
  return {
    externalKey: '1',
    sourceScope: 'acme',
    titleRaw: 'Backend Engineer',
    companyRaw: 'Acme, Inc.',
    locationRaw: 'Remote',
    descriptionRaw: '<p>We use TypeScript and Postgres.</p>',
    descriptionCompleteness: 'FULL',
    sourcePublishedAt: '2026-08-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
    sourceValidThrough: null,
    applyUrlRaw: 'https://example.invalid/1',
    sourceCategoriesRaw: ['Engineering'],
    externalGroupKey: '99',
    payload: {},
    ...over,
  };
}

describe('tokenization', () => {
  it('keeps the punctuation that lives inside a technology name', () => {
    expect(tokenize('C++, C#, .NET and Node.js.')).toEqual([
      'c++',
      'c#',
      '.net',
      'and',
      'node.js',
    ]);
  });

  it('does not let a trailing dot change a token', () => {
    expect(tokenize('node.js.')).toEqual(tokenize('node.js'));
  });
});

describe('skill extraction', () => {
  const positive: Array<[string, string]> = [
    ['We use TypeScript daily', 'typescript'],
    ['Strong JS fundamentals', 'javascript'],
    ['JavaScript required', 'javascript'],
    ['Javascript required', 'javascript'],
    ['Experience with Postgres', 'postgresql'],
    ['Experience with PostgreSQL', 'postgresql'],
    ['We run a PostgreSQL DB', 'postgresql'],
    ['Backend in Golang', 'golang'],
    ['We write C++ here', 'cpp'],
    ['A C# shop', 'csharp'],
    ['Built on .NET', 'dotnet'],
    ['Node.js services', 'nodejs'],
    ['We use K8s', 'kubernetes'],
    ['Amazon Web Services experience', 'aws'],
    ['scikit-learn and pandas', 'scikit-learn'],
  ];

  it.each(positive)('reads %j as %s', (text, slug) => {
    const found = extractSkillMentions(text, 'DESCRIPTION').map(
      (mention) => mention.skillSlug,
    );

    expect(found).toContain(slug);
  });

  /*
   * Every row here is a false positive that a substring matcher produces,
   * and every one of them would be published as a market fact.
   */
  const negative: Array<[string, string]> = [
    ['Strong Java background', 'javascript'],
    ['JavaFX desktop work', 'javascript'],
    ['Postgres-compatible storage', 'postgresql'],
    ['R&D team', 'r'],
    ['Rust systems work', 'r'],
    ['Ruby on Rails', 'r'],
    ['go-to-market strategy', 'golang'],
    ['an ongoing project', 'golang'],
    ['ready to go fast', 'golang'],
    ['GoDaddy integration', 'golang'],
    ['We write C here', 'cpp'],
    ['We write C here', 'csharp'],
  ];

  it.each(negative)('does not read %j as %s', (text, slug) => {
    const found = extractSkillMentions(text, 'DESCRIPTION').map(
      (mention) => mention.skillSlug,
    );

    expect(found).not.toContain(slug);
  });

  /*
   * The refusal list is a decision, not an oversight, so it is asserted.
   * A later contributor who "fixes coverage" by adding bare 'go' has to
   * delete a test that explains why it is not there.
   */
  it.each(AMBIGUOUS_TERMS_REFUSED)(
    'refuses %j as a bare term, preferring a gap to a false positive',
    (term) => {
      expect(SKILL_ALIASES[term]).toBeUndefined();
    },
  );

  it('prefers the longest match, so React Native is not React', () => {
    const found = extractSkillMentions(
      'React Native experience',
      'DESCRIPTION',
    ).map((mention) => mention.skillSlug);

    expect(found).toContain('react-native');
    expect(found).not.toContain('react');
  });

  it('counts a skill named ten times once', () => {
    const mentions = extractSkillMentions(
      'typescript typescript typescript typescript typescript',
      'DESCRIPTION',
    );

    expect(mentions).toHaveLength(1);
  });

  it('records which rule fired, so a mapping can be explained', () => {
    const [mention] = extractSkillMentions('We use Postgres', 'DESCRIPTION');

    expect(mention).toEqual({
      rawTerm: 'postgres',
      termNormalized: 'postgres',
      skillSlug: 'postgresql',
      aliasKey: 'postgres',
      matchMethod: 'ALIAS',
      extractedFrom: 'DESCRIPTION',
    });
  });

  it('distinguishes a canonical spelling from an alias', () => {
    const [mention] = extractSkillMentions('We use typescript', 'DESCRIPTION');

    expect(mention?.matchMethod).toBe('EXACT_CANONICAL');
  });

  const unicode: Array<[string, string, string | null]> = [
    ['fullwidth', 'ＪＳ required', 'javascript'],
    ['uppercase', 'TYPESCRIPT', 'typescript'],
    ['padded', '   typescript   ', 'typescript'],
    /*
     * A non-breaking space joins two words into one token, so this is NOT
     * JavaScript - and reading it as JavaScript would be inventing a skill
     * from an invisible character.
     */
    ['a non-breaking space between words', 'Java Script', null],
  ];

  it.each(unicode)('handles %s', (_label, text, expected) => {
    const found = extractSkillMentions(text, 'DESCRIPTION').map(
      (mention) => mention.skillSlug,
    );

    if (expected === null) {
      expect(found).not.toContain('javascript');
    } else {
      expect(found).toContain(expected);
    }
  });
});

describe('title resolution', () => {
  it.each([
    ['Backend Engineer', 'backend-engineer', null],
    ['Senior Backend Engineer', 'backend-engineer', 'senior'],
    ['Staff Backend Engineer', 'backend-engineer', 'staff'],
    ['Back-End Engineer', 'backend-engineer', null],
    ['Software Engineer, CDN', 'software-engineer', null],
    ['Software Engineer (Remote)', 'software-engineer', null],
    ['Software Engineer - Payments', 'software-engineer', null],
    ['Forward-Deployed Engineer', 'solutions-engineer', null],
  ])('resolves %j to %s', (title, slug, modifier) => {
    const result = normalizeTitle(title);

    expect(result.roleSlug).toBe(slug);
    expect(result.titleModifierRaw).toBe(modifier);
  });

  /*
   * A regression test for a real bug found by running this against live
   * data: stripping "director" as a modifier BEFORE looking the title up
   * left "of engineering", so the alias for the whole phrase could never
   * be reached and a genuine role silently joined the unmapped backlog.
   */
  it('tries the whole title before stripping a modifier from it', () => {
    const result = normalizeTitle('Director of Engineering');

    expect(result.roleSlug).toBe('engineering-manager');
    expect(result.titleModifierRaw).toBeNull();
  });

  it('leaves an unknown title unmapped rather than guessing a near role', () => {
    const result = normalizeTitle('Chief Vibes Officer');

    expect(result.roleSlug).toBeNull();
    expect(result.roleMatchMethod).toBe('UNMAPPED');
    expect(result.roleAliasKey).toBeNull();
    /* The raw reading is retained, so the gap is measurable. */
    expect(result.titleNormalized).toBe('chief vibes officer');
  });
});

describe('company folding', () => {
  it.each([
    ['Stripe', 'stripe'],
    ['Stripe, Inc.', 'stripe'],
    ['Stripe Inc', 'stripe'],
    ['ACME GmbH', 'acme'],
  ])('folds %j to %s', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });

  it('treats an absent company as absent, not as an empty employer', () => {
    expect(normalizeCompany(null)).toBeNull();
  });
});

describe('determinism', () => {
  it('produces an identical reading for the same posting every time', () => {
    const a = normalizePosting(record());
    const b = normalizePosting(record());

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  /*
   * The description text itself is part of what a posting SAYS, so two
   * different texts legitimately hash differently - an earlier version of
   * this test asserted otherwise and was wrong. What must not depend on
   * the text's ordering is the order of the MENTIONS, because that order
   * is a decision this code makes rather than something the employer
   * wrote.
   */
  it('emits mentions in an order it decided, not the order the text used', () => {
    const forward = normalizePosting(
      record({ descriptionRaw: 'TypeScript, Postgres, Kubernetes' }),
    );
    const reversed = normalizePosting(
      record({ descriptionRaw: 'Kubernetes, Postgres, TypeScript' }),
    );

    const skills = (posting: typeof forward) =>
      posting.mentions.map((mention) => mention.skillSlug);

    expect(skills(reversed)).toEqual(skills(forward));
    expect(skills(forward)).toEqual(['kubernetes', 'postgresql', 'typescript']);
  });

  it('produces the same reading under a different process timezone', () => {
    const original = process.env.TZ;

    try {
      process.env.TZ = 'UTC';
      const utc = normalizePosting(record()).outputHash;

      process.env.TZ = 'Asia/Kolkata';
      const kolkata = normalizePosting(record()).outputHash;

      expect(kolkata).toBe(utc);
    } finally {
      process.env.TZ = original;
    }
  });

  it('keeps a title mention and a description mention apart', () => {
    const normalized = normalizePosting(
      record({
        titleRaw: 'TypeScript Engineer',
        descriptionRaw: 'We use TypeScript.',
      }),
    );

    const loci = normalized.mentions
      .filter((mention) => mention.skillSlug === 'typescript')
      .map((mention) => mention.extractedFrom);

    expect(loci.sort()).toEqual(['DESCRIPTION', 'TITLE']);
  });

  it('marks a posting with no body as unreadable, never as skill-free', () => {
    const normalized = normalizePosting(record({ descriptionRaw: null }));

    expect(normalized.skillExtractionStatus).toBe('NO_TEXT');
    expect(normalized.descriptionText).toBeNull();
    /*
     * The distinction that matters: NO_TEXT keeps this posting out of the
     * prevalence denominator instead of counting it as a posting that
     * required nothing.
     */
    expect(normalized.skillExtractionStatus).not.toBe('EXTRACTED');
  });
});
