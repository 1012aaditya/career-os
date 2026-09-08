import { canonicalHash } from '../../common/canonical-hash.js';
import { foldTerm, htmlToText } from '../observations/text.js';
import type { RawPostingRecord } from '../sources/source-adapter.js';
import {
  RULESET_VERSION,
  ROLE_ALIASES,
  SENIORITY_TOKENS,
  SKILL_ALIASES,
} from './ruleset.js';

/*
 * Pure normalization: one raw posting in, one normalized reading out.
 *
 * No HTTP, no Prisma, no clock, no randomness, and no database lookup of
 * the alias tables - they are module constants, versioned together with
 * this code. A normalizer that consulted mutable state would be a function
 * of that state, and its output could never be reproduced, which would
 * make the ruleset version a label rather than a guarantee.
 *
 * Everything here answers to RULESET_VERSION. If any rule below changes -
 * the folding order, the token alphabet, the n-gram width, the seniority
 * list, the longest-match rule - that number must change with it, or
 * already-published numbers silently acquire a new meaning.
 */

export type TermMatchMethod =
  'EXACT_CANONICAL' | 'ALIAS' | 'SOURCE_TAXONOMY' | 'UNMAPPED';

export type TermLocus = 'TITLE' | 'DESCRIPTION' | 'SOURCE_TAXONOMY';

export type SkillMention = {
  /** The exact source substring that matched. Never tidied, never null. */
  rawTerm: string;
  termNormalized: string;
  skillSlug: string | null;
  aliasKey: string | null;
  matchMethod: TermMatchMethod;
  extractedFrom: TermLocus;
};

export type NormalizedPosting = {
  rulesetVersion: number;
  titleNormalized: string;
  roleSlug: string | null;
  roleMatchMethod: TermMatchMethod;
  roleAliasKey: string | null;
  titleModifierRaw: string | null;
  companyNormalized: string | null;
  descriptionText: string | null;
  skillExtractionStatus: 'EXTRACTED' | 'NO_TEXT' | 'FAILED';
  mentions: SkillMention[];
  outputHash: string;
};

/*
 * The token alphabet.
 *
 * Letters, digits, and the four punctuation marks that carry meaning
 * INSIDE a technology name: + (c++), # (c#), . (node.js, .net) and -
 * (scikit-learn). Slash is included for ci/cd. Everything else is a
 * boundary.
 *
 * Getting this wrong is how a skill extractor breaks: split on all
 * punctuation and "c++" becomes "c", which then matches nothing and hides
 * a real skill; split on none and "javascript," never matches "javascript".
 *
 * UNICODE, from ruleset v3. This was [a-z0-9+#./_-], which is ASCII-only,
 * and the consequence was not subtle: "Mjukvaruingenjor" with an o-umlaut
 * tokenized to "mjukvaruingenj" + "r", because the umlaut was a boundary.
 * Every non-English title fragmented the same way, which is a large part
 * of why JobTech resolved 3.22% of its titles and Teaching Vacancies
 * resolved none.
 *
 * \p{L} covers every script - Latin with diacritics, Hangul, Cyrillic,
 * CJK. \p{N} covers every numeral. \p{M} keeps combining marks attached
 * to their base character, which matters because NFKC leaves some
 * sequences decomposed and without it an accent would split its own word.
 * The four meaningful punctuation marks are unchanged.
 */
