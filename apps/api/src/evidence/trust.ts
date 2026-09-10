import type {
  EvidenceRecord,
  Recency,
  Specificity,
  TrustClass,
} from './contract.js';

/*
 * Turning evidence into one word a person can read, without turning it
 * into a number nobody can argue with.
 *
 * Everything here is pure and takes `now` as an argument. That is not
 * testing convenience: a classification that reads the clock deep inside
 * itself cannot be tested at a boundary, and the twelve-month boundary is
 * precisely where this code is most likely to be wrong.
 *
 * NOTHING HERE IS STORED. Trust is derived at read time from columns that
 * are, so changing a rule changes every answer at once and cannot leave a
 * stale verdict sitting in a table outliving the reasoning that produced
 * it.
 */

/**
 * How long an observation stays FRESH: 365 days.
 *
 * A fixed span of milliseconds, deliberately not "twelve calendar
 * months". Calendar arithmetic depends on the machine's timezone and on
 * which side of a DST change the two dates fall, so the same evidence
 * would classify differently on two servers - which is exactly the
 * non-determinism the Evidence layer exists to refuse. Epoch subtraction
 * has no timezone to depend on.
 */
export const FRESHNESS_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function toMs(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime();
}

/**
 * When the row was last CONFIRMED - not when the work happened.
 *
 * `lastObservedAt` first, falling back to `capturedAt`. `occurredAt` is
 * deliberately never consulted: it says when a repository was created or
 * a job was held, and treating it as a verification time would let a
 * decade-old commit date make evidence look freshly checked, or - just as
 * wrongly - make a repository built in 2015 and confirmed this morning
 * look abandoned.
 */
export function observedAtOf(record: EvidenceRecord): Date | null {
  return record.lastObservedAt ?? record.capturedAt ?? null;
}

export function recencyOf(
  record: EvidenceRecord,
  now: Date | number,
): Recency {
  const observed = observedAtOf(record);

  if (observed === null || Number.isNaN(observed.getTime())) {
    return 'UNKNOWN';
  }

  const age = toMs(now) - observed.getTime();

  /*
   * A negative age is clock skew between us and the database, not a
   * finding, and it is still the most recent observation we have.
   * Anything at or beyond the window is STALE - the boundary is closed on
   * the STALE side so "exactly 365 days old" never counts as fresh.
   */
  return age < FRESHNESS_WINDOW_MS ? 'FRESH' : 'STALE';
}

/**
 * How precisely the row points at a checkable thing.
 *
 * Derived only from whether the row carries the things that make it
 * verifiable by somebody else: a stable identifier at the source, a link,
 * and a time the underlying work is anchored to.
 *
 * Description is deliberately ignored. Prose is where a generous account
 * of one's own work lives, and rewarding its presence would make
 * specificity a measure of how much someone wrote.
 *
 * SPECIFICITY DOES NOT FEED CLASSIFICATION, and that omission is
 * deliberate. Folding it in would make the trust class a weighted sum
 * wearing five names - a score, arrived at by a route nobody could audit.
 * It is reported next to the class, never multiplied into it.
 *
 * It measures how CHECKABLE evidence is, and says nothing whatever about
 * skill, seniority, capability or quality. A VAGUE row may describe the
 * best work someone has ever done.
 */
export function specificityOf(record: EvidenceRecord): Specificity {
  const hasIdentity =
    record.externalId !== null && record.externalId !== '';
  const hasLink = record.sourceUrl !== null && record.sourceUrl !== '';
  const hasWhen = record.occurredAt !== null;

  if (hasIdentity && hasLink && hasWhen) {
    return 'SPECIFIC';
  }

  return hasIdentity || hasLink ? 'GENERAL' : 'VAGUE';
}

/*
 * ---------------------------------------------------------------------
 * PRECEDENCE
 * ---------------------------------------------------------------------
 * Ordered gates, not overlapping conditions. The approved rules describe
 * five classes in terms that genuinely overlap - a stale, partial, direct
 * observation matches the wording of both STRONG and MODERATE - so the
 * order below IS the specification, and each gate returns rather than
 * falling through to be reconsidered.
 *
 * The disqualifiers are checked FIRST, before anything that could award a
 * class. That is what makes "WEAK_MATCH never promotes" a structural
 * property rather than a rule that later code has to keep remembering.
 */
