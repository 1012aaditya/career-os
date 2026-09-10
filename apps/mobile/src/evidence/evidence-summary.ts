import type { EvidenceItem, EvidenceList, TrustClass } from './evidence-api';
import { STRENGTH_ORDER } from './evidence-view';

/*
 * The Evidence home overview.
 *
 * Every number here is either returned by the API or counted from rows the
 * API returned. Nothing is estimated, projected or rounded up.
 *
 * WHAT IS DELIBERATELY ABSENT: a count of "supported skills". Grouping
 * evidence by skill would need the Career Graph joins, which only exist
 * for resume evidence - so a skill count would silently describe one
 * source while appearing to describe all of them. The frozen Career Graph
 * record is explicit that nothing may build strength on those joins.
 */

export type EvidenceOverview = {
  evidenceCount: number;
  sourceCount: number;
  /** True only when the server counted two or more independent sources. */
  corroborated: boolean;
  /** The strongest class present, or null when there is no evidence. */
  strongest: TrustClass | null;
  /** More evidence exists than the response carried. */
  truncated: boolean;
};

function rank(trustClass: TrustClass): number {
  return STRENGTH_ORDER.indexOf(trustClass);
}

export function overviewOf(list: EvidenceList): EvidenceOverview {
  let strongest: TrustClass | null = null;

  for (const item of list.evidence) {
    const current = item.reliability.trustClass;

    if (strongest === null || rank(current) < rank(strongest)) {
      strongest = current;
    }
  }

  return {
    evidenceCount: list.evidence.length,
    /*
     * The server's count, never `new Set(sourceTypes).size`. Independence
     * is counted by a grouping key the client is not given - two GitHub
     * accounts would be two sources and one sourceType, and the app has no
     * way to know that. Recomputing it here would quietly disagree with
     * the corroboration shown everywhere else.
     */
    sourceCount: list.independentSources,
    corroborated: list.independentSources >= 2,
    strongest,
    truncated: list.truncated,
  };
}

/**
 * The strongest evidence, strongest first.
 *
 * ITEMS, not skills. The brief's example groups by skill - "TypeScript,
 * strong evidence, GitHub · Resume" - and that grouping is not available:
 * it needs the Career Graph joins, which exist only for resume evidence.
 * Showing it would mean labelling a skill "strong" on the strength of the
 * weakest source in the system.
 *
 * Ties keep the server's order, which is newest capture first, so the
 * result is fully determined by the response rather than by sort
 * stability.
 */
export function strongestEvidence(
  items: readonly EvidenceItem[],
  limit = 3,
): EvidenceItem[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byStrength =
        rank(a.item.reliability.trustClass) -
        rank(b.item.reliability.trustClass);

      return byStrength !== 0 ? byStrength : a.index - b.index;
    })
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * The sentence under the overview.
 *
 * Says what is true of the evidence, and refuses the sentence everybody
 * writes here - some version of "your profile is 80% complete", which
 * implies a target nobody defined.
 */
export function overviewSummary(overview: EvidenceOverview): string {
  if (overview.evidenceCount === 0) {
    return 'No evidence yet.';
  }

  const items =
    overview.evidenceCount === 1
      ? '1 piece of evidence'
      : `${overview.evidenceCount} pieces of evidence`;

  const sources =
    overview.sourceCount === 1
      ? '1 independent source'
      : `${overview.sourceCount} independent sources`;

  return `${items} from ${sources}.`;
}