const TOKEN_CHARS = /[\p{L}\p{N}\p{M}+#./_-]+/gu;

/*
 * A leading dot is kept, because ".net" needs it. A trailing dot is not,
 * because "node.js." at the end of a sentence must still be "node.js".
 */
function trimToken(token: string): string {
  return token.replace(/^[_\-/]+/, '').replace(/[._\-/]+$/, '');
}

export function tokenize(text: string): string[] {
  const folded = foldTerm(text);
  const matches = folded.match(TOKEN_CHARS) ?? [];

  return matches.map(trimToken).filter((token) => token.length > 0);
}

/*
 * Prepositions and conjunctions that must never begin a normalized title.
 *
 * A strip that leaves one behind has taken a word out of the middle of a
 * phrase: "Director of Product Management" becoming "of product
 * management" is not a title with a level removed, it is a fragment. The
 * guard refuses the strip rather than repairing the output, because
 * repairing it would silently turn that posting into a product manager.
 */
const PREPOSITION_HEAD = /^(of|for|in|to|at|on|the|and|&)\b/;

/**
 * Removes level words from the FRONT of a title, and only the front.
 *
 * Leading-only, and that single positional rule settles every hard case
 * without a special rule for any of them. English job titles are
 * head-final: the last content word of the head names the job and
 * everything before it modifies. So a word that ENDS the head is the role,
 * and the same word before another content word is a level.
 *
 * The previous version also matched the tail, and the cost was measured on
 * real data: 168 titles had a level word taken off the end, and exactly
 * ONE of them resolved a role as a result. "Art Director" became "art",
 * "Team Lead, ARC Software Engineering" became "team", "Sr. Director,
 * Procure to Pay" became "sr." - the job word deleted and the qualifier
 * kept. It also iterated the token list in array order rather than by
 * position, so "Senior Director" stripped `director` because that entry
 * happens to precede `senior`: which level word survived was decided by
 * array position rather than by any rule.
 *
 * Repeats until no leading token matches, so "Sr. Staff Software Engineer"
 * loses both words rather than stopping after one.
 */
export function stripSeniority(foldedTitle: string): {
  title: string;
  titleModifierRaw: string | null;
} {
  let title = foldedTitle;
  let firstRemoved: string | null = null;

  for (let pass = 0; pass < 4; pass += 1) {
    const token = SENIORITY_TOKENS.find((candidate) =>
      title.startsWith(`${candidate} `),
    );

    if (token === undefined) {
      break;
    }

    const remainder = title.slice(token.length + 1).trim();

    /* Never strip to nothing, and never strip into a preposition. */
    if (remainder.length === 0 || PREPOSITION_HEAD.test(remainder)) {
      break;
    }

    title = remainder;

    if (firstRemoved === null) {
      firstRemoved = token;
    }
  }

  return { title, titleModifierRaw: firstRemoved };
}

/*
 * Job titles carry qualifiers that are not part of the role: a team after
 * a comma ("Account Executive, Commercial"), a location or level in
 * parentheses, a business unit after a dash. The head is kept.
 *
 * The dash rule requires surrounding spaces so that "Front-End Engineer"
 * survives intact - splitting on a bare hyphen would truncate it to
 * "front".
 */
function titleHead(folded: string): string {
  const cut = folded.split(/\s+[-–—]\s+|[,(]/)[0] ?? folded;

  return cut.trim();
}

/*
 * Hyphens joining two words become spaces, so "Front-End Engineer" and
 * "Front End Engineer" are one lookup key instead of two aliases that must
 * both be remembered. Applied AFTER titleHead, because titleHead splits on
 * a spaced dash ("Engineer - Platform") and doing this first would destroy
 * that boundary.
 *
 * Skills deliberately do not get this treatment: "scikit-learn" is one
 * token and joining it would break the match.
 */
function joinHyphenatedWords(folded: string): string {
  return folded.replace(/(\w)-(\w)/g, '$1 $2');
}

/**
 * Resolves a raw title to a canonical role.
 *
 * The FULL title head is tried before any seniority word is removed. That
 * order is load-bearing and was a real bug when it was the other way
 * round: "Director of Engineering" had `director` stripped as a seniority
 * token first, leaving "of engineering", so the alias for the whole phrase
 * could never be reached and a genuine role silently joined the unmapped
 * backlog. A more specific match always wins over a stripped one.
 */
export function normalizeTitle(titleRaw: string): {
  titleNormalized: string;
  titleModifierRaw: string | null;
  roleSlug: string | null;
  roleMatchMethod: TermMatchMethod;
  roleAliasKey: string | null;
} {
  const head = joinHyphenatedWords(titleHead(foldTerm(titleRaw)));

  const whole = ROLE_ALIASES[head];

  if (whole !== undefined) {
    return {
      titleNormalized: head,
      titleModifierRaw: null,
      roleSlug: whole,
      roleMatchMethod: 'ALIAS',
      roleAliasKey: head,
    };
  }

  const stripped = stripSeniority(head);
  const afterSeniority = ROLE_ALIASES[stripped.title];

  if (afterSeniority !== undefined) {
    return {
      titleNormalized: stripped.title,
      titleModifierRaw: stripped.titleModifierRaw,
      roleSlug: afterSeniority,
      roleMatchMethod: 'ALIAS',
      roleAliasKey: stripped.title,
    };
  }

  /*
   * No fuzzy fallback, deliberately. An unresolved title is retained as
   * UNMAPPED and counted; it is never attached to the nearest-looking
   * role. A wrong role is asserted as a market fact and silently moves a
   * denominator, whereas an unmapped title is a visible, measurable gap
   * that names exactly which alias to add.
   */
  return {
    titleNormalized: stripped.title,
    titleModifierRaw: stripped.titleModifierRaw,
    roleSlug: null,
    roleMatchMethod: 'UNMAPPED',
    roleAliasKey: null,
  };
}

const MAX_NGRAM = 3;

/**
 * Finds canonical skills in a token stream.
 *
 * Longest match wins and consumes: at each position a 3-token phrase is
 * tried, then 2, then 1, and on a hit the scan resumes after the phrase.
 * That is what makes "react native" one skill rather than "react" plus a
 * stray word, and it makes the result independent of the order the alias
 * table was built in - a dictionary is a map, and relying on its iteration
 * order would make the answer depend on insertion history.
 *
 * Matching is against whole tokens only. This is the rule that stops
 * "Java" matching inside "JavaScript" and "go" matching inside "ongoing".
 */
export function extractSkillMentions(
  text: string,
  extractedFrom: TermLocus,
): SkillMention[] {
  const tokens = tokenize(text);
  const found = new Map<string, SkillMention>();

  let index = 0;

  while (index < tokens.length) {
    let matched = false;

    for (let width = MAX_NGRAM; width >= 1; width -= 1) {
      if (index + width > tokens.length) {
        continue;
      }

      const phrase = tokens.slice(index, index + width).join(' ');
      const slug = SKILL_ALIASES[phrase];

      if (slug === undefined) {
        continue;
      }

      /*
       * First occurrence wins. A posting naming a skill ten times yields
       * one mention: a skill named repeatedly in a verbose posting is not
       * more required than one named once, and counting occurrences would
       * turn prose style into a market signal.
       */
      if (!found.has(phrase)) {
        found.set(phrase, {
          rawTerm: phrase,
          termNormalized: phrase,
          skillSlug: slug,
          aliasKey: phrase,
          matchMethod: phrase === slug ? 'EXACT_CANONICAL' : 'ALIAS',
          extractedFrom,
        });
      }

      index += width;
      matched = true;
      break;
    }

    if (!matched) {
      index += 1;
    }
  }

  /*
   * Sorted before returning. A Map iterates in insertion order, which here
   * is the order words happen to appear in a job description - real, but
   * not a decision we made. Sorting by the normalized term makes the order
   * ours and total, because the Map's keys are unique.
   */
  return [...found.values()].sort((a, b) =>
    a.termNormalized < b.termNormalized
      ? -1
      : a.termNormalized > b.termNormalized
        ? 1
        : 0,
  );
}

/*
 * Company name folding, matching the shape the Career Graph uses for
 * Company.normalizedName so a future reconciliation is a join rather than
 * a re-derivation. Legal suffixes are dropped because "Stripe" and
 * "Stripe, Inc." are one employer for the purpose of counting how many
 * employers a signal rests on.
 */
/*
 * Legal-entity suffixes, longest first.
 *
 * Ordered explicitly rather than relying on the regex engine. With
 * single-word entries and an end anchor, backtracking happens to pick the
 * alternative that reaches the end - but that protection is incidental and
 * does not survive the next multi-word entry: put "public limited company"
 * and "company" in one alternation and a leftmost-first engine strips only
 * "company", leaving "acme public limited".
 */
const LEGAL_SUFFIXES: readonly string[] = [
  'public limited company',
  'incorporated',
  'corporation',
  'limited',
  'company',
  'pty ltd',
  'pte ltd',
  'sarl',
  'corp',
  'gmbh',
  'plc',
  'llc',
  'llp',
  'ltd',
  'inc',
  'pty',
  'pte',
  'sas',
  'spa',
  'pbc',
  'ab',
  'ag',
  'as',
  'bv',
  'co',
  'kg',
  'kk',
  'lp',
  'nv',
  'oy',
  'sa',
];

const SUFFIX_SET = new Set(LEGAL_SUFFIXES);

/*
 * Words that cannot, alone, be an employer. Used only by the guard below.
 */
const COMPANY_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of']);

const TRAILING_SEPARATORS = /[\s.,;:\-\u2013\u2014/\\|&]+$/;
const LEADING_SEPARATORS = /^[\s.,;:\-\u2013\u2014/\\|&]+/;

/**
 * Would removing this suffix leave something that is still a name?
 *
 * This guard is the core of the function, and it exists because the
 * failure directions are not symmetric. Two rows for one employer is a
 * count that is too high, printed beside a sample somebody can inspect.
 * One row for two employers is a count that is too low, printed beside a
 * sample that looks fine - and `distinctCompanyCount` is the number that
 * reveals a single-employer sample, so deflating it silently disables the
 * one honesty control the signal layer has.
 *
 * Without the guard, "The Limited", "The Corp", "The Co" and "The Inc" all
 * folded to "the": four employers becoming one.
 */
function keepsAName(remainder: string): boolean {
  return remainder
    .split(' ')
    .some(
      (token) =>
        token.length >= 2 &&
        !SUFFIX_SET.has(token) &&
        !COMPANY_STOPWORDS.has(token),
    );
}

/**
 * Folds an employer name to a comparison key.
 *
 * Normalizes a SPELLING. It may remove only decoration a writer put around
 * a name they wrote; it may not assert that two names are the same legal
 * entity. "Alphabet is Google" and "Acme (UK) is Acme" are entity
 * resolution - they need a registry and a person on the record, and they
 * belong in a mapping table where a wrong merge is a visible row somebody
 * can delete, not in a regex whose output is a bare string.
 */
export function normalizeCompany(companyRaw: string | null): string | null {
  if (companyRaw === null) {
    return null;
  }

  /*
   * One character substitution, and only one. The typographic apostrophes
   * are the same authorial mark and NFKC does not unify them, so
   * "Ben & Jerry's" and "Ben & Jerry’s" would otherwise be two employers
   * that render near-identically in any listing - a split that hides from
   * exactly the inspection that would catch it.
   *
   * Nothing else is substituted. Rewriting dashes, quotes or accents would
   * each be an entity-identity claim wearing a typography fix, and
   * transliterating "Nestlé" to "Nestle" merges two names a registry
   * treats as distinct.
   */
  let folded = foldTerm(companyRaw)
    .replace(/[\u2019\u2018\u02bc]/g, "'")
    /*
     * A comma with no space after it is ordinary human typing in a
     * free-text field, and it defeated stripping completely: "ACME,LLC"
     * kept an internal comma and could never fold with "ACME LLC". The
     * space is inserted before the suffix scan and removed by the trailing
     * trim afterwards, so it never reaches the output.
     */
    .replace(/,(?=\S)/g, ', ');

  /* One balanced enclosing pair, not recursively: "(Acme)" but not "Acme (UK)". */
  const wrapped = /^\((.*)\)$|^"(.*)"$|^'(.*)'$/.exec(folded);

  if (wrapped) {
    folded = (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? '').trim();
  }

  /*
   * Loop to a fixed point rather than a fixed number of passes.
   *
   * The previous two-pass version was not idempotent - f(f(x)) differed
   * from f(x) for "Acme Holdings Ltd Inc Corp" - which meant the stored
   * column could never safely be re-fed through this function, so any
   * future backfill was a trap. How many suffixes a name can carry is not
   * knowable, so it must not be a constant; the cap exists only so a
   * pathological input cannot spin.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    folded = folded.replace(TRAILING_SEPARATORS, '');

    const removed = LEGAL_SUFFIXES.find((suffix) => {
      /*
       * Matched against the tail as written AND against the tail with
       * internal dots removed, so "s.a." folds onto the same entry as
       * "sa" instead of leaving the residue "s.a" - a string no human
       * ever wrote and which matches neither spelling.
       */
      const tail = folded.slice(-(suffix.length + 1));
      const undotted = folded.replace(/\./g, '');
      const undottedTail = undotted.slice(-(suffix.length + 1));

      return (
        tail === ` ${suffix}` ||
        undottedTail === ` ${suffix}` ||
        folded === suffix ||
        undotted === suffix
      );
    });

    if (removed === undefined) {
      break;
    }

    const undotted = folded.replace(/\./g, '');
    const base = folded.endsWith(` ${removed}`)
      ? folded.slice(0, -(removed.length + 1))
      : undotted.endsWith(` ${removed}`)
        ? undotted.slice(0, -(removed.length + 1))
        : '';

    const candidate = base.replace(TRAILING_SEPARATORS, '');

    if (!keepsAName(candidate)) {
      break;
    }

    folded = candidate;
  }

  folded = folded
    .replace(LEADING_SEPARATORS, '')
    .replace(TRAILING_SEPARATORS, '')
    .trim();

  return folded.length > 0 ? folded : null;
}

