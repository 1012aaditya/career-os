import type {
  EvidenceItem,
  EvidenceReliability,
  TrustClass,
} from './evidence-api';

/*
 * Turning the reliability contract into words a person can read, without
 * turning it into a number they cannot argue with.
 *
 * Every string here is derived from a field the API actually returns. There
 * is no branch that invents a value when one is missing - a screen showing
 * "unavailable" is telling the truth, and is the whole reason this product
 * is worth trusting with somebody's career history.
 */

export type Tone = 'strong' | 'moderate' | 'weak' | 'neutral';

export type StrengthLabel = {
  label: string;
  tone: Tone;
  /** One sentence a person can act on, not a definition. */
  meaning: string;
};

const STRENGTH: Record<TrustClass, StrengthLabel> = {
  VERY_STRONG: {
    label: 'Very strong',
    tone: 'strong',
    meaning:
      'Observed directly from a source you authenticated with, and backed by more than one independent source.',
  },
  STRONG: {
    label: 'Strong',
    tone: 'strong',
    meaning:
      'Observed directly from a source you authenticated with, and checked recently.',
  },
  MODERATE: {
    label: 'Moderate',
    tone: 'moderate',
    meaning:
      'A real artifact, or a direct observation that is now out of date or no longer reachable.',
  },
  WEAK: {
    label: 'Weak',
    tone: 'weak',
    meaning:
      'Something you told us. Real, and not independently checked by anyone else.',
  },
  UNVERIFIED: {
    label: 'Unverified',
    tone: 'neutral',
    meaning:
      'We could not establish this. That is a gap in what we looked at, not a statement about you.',
  },
};

export function strengthLabel(trustClass: TrustClass): StrengthLabel {
  return STRENGTH[trustClass];
}

/**
 * Every class, strongest first. Used for RANKING.
 *
 * Includes VERY_STRONG because ranking must be able to place it: the API
 * can return it from a set-level classification, and a rank table missing
 * a value would sort it as if it were the weakest.
 */
export const STRENGTH_ORDER: TrustClass[] = [
  'VERY_STRONG',
  'STRONG',
  'MODERATE',
  'WEAK',
  'UNVERIFIED',
];

/**
 * The classes a single row can actually have. Used for FILTERING.
 *
 * VERY_STRONG is deliberately absent, and the distinction is the API's
 * rather than a UI preference. A row is classified by classifyRecord,
 * whose strongest outcome is STRONG; VERY_STRONG comes only from
 * classify(), which reasons over a SET and adds independent corroboration
 * to a strong row.
 *
 * Offering it as a per-row filter produced an option that could never
 * match anything - the dead end this file already refuses elsewhere, where
 * source options are built from the evidence actually present rather than
 * from every source the product might one day have.
 */
export const FILTERABLE_STRENGTHS: TrustClass[] = STRENGTH_ORDER.filter(
  (trustClass) => trustClass !== 'VERY_STRONG',
);

const SOURCE_LABELS: Record<string, string> = {
  GITHUB: 'GitHub',
  RESUME: 'Resume',
  MANUAL: 'Added by you',
  PORTFOLIO: 'Portfolio',
  LINKEDIN: 'LinkedIn',
  CERTIFICATION: 'Certification',
  DOCUMENT: 'Document',
  OTHER: 'Other',
};

/**
 * A source's display name.
 *
 * Falls back to the raw value rather than to "Unknown": a source type the
 * app has not been taught about is still a real source, and hiding its
 * name would make the evidence less traceable, not more.
 */
export function sourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

/**
 * Whether this was observed for the user, or provided by them.
 *
 * The distinction the product turns on, and it is read from the contract
 * rather than from the source name - so a future connector that only ever
 * receives user-supplied files is described accurately without anyone
 * having to remember to special-case it.
 */
export type Provenance = 'observed' | 'provided';

export function provenanceOf(
  reliability: EvidenceReliability,
): Provenance {
  return reliability.authenticity === 'DIRECT_API_OBSERVATION' ||
    reliability.authenticity === 'VERIFIED_ARTIFACT'
    ? 'observed'
    : 'provided';
}

