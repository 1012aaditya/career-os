import type { EvidenceItem, TrustClass } from './evidence-api';
import { sourceLabel } from './evidence-view';

/*
 * Narrowing a list of evidence, without ever reordering it.
 *
 * The server returns a total order - newest capture first, ties broken by
 * id - and everything here PRESERVES it. Filtering removes; it never
 * sorts. That matters more than it looks: a client-side re-sort would make
 * the displayed order depend on which filter happened to be active, so the
 * same evidence would appear in two different orders in one session and
 * neither would match what the API said.
 */

export type AgeBucket = 'RECENT' | 'AGING' | 'HISTORICAL' | 'UNKNOWN';

export type EvidenceFilters = {
  search: string;
  sourceType: string | null;
  strength: TrustClass | null;
  age: AgeBucket | null;
};

export const NO_FILTERS: EvidenceFilters = {
  search: '',
  sourceType: null,
  strength: null,
  age: null,
};

const DAY = 24 * 60 * 60 * 1000;

/** Under 90 days. */
const RECENT_DAYS = 90;

/**
 * A year, which is exactly where the server's own FRESH/STALE boundary
 * sits.
 *
 * The two must agree. If HISTORICAL began somewhere else, an item could
 * be filed under "Aging" here while its Recency row read "Not confirmed
 * recently" - the same screen disagreeing with itself about the same
 * timestamp.
 */
const HISTORICAL_DAYS = 365;

/**
 * How old the last confirmation is.
 *
 * Read from lastObservedAt, falling back to capturedAt, and never from
 * occurredAt: when the work happened says nothing about when we last
 * checked it. A repository created in 2015 and confirmed this morning is
 * RECENT.
 */
export function ageBucket(
  item: EvidenceItem,
  now: Date = new Date(),
): AgeBucket {
  const iso = item.lastObservedAt ?? item.capturedAt;
  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) {
    return 'UNKNOWN';
  }

  const days = Math.floor((now.getTime() - then) / DAY);

  if (days < RECENT_DAYS) {
    return 'RECENT';
  }

  return days < HISTORICAL_DAYS ? 'AGING' : 'HISTORICAL';
}

export const AGE_LABELS: Record<AgeBucket, string> = {
  RECENT: 'Recent',
  AGING: 'Aging',
  HISTORICAL: 'Historical',
  UNKNOWN: 'Unknown',
};

/**
 * Whether the free-text query matches.
 *
 * Title and description only. Deliberately NOT the source url or external
 * id: those are identifiers rather than prose, and matching them makes a
 * search for "1" return a repository whose numeric id happens to contain
 * one - a result the user cannot see the reason for.
 */
function matchesSearch(item: EvidenceItem, search: string): boolean {
  const query = search.trim().toLowerCase();

  if (query === '') {
    return true;
  }

  return (
    item.title.toLowerCase().includes(query) ||
    (item.description ?? '').toLowerCase().includes(query) ||
    sourceLabel(item.sourceType).toLowerCase().includes(query)
  );
}

export function applyFilters(
  items: readonly EvidenceItem[],
  filters: EvidenceFilters,
  now: Date = new Date(),
): EvidenceItem[] {
  return items.filter((item) => {
    if (!matchesSearch(item, filters.search)) {
      return false;
    }

    if (
      filters.sourceType !== null &&
      item.sourceType !== filters.sourceType
    ) {
      return false;
    }

    if (
      filters.strength !== null &&
      item.reliability.trustClass !== filters.strength
    ) {
      return false;
    }

    if (filters.age !== null && ageBucket(item, now) !== filters.age) {
      return false;
    }

    return true;
  });
}

export function activeFilterCount(filters: EvidenceFilters): number {
  return [
    filters.sourceType,
    filters.strength,
    filters.age,
  ].filter((value) => value !== null).length;
}

/**
 * The source filter's options, built from the evidence actually present.
 *
 * Not a hardcoded list of every source the product might one day have: an
 * option that always returns nothing is a dead end the user has to
 * discover by tapping it.
 */
export function sourceOptions(
  items: readonly EvidenceItem[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();

  for (const item of items) {
    if (!seen.has(item.sourceType)) {
      seen.set(item.sourceType, sourceLabel(item.sourceType));
    }
  }

  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * What to say when a filter matched nothing.
 *
 * Distinguishes "you have no evidence" from "no evidence matches this
 * filter", because the first is a state to fix and the second is a filter
 * to clear, and telling a new user they have nothing when they have just
 * filtered it out is a small betrayal of a screen about trust.
 */
export function emptyReason(
  total: number,
  filters: EvidenceFilters,
): 'no-evidence' | 'no-matches' {
  const filtering =
    filters.search.trim() !== '' || activeFilterCount(filters) > 0;

  return total === 0 && !filtering ? 'no-evidence' : 'no-matches';
}

export type EvidenceViewState =
  | 'loading'
  | 'error'
  | 'empty'
  | 'no-matches'
  | 'ready';

/**
 * Which of the five states a list screen is in.
 *
 * Error is checked BEFORE loading, and that ordering is the reason this is
 * a function rather than a chain of ternaries in a component. A retry sets
 * loading true while the previous error is still held; a screen that
 * checked loading first would replace a visible error message with a
 * spinner and then flip back to the same error, which reads as a flicker
 * rather than as a retry.
 *
 * `no-matches` is distinct from `empty` because they need opposite
 * actions: one is a filter to clear, the other is a source to connect.
 * Telling a new user they have no evidence when they have merely filtered
 * it out is a small betrayal of a screen about trust.
 */
export function evidenceViewState(input: {
  loading: boolean;
  error: string | null;
  total: number;
  visible: number;
  filters: EvidenceFilters;
}): EvidenceViewState {
  if (input.error !== null) {
    return 'error';
  }

  if (input.loading) {
    return 'loading';
  }

  if (input.visible > 0) {
    return 'ready';
  }

  return emptyReason(input.total, input.filters) === 'no-evidence'
    ? 'empty'
    : 'no-matches';
}