export function classifyRecord(
  record: EvidenceRecord,
  now: Date | number,
): TrustClass {
  /*
   * GATE 1 - weak attribution, which disqualifies unconditionally.
   *
   * WEAK_MATCH means a name, handle or address looked similar. That is
   * not attribution: anyone can set a git author email to anyone's
   * address, and two people sharing a machine share a signature. It is
   * recorded so it can be excluded, and this is where it is excluded -
   * first, so nothing below can promote past it.
   *
   * A row that ends UNVERIFIED is not merely ranked low: corroborationOf
   * drops it entirely, so it cannot supply the second independent source
   * that would promote everything else.
   */
  if (record.attribution === 'WEAK_MATCH') {
    return 'UNVERIFIED';
  }

  /*
   * GATE 2 - NOT_SCANNED, which disqualifies whatever produced it.
   *
   * It is an explicit statement that we did not look. Unlike UNKNOWN
   * below it is never merely inapplicable, so it is checked before the
   * claim floor and applies to every source alike.
   */
  if (record.completeness === 'NOT_SCANNED') {
    return 'UNVERIFIED';
  }

  /*
   * GATE 3 - the claim floor, checked BEFORE the observation gates.
   *
   * A claim is a claim however it reached us. If the user asserted
   * ownership, or the content is something they wrote or a model
   * paraphrased, no amount of directness upgrades it: a resume fetched
   * over an API is still a resume. Placing this above GATE 5 is what
   * stops a producer earning STRONG by declaring DIRECT_API_OBSERVATION
   * over self-reported content.
   *
   * WHY THIS SITS ABOVE THE UNKNOWN CHECK, which is the subtlest
   * ordering decision in this file. Completeness describes how much of an
   * intended scope was OBSERVED. A resume was not scanned at all - there
   * is no coverage to have established - so its UNKNOWN means "not
   * applicable", not "we failed to look". Letting the UNKNOWN check run
   * first classified every resume as UNVERIFIED, which would have been
   * doubly wrong: it collapses the distinction between "a claim we
   * understand" and "a gap we never examined", and since resume evidence
   * is currently the only evidence the Career Graph consumes, it would
   * have rendered a user's entire graph unverified on a technicality
   * about a field that does not apply to it.
   *
   * WEAK is the honest answer. A resume is a real, known thing - a
   * person's account of themselves - and the system should say so plainly
   * rather than imply it never looked.
   */
  if (
    record.attribution === 'USER_ASSERTED' ||
    record.authenticity === 'USER_CLAIM' ||
    record.authenticity === 'MODEL_INTERPRETATION'
  ) {
    return 'WEAK';
  }

  /*
   * GATE 4 - UNKNOWN coverage, now reachable only by something claiming
   * to be an observation. For those it IS a defect: an API observation
   * whose coverage was never established must not read as verified.
   */
  if (record.completeness === 'UNKNOWN') {
    return 'UNVERIFIED';
  }

  /*
   * GATE 5 - a direct observation the source itself attributed to the
   * authenticated account. The only route to STRONG.
   */
  if (
    record.authenticity === 'DIRECT_API_OBSERVATION' &&
    record.attribution === 'AUTHENTICATED_ACCOUNT'
  ) {
    /*
     * ACCESS_LOST was true when captured and cannot be confirmed now.
     * The observation is kept - deleting it would erase real history -
     * but it must not read as currently verified.
     */
    if (record.completeness === 'ACCESS_LOST') {
      return 'MODERATE';
    }

    /*
     * Stale demotes, including UNKNOWN recency. Evidence does not stay
     * STRONG because it was once direct; "we checked, a long time ago"
     * is a weaker statement than "we checked".
     *
     * PARTIAL still qualifies. It means the repository WAS scanned and
     * the counts are lower bounds - which is the normal state of every
     * GitHub row, since only the default branch is visible. Reading
     * PARTIAL as a demotion would make STRONG unreachable by any
     * producer that exists and quietly retire the class.
     */
    return recencyOf(record, now) === 'FRESH' ? 'STRONG' : 'MODERATE';
  }

  /*
   * GATE 6 - real artifacts, and direct observations whose attribution is
   * weaker than an authenticated account.
   */
  if (
    record.authenticity === 'VERIFIED_ARTIFACT' ||
    record.authenticity === 'USER_PROVIDED_ARTIFACT' ||
    record.authenticity === 'DIRECT_API_OBSERVATION'
  ) {
    return 'MODERATE';
  }

  /*
   * GATE 7 - anything unrecognised. Fails closed, so a value added to an
   * enum without a rule here is unverified rather than accidentally
   * trusted.
   */
  return 'UNVERIFIED';
}

const RANK: Record<TrustClass, number> = {
  UNVERIFIED: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3,
  VERY_STRONG: 4,
};

export type Corroboration = {
  /** Distinct independence keys among rows that survived GATE 1. */
  independentSources: number;
  /** Those keys, sorted, so the result is stable to compare and log. */
  keys: string[];
};

/**
 * How many INDEPENDENT sources support this, counting keys and never rows.
 *
 * Two exclusions carry the whole meaning:
 *
 *   Rows that failed GATE 1 contribute nothing. Otherwise a name-similarity
 *   row - the weakest thing this system recognises - could supply the
 *   second source that promotes a signal to its highest class.
 *
 *   A null key contributes nothing. It means the source instance could not
 *   be identified, and unidentifiable rows must not pool into one
 *   fictitious extra witness, nor each count as a source of their own.
 *
 * Derived here, never persisted: corroboration is a property of a SET of
 * evidence, and storing it on a row would be storing a fact about that
 * row's neighbours - stale the moment one is added or deleted.
 */
export function corroborationOf(
  records: readonly EvidenceRecord[],
  now: Date | number,
): Corroboration {
  const keys = new Set<string>();

  for (const record of records) {
    if (classifyRecord(record, now) === 'UNVERIFIED') {
      continue;
    }

    if (record.independenceKey !== null && record.independenceKey !== '') {
      keys.add(record.independenceKey);
    }
  }

  return {
    independentSources: keys.size,
    keys: [...keys].sort(),
  };
}

/**
 * The class for a set of evidence supporting one thing.
 *
 * The set's class is its best row's, with one promotion: a STRONG row
 * backed by a second independent source becomes VERY_STRONG. Only GATE 3
 * yields STRONG, so VERY_STRONG already implies a fresh, authenticated,
 * direct observation - the promotion adds independence to that rather
 * than substituting for it.
 *
 * There is no averaging and no addition. Ten weak rows are still weak:
 * repetition is not corroboration, and a sum would let volume impersonate
 * verification.
 */
export function classify(
  records: readonly EvidenceRecord[],
  now: Date | number,
): TrustClass {
  let best: TrustClass = 'UNVERIFIED';

  for (const record of records) {
    const current = classifyRecord(record, now);

    if (RANK[current] > RANK[best]) {
      best = current;
    }
  }

  if (best !== 'STRONG') {
    return best;
  }

  return corroborationOf(records, now).independentSources >= 2
    ? 'VERY_STRONG'
    : 'STRONG';
}