export function provenanceLabel(provenance: Provenance): string {
  return provenance === 'observed'
    ? 'Observed from the source'
    : 'Provided by you';
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * "12 days ago", and never a fabricated precision.
 *
 * Returns null for a missing timestamp so a caller renders nothing rather
 * than "never" - the two are different, and only one of them is known.
 */
export function relativeTime(
  iso: string | null,
  now: Date = new Date(),
): string | null {
  if (iso === null) {
    return null;
  }

  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) {
    return null;
  }

  const days = Math.floor((now.getTime() - then) / DAY);

  if (days < 0) {
    return 'just now';
  }

  if (days === 0) {
    return 'today';
  }

  if (days === 1) {
    return 'yesterday';
  }

  if (days < 30) {
    return `${days} days ago`;
  }

  const months = Math.floor(days / 30);

  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  const years = Math.floor(days / 365);

  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/*
 * ---------------------------------------------------------------------
 * WHY WE TRUST THIS
 * ---------------------------------------------------------------------
 * Six dimensions, shown as themselves rather than summed.
 *
 * A single number would be easier to render and impossible to argue with,
 * which is exactly the objection: "87" hides which part is weak. A reader
 * who disagrees with one row can see which row it is.
 */

export type ReliabilityRow = {
  dimension: string;
  value: string;
  detail: string;
  tone: Tone;
};

const AUTHENTICITY_ROWS: Record<
  EvidenceReliability['authenticity'],
  { value: string; detail: string; tone: Tone }
> = {
  DIRECT_API_OBSERVATION: {
    value: 'Direct observation',
    detail:
      'Read from the source’s own API, using access you granted.',
    tone: 'strong',
  },
  VERIFIED_ARTIFACT: {
    value: 'Verified artifact',
    detail: 'An artifact whose origin was checked.',
    tone: 'strong',
  },
  USER_PROVIDED_ARTIFACT: {
    value: 'You provided the file',
    detail:
      'The file is real. Its contents are your account of your work and were not independently checked.',
    tone: 'moderate',
  },
  USER_CLAIM: {
    value: 'You told us',
    detail:
      'A document you wrote about yourself. Real, and not independently checked.',
    tone: 'weak',
  },
  MODEL_INTERPRETATION: {
    value: 'Read by a model',
    detail: 'Produced by a model reading one of the above.',
    tone: 'weak',
  },
};

const ATTRIBUTION_ROWS: Record<
  EvidenceReliability['attribution'],
  { value: string; detail: string; tone: Tone }
> = {
  AUTHENTICATED_ACCOUNT: {
    value: 'Your authenticated account',
    detail:
      'The source itself linked this to the account you signed in with.',
    tone: 'strong',
  },
  VERIFIED_OWNERSHIP: {
    value: 'Verified ownership',
    detail: 'Ownership was proven separately, not just asserted.',
    tone: 'strong',
  },
  EXPLICIT_AUTHORSHIP: {
    value: 'Named as the author',
    detail:
      'The source names you as the author, without us holding access to that account.',
    tone: 'moderate',
  },
  USER_ASSERTED: {
    value: 'You said it is yours',
    detail: 'Attributed because you told us so.',
    tone: 'weak',
  },
  WEAK_MATCH: {
    value: 'Name similarity only',
    detail:
      'A name or address looked similar. That is not attribution, and this evidence is not counted.',
    tone: 'neutral',
  },
};

const COMPLETENESS_ROWS: Record<
  EvidenceReliability['completeness'],
  { value: string; detail: string; tone: Tone }
> = {
  COMPLETE: {
    value: 'Complete',
    detail: 'The full scope was read.',
    tone: 'strong',
  },
  PARTIAL: {
    value: 'Partial',
    detail:
      'Read, but bounded. Counts are a floor, not a total — there may be more.',
    tone: 'moderate',
  },
  NOT_SCANNED: {
    value: 'Not read',
    detail:
      'We did not look at this one. That is not the same as finding nothing.',
    tone: 'neutral',
  },
  ACCESS_LOST: {
    value: 'Access lost',
    detail:
      'We could reach this before and cannot now. What we saw is kept.',
    tone: 'neutral',
  },
  UNKNOWN: {
    value: 'Not applicable',
    detail:
      'Coverage does not apply to this kind of evidence — nothing was scanned.',
    tone: 'neutral',
  },
};

const SPECIFICITY_ROWS: Record<
  EvidenceReliability['specificity'],
  { value: string; detail: string; tone: Tone }
> = {
  SPECIFIC: {
    value: 'Specific',
    detail:
      'Points at one identifiable thing, with a link and a date someone else can check.',
    tone: 'strong',
  },
  GENERAL: {
    value: 'General',
    detail: 'Identifiable, but not anchored to a date.',
    tone: 'moderate',
  },
  VAGUE: {
    value: 'Unanchored',
    detail:
      'No link or identifier to check it against. This says nothing about the quality of the work.',
    tone: 'weak',
  },
};

const RECENCY_ROWS: Record<
  EvidenceReliability['recency'],
  { value: string; detail: string; tone: Tone }
> = {
  FRESH: {
    value: 'Recently confirmed',
    detail: 'Confirmed with the source within the last year.',
    tone: 'strong',
  },
  STALE: {
    value: 'Not confirmed recently',
    detail:
      'Over a year since this was last confirmed. It was true when captured.',
    tone: 'moderate',
  },
  UNKNOWN: {
    value: 'Unknown',
    detail: 'No confirmation time was recorded.',
    tone: 'neutral',
  },
};

/**
 * The six rows shown under "Why we trust this".
 *
 * Corroboration is passed in rather than read from the item, because it is
 * a property of the SET and the server counts it. `null` means the caller
 * does not have that number to hand, and the row is then omitted rather
 * than guessed at.
 */
export function reliabilityRows(
  reliability: EvidenceReliability,
  independentSources: number | null = null,
): ReliabilityRow[] {
  const rows: ReliabilityRow[] = [
    {
      dimension: 'Source authenticity',
      ...AUTHENTICITY_ROWS[reliability.authenticity],
    },
    {
      dimension: 'Attribution',
      ...ATTRIBUTION_ROWS[reliability.attribution],
    },
    {
      dimension: 'Specificity',
      ...SPECIFICITY_ROWS[reliability.specificity],
    },
    {
      dimension: 'Recency',
      ...RECENCY_ROWS[reliability.recency],
    },
    {
      dimension: 'Completeness',
      ...COMPLETENESS_ROWS[reliability.completeness],
    },
  ];

  if (independentSources !== null) {
    rows.push({
      dimension: 'Corroboration',
      value:
        independentSources >= 2
          ? `${independentSources} independent sources`
          : '1 source',
      detail:
        independentSources >= 2
          ? 'More than one independent source describes your work. Several items from the same source count once.'
          : 'Only one independent source so far. Several items from one source do not corroborate each other.',
      tone: independentSources >= 2 ? 'strong' : 'moderate',
    });
  }

  return rows;
}

/*
 * ---------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT ESTABLISH
 * ---------------------------------------------------------------------
 * The API does not yet return the server's bounded signals - deriveSignals
 * exists and is tested, but is deliberately not exposed. So nothing here
 * interprets the evidence.
 *
 * What these two functions do instead is RESTATE the contract fields in
 * plain language. That is not an inference: "a source you authenticated
 * with attributed this to your account" says exactly what
 * attribution=AUTHENTICATED_ACCOUNT means, and no more. When the signal
 * endpoint exists, these become a rendering of it rather than a
 * restatement, and the component shape does not change.
 */

export function supportedStatement(item: EvidenceItem): string {
  return provenanceOf(item.reliability) === 'observed'
    ? 'A source you authenticated with attributed this activity to your account.'
    : 'You stated this yourself, and it is recorded as your own account of your work.';
}

/**
 * The limits, stated for every item without exception.
 *
 * Deliberately not conditional on strength. The strongest evidence in the
 * system still establishes none of these, and showing the caveat only on
 * weak items would imply that strong ones do.
 */
export function doesNotEstablishStatements(
  item: EvidenceItem,
): string[] {
  const shared = [
    'Seniority or career level',
    'Expertise or level of skill',
    'Leadership or ownership of the work',
  ];

  return provenanceOf(item.reliability) === 'observed'
    ? [...shared, 'How much of the work was yours rather than a collaborator’s']
    : [...shared, 'Independent verification by anyone other than you'];
}

/**
 * The one line shown under an overall strength summary.
 *
 * Present so that a screen showing "Strong" cannot be read as a verdict on
 * the person.
 */
export const STRENGTH_SCOPE_NOTE =
  'Strength describes how well something is known — not how good the work is, and not your level.';

export type TimelineEntry = { label: string; iso: string };

/**
 * The timeline, containing only moments that actually exist.
 *
 * Three different questions that are constantly confused: when the work
 * happened, when we first recorded it, and when we last confirmed it.
 * A missing one is omitted rather than filled in from a neighbour.
 */
export function timelineOf(item: EvidenceItem): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  if (item.occurredAt !== null) {
    entries.push({ label: 'Occurred', iso: item.occurredAt });
  }

  entries.push({ label: 'Captured', iso: item.capturedAt });

  if (item.lastObservedAt !== null) {
    entries.push({ label: 'Last observed', iso: item.lastObservedAt });
  }

  return entries;
}
