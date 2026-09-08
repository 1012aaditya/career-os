import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../common/canonical-json.js';
import type { RawPostingRecord } from '../sources/source-adapter.js';
import { foldTerm } from '../observations/text.js';
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
    /* The real substring trap here is `java`, not `javascript`. */
    ['JavaFX desktop work', 'java'],
    ['a JavaBeans codebase', 'java'],
    ['reactive programming', 'react'],
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

  /*
   * A property rather than examples. The negative table above documents
   * specific traps, but most of its rows survive a substring matcher by
   * accident of tokenization - only two of them actually fail if whole-
   * token matching is replaced with `includes`. This one fails for every
   * alias in the dictionary and cannot rot as the dictionary grows.
   */
  it('finds no alias buried inside a longer word', () => {
    for (const alias of Object.keys(SKILL_ALIASES)) {
      const buried = `zz${alias}zz`;
      const found = extractSkillMentions(buried, 'DESCRIPTION');

      expect(`${buried}: ${found.length}`).toBe(`${buried}: 0`);
    }
  });

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
   * "Director of Engineering" no longer resolves, and that is the fix
   * rather than a regression. Mapping it to engineering-manager asserted
   * that a director and an engineering manager are one role - a level
   * collapse, and the exact guess the no-fuzzy-fallback rule exists to
   * prevent. What must hold is that the title survives INTACT and lands in
   * the visible backlog rather than becoming a fragment.
   */
  it('leaves a leadership title unmapped, whole, and countable', () => {
    const result = normalizeTitle('Director of Engineering');

    expect(result.roleSlug).toBeNull();
    expect(result.titleNormalized).toBe('director of engineering');
    expect(result.titleModifierRaw).toBeNull();
  });

  /*
   * The fragment bug: stripping a leading modifier used to leave a
   * dangling preposition. "of product management" can never match an
   * alias and reads as nonsense in the backlog - and repairing the output
   * rather than refusing the strip would have silently turned this posting
   * into a product manager.
   */
  it('refuses a strip that would leave a dangling preposition', () => {
    const result = normalizeTitle('Director of Product Management');

    expect(result.titleNormalized).toBe('director of product management');
    expect(result.titleModifierRaw).toBeNull();
  });

  /*
   * Measured on 2955 live postings: 168 titles had a level word removed
   * from the END, and exactly one of them resolved a role as a result.
   * Each of these lost its actual job word.
   */
  it.each([
    ['Art Director', 'art director'],
    ['Creative Director, Copy', 'creative director'],
    ['Team Lead, ARC Software Engineering Team', 'team lead'],
    ['Chief of Staff, CRO', 'chief of staff'],
    ['Operations Associate, Sanctions', 'operations associate'],
    ['AWS GTM Partnership Lead', 'aws gtm partnership lead'],
  ])('keeps the job word in %j', (title, normalized) => {
    const result = normalizeTitle(title);

    expect(result.titleNormalized).toBe(normalized);
    expect(result.titleModifierRaw).toBeNull();
  });

  /*
   * The token list used to be scanned in array order, so "Senior Director"
   * stripped `director` purely because that entry precedes `senior`. Which
   * level word survived was decided by array position rather than by a
   * rule.
   */
  it('strips the leading level word, not whichever the list reaches first', () => {
    expect(normalizeTitle('Senior Director, Alliance').titleModifierRaw).toBe(
      'senior',
    );
  });

  it.each([
    ['Staff+ Software Engineer, Backend', 'software-engineer', 'staff+'],
    ['Sr. Staff Software Engineer', 'software-engineer', 'sr. staff'],
    ['Senior Software Engineer', 'software-engineer', 'senior'],
    ['Technical Program Manager, Platform', 'technical-program-manager', null],
    ['Research Engineer, Machine Learning', 'research-engineer', null],
    ['Delivery Solutions Architect', 'solutions-engineer', null],
    ['Member of the Technical Staff', 'software-engineer', null],
    ['UI/UX Designer', 'product-designer', null],
  ])('resolves %j to %s', (title, slug, modifier) => {
    const result = normalizeTitle(title);

    expect(result.roleSlug).toBe(slug);
    expect(result.titleModifierRaw).toBe(modifier);
  });

  /*
   * Roles that are genuinely different must never collapse into each
   * other. Asserted as a partition, because an input/output table cannot
   * express "these two must stay apart".
   */
  it('keeps distinct roles distinct', () => {
    const pairs: Array<[string, string]> = [
      ['Director of Engineering', 'Software Engineer'],
      ['Director of Engineering', 'Engineering Manager'],
      ['Engineering Manager', 'Software Engineer'],
      ['Data Analyst', 'Data Scientist'],
      ['Data Scientist', 'Data Engineer'],
      ['Research Engineer', 'Software Engineer'],
      ['Technical Program Manager', 'Product Manager'],
      ['Technical Program Manager', 'Engineering Manager'],
      ['Product Manager', 'Product Designer'],
      ['Solutions Engineer', 'Software Engineer'],
      ['Art Director', 'Director of Engineering'],
      ['Chief of Staff', 'Staff Software Engineer'],
      ['Head of Engineering', 'Engineering Manager'],
      ['AWS GTM Partnership Lead', 'Lead Engineer'],
    ];

    for (const [left, right] of pairs) {
      const a = normalizeTitle(left);
      const b = normalizeTitle(right);

      /*
       * Distinct means: not the same resolved role, and where both are
       * unmapped, not the same normalized string either.
       */
      const same =
        a.roleSlug !== null && b.roleSlug !== null
          ? a.roleSlug === b.roleSlug
          : a.titleNormalized === b.titleNormalized;

      expect(`${left} vs ${right}: ${same ? 'COLLAPSED' : 'distinct'}`).toBe(
        `${left} vs ${right}: distinct`,
      );
    }
  });

  /*
   * Two properties rather than examples, because they cannot rot. The
   * second is what the 168 tail strips would have failed.
   */
  it('never produces a title that begins or ends with a preposition', () => {
    const titles = [
      'Director of Engineering',
      'Head of Deal Desk - International',
      'Chief of Staff, CRO',
      'Member of the Technical Staff',
      'Director of Product Management',
      'VP of Engineering',
    ];

    for (const title of titles) {
      const normalized = normalizeTitle(title).titleNormalized;

      expect(`${title}: ${normalized}`).toBe(`${title}: ${normalized}`);
      expect(/^(of|for|in|to|at|on|and)\b/.test(normalized)).toBe(false);
      expect(/\b(of|for|in|to|at|on|and)$/.test(normalized)).toBe(false);
    }
  });

  it('records a modifier only when the folded title starts with it', () => {
    const titles = [
      'Art Director',
      'Creative Director, Copy',
      'Senior Software Engineer',
      'Staff+ Software Engineer',
      'Team Lead, ARC Software Engineering Team',
      'Sr. Director, Procure to Pay',
      'Operations Associate',
      'Software Engineering Intern',
    ];

    for (const title of titles) {
      const result = normalizeTitle(title);

      if (result.titleModifierRaw === null) {
        continue;
      }

      expect(
        `${title}: ${foldTerm(title).startsWith(result.titleModifierRaw)}`,
      ).toBe(`${title}: true`);
    }
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
  /*
   * Asserted as a PARTITION, not a value table.
   *
   * The property that matters is which names fold together and which stay
   * apart, and an input/output table cannot express the second. The
   * direction of harm is asymmetric: two rows for one employer is a count
   * that is too high beside a sample somebody can inspect; one row for two
   * employers is a count that is too low beside a sample that looks fine -
   * and distinctCompanyCount is the control that reveals a single-employer
   * sample, so a silent merge disables it.
   */
  const foldTogether: Array<[string, string[]]> = [
    [
      'a recognised suffix, however it is punctuated',
      [
        'Stripe',
        'Stripe Inc',
        'Stripe Inc.',
        'Stripe, Inc',
        'Stripe, Inc.',
        'Stripe,Inc.',
        'Stripe, Incorporated',
      ],
    ],
    ['long and short forms', ['Acme Ltd', 'Acme Limited', 'Acme, Ltd.']],
    ['company and its abbreviation', ['Acme Co.', 'Acme Company', 'Acme']],
    ['dotted and undotted', ['Acme S.A.', 'Acme SA', 'Acme, S.A.']],
    ['dotted LLC', ['Acme L.L.C.', 'Acme LLC', 'ACME,LLC']],
    ['stacked suffixes', ['Acme Holdings Ltd Inc', 'Acme Holdings']],
    ['typographic apostrophes', ["Ben & Jerry's", 'Ben & Jerry\u2019s']],
    ['case and whitespace', ['Scale AI', 'scale ai', '  SCALE   AI  ']],
    ['an enclosing pair', ['(Acme)', 'Acme']],
    ['unicode forms', ['Caf\u00e9 Inc', 'Cafe\u0301 Inc']],
  ];

  it.each(foldTogether)('folds %s together', (_label, variants) => {
    const folded = new Set(variants.map((name) => normalizeCompany(name)));

    expect(`${variants.join(' | ')} -> ${[...folded].join(' , ')}`).toBe(
      `${variants.join(' | ')} -> ${normalizeCompany(variants[0]!)}`,
    );
  });

  /*
   * Each of these is a distinct employer. Any two of them folding together
   * is a silent merge. "The Limited", "The Corp", "The Co" and "The Inc"
   * all became "the" before the guard existed - four employers reported as
   * one.
   */
  it('keeps suffix-shaped names apart from each other and from bare suffixes', () => {
    const distinct = [
      'The Limited',
      'The Corp',
      'The Co',
      'The Inc',
      'Limited Brands',
      'Incorporated Ltd',
      'Corp',
      'Inc.',
      'Co-op Group',
      'Acme',
      'Acme (UK)',
      'Acme (US)',
      'Nestl\u00e9',
      'Nestle',
      'Yahoo!',
      'L.L. Bean',
      '37signals',
    ];

    const folded = distinct.map((name) => normalizeCompany(name));

    expect(new Set(folded).size).toBe(distinct.length);
  });

  /*
   * The fixed two-pass loop was not idempotent, which meant the stored
   * column could never safely be re-fed through this function and any
   * future backfill was a trap.
   */
  it.each([
    'Acme Holdings Ltd Inc',
    'Acme Corp Ltd Inc LLC',
    'Stripe, Inc.',
    'The Limited',
    'Societe Generale S.A.',
  ])('is idempotent on %j', (name) => {
    const once = normalizeCompany(name);

    expect(normalizeCompany(once)).toBe(once);
  });

  it.each(['', '   ', ',', '...', '- ', '()'])(
    'treats %j as no employer rather than an empty one',
    (name) => {
      expect(normalizeCompany(name)).toBeNull();
    },
  );

  it('never returns an empty string or trailing punctuation', () => {
    const names = [
      'Inc.',
      'Acme & Co',
      'Acme - Inc',
      'Yahoo! Inc.',
      'Acme,',
      'Corp',
      'A Inc',
    ];

    for (const name of names) {
      const folded = normalizeCompany(name);

      if (folded === null) {
        continue;
      }

      expect(`${name}: ${folded}`).toBe(`${name}: ${folded}`);
      expect(folded.length).toBeGreaterThan(0);
      expect(/[\s.,;:\-/\\|&]$/.test(folded)).toBe(false);
    }
  });

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

describe('tokenizing beyond ASCII', () => {
  /*
   * The defect ruleset v3 fixes. TOKEN_CHARS was [a-z0-9+#./_-], so every
   * character outside that set was a word boundary - and the corpus is not
   * English. JobTech resolved 3.22% of its titles and Teaching Vacancies
   * resolved none, and this is a large part of why.
   */
  it('keeps a Swedish compound whole instead of splitting on the umlaut', () => {
    expect(tokenize('Mjukvaruingenjör')).toEqual(['mjukvaruingenjör']);
  });

  it.each([
    ['French', 'Développeur Full Stack', ['développeur', 'full', 'stack']],
    [
      'Norwegian',
      'Systemutvikler på Østlandet',
      ['systemutvikler', 'på', 'østlandet'],
    ],
    ['Korean', '소프트웨어 개발자', ['소프트웨어', '개발자']],
    ['German', 'Softwareentwickler (m/w/d)', ['softwareentwickler', 'm/w/d']],
  ])('keeps %s text whole', (_language, input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  /*
   * The four punctuation marks that carry meaning inside a technology name
   * must survive the change, or the fix would trade one broken language
   * for a broken skill vocabulary.
   */
  it.each([
    ['c++', ['c++']],
    ['c#', ['c#']],
    ['node.js', ['node.js']],
    ['scikit-learn', ['scikit-learn']],
    ['ci/cd', ['ci/cd']],
    ['.net', ['.net']],
  ])('still reads %s as one token', (input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  it('is unchanged for pure ASCII, so v2 behaviour is preserved there', () => {
    expect(tokenize('Senior Backend Engineer, Python')).toEqual([
      'senior',
      'backend',
      'engineer',
      'python',
    ]);
  });

  /*
   * NFKC can leave a sequence decomposed, so a combining accent arrives as
   * its own code point. Without \p{M} it would be a boundary and would
   * split its own word - the same defect in a subtler form.
   */
  it('keeps a combining accent attached to its base character', () => {
    const decomposed = 'Developpé'.normalize('NFD');

    expect(tokenize(decomposed)).toHaveLength(1);
  });

  it('still treats real separators as boundaries', () => {
    expect(tokenize('Engineer, Backend | Remote')).toEqual([
      'engineer',
      'backend',
      'remote',
    ]);
  });
});