/**
 * The whole reading of one posting, under this ruleset version.
 *
 * Deterministic and total: the same record always produces the same
 * result, including the same `outputHash`, on any machine and in any
 * timezone. Re-normalizing an unchanged posting under an unchanged
 * ruleset must reproduce that hash exactly - a mismatch means this
 * function is not deterministic or the version was not bumped, and it is
 * treated as a fatal error rather than quietly written over the old row.
 */
export function normalizePosting(record: RawPostingRecord): NormalizedPosting {
  const title = normalizeTitle(record.titleRaw);

  const descriptionText =
    record.descriptionRaw === null
      ? null
      : htmlToText(record.descriptionRaw) || null;

  /*
   * NO_TEXT is not "no skills". A posting we could not read is not a
   * posting with no requirements, and this status is what keeps it out of
   * the prevalence denominator instead of counting it as a zero.
   */
  const skillExtractionStatus: NormalizedPosting['skillExtractionStatus'] =
    descriptionText === null ? 'NO_TEXT' : 'EXTRACTED';

  const mentions = [
    ...extractSkillMentions(record.titleRaw, 'TITLE'),
    ...(descriptionText === null
      ? []
      : extractSkillMentions(descriptionText, 'DESCRIPTION')),
  ];

  /*
   * A title mention and a description mention of the same skill are two
   * different observations and both are kept - the locus is part of the
   * uniqueness key. Sorting is by locus then term so the array order is
   * decided here rather than by the concatenation above.
   */
  mentions.sort((a, b) => {
    if (a.extractedFrom !== b.extractedFrom) {
      return a.extractedFrom < b.extractedFrom ? -1 : 1;
    }

    return a.termNormalized < b.termNormalized
      ? -1
      : a.termNormalized > b.termNormalized
        ? 1
        : 0;
  });

  const companyNormalized = normalizeCompany(record.companyRaw);

  const body = {
    rulesetVersion: RULESET_VERSION,
    titleNormalized: title.titleNormalized,
    roleSlug: title.roleSlug,
    roleMatchMethod: title.roleMatchMethod,
    roleAliasKey: title.roleAliasKey,
    titleModifierRaw: title.titleModifierRaw,
    companyNormalized,
    descriptionText,
    skillExtractionStatus,
    mentions,
  };

  return { ...body, outputHash: canonicalHash(body) };
}
