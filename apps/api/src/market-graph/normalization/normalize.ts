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
 */
const TOKEN_CHARS = /[a-z0-9+#./_-]+/g;

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

/**
 * Strips a leading or trailing seniority word from a folded title.
 *
 * Returns the token that was removed, verbatim from the folded title, so
 * the information survives without a seniority ontology existing.
 *
 * Only the head and tail are considered. "Engineer, Senior Platform" is
 * left alone rather than guessed at - a seniority word in the middle of a
 * title is usually qualifying something else.
 */
export function stripSeniority(foldedTitle: string): {
  title: string;
  titleModifierRaw: string | null;
} {
  for (const token of SENIORITY_TOKENS) {
    if (foldedTitle.startsWith(`${token} `)) {
      return {
        title: foldedTitle.slice(token.length + 1).trim(),
        titleModifierRaw: token,
      };
    }

    if (foldedTitle.endsWith(` ${token}`)) {
      return {
        title: foldedTitle.slice(0, -(token.length + 1)).trim(),
        titleModifierRaw: token,
      };
    }
  }

  return { title: foldedTitle, titleModifierRaw: null };
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
  const cut = folded.split(/\s+[-–—]\s+|[,(/]/)[0] ?? folded;

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
const LEGAL_SUFFIX =
  /\s+(inc|llc|ltd|limited|corp|corporation|gmbh|bv|plc|sa|ag|pty|co)\.?$/;

export function normalizeCompany(companyRaw: string | null): string | null {
  if (companyRaw === null) {
    return null;
  }

  let folded = foldTerm(companyRaw);

  /*
   * Trailing punctuation is stripped after EVERY suffix removal, not only
   * before the first.
   *
   * "Stripe, Inc." folds to "stripe, inc.", and removing the suffix leaves
   * "stripe," - a trailing comma that makes it a different employer from
   * "stripe" and quietly inflates every distinct-company count it appears
   * in. Found by the spec beside this file, not by reading the code.
   *
   * Two passes because a name can carry two suffixes ("Acme Holdings Ltd
   * Inc"). Bounded rather than looped to a fixed point, so a pathological
   * input cannot spin here.
   */
  for (let pass = 0; pass < 2; pass += 1) {
    folded = folded.replace(/[.,\s]+$/, '');
    folded = folded.replace(LEGAL_SUFFIX, '');
  }

  folded = folded.replace(/[.,\s]+$/, '').trim();

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
