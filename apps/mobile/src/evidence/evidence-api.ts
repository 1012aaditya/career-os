import { apiRequest } from '../api/client';

/*
 * The Evidence read API, as the app sees it.
 *
 * These types mirror `GET /v1/evidence` exactly and add nothing. Where the
 * API does not return a value, there is no field here for a screen to
 * populate from somewhere else - which is the point. Career OS is a proof
 * layer, and a proof layer that renders an invented number is worse than
 * one that renders nothing.
 */

export type Authenticity =
  | 'DIRECT_API_OBSERVATION'
  | 'VERIFIED_ARTIFACT'
  | 'USER_PROVIDED_ARTIFACT'
  | 'USER_CLAIM'
  | 'MODEL_INTERPRETATION';

export type Attribution =
  | 'AUTHENTICATED_ACCOUNT'
  | 'VERIFIED_OWNERSHIP'
  | 'EXPLICIT_AUTHORSHIP'
  | 'USER_ASSERTED'
  | 'WEAK_MATCH';

export type Completeness =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NOT_SCANNED'
  | 'ACCESS_LOST'
  | 'UNKNOWN';

export type Specificity = 'SPECIFIC' | 'GENERAL' | 'VAGUE';

export type Recency = 'FRESH' | 'STALE' | 'UNKNOWN';

export type TrustClass =
  | 'VERY_STRONG'
  | 'STRONG'
  | 'MODERATE'
  | 'WEAK'
  | 'UNVERIFIED';

export type EvidenceReliability = {
  authenticity: Authenticity;
  attribution: Attribution;
  completeness: Completeness;
  specificity: Specificity;
  recency: Recency;
  trustClass: TrustClass;
  transformVersion: number;
};

export type EvidenceItem = {
  id: string;
  sourceType: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  occurredAt: string | null;
  capturedAt: string;
  lastObservedAt: string | null;
  reliability: EvidenceReliability;
};

export type EvidenceList = {
  evidence: EvidenceItem[];
  /**
   * Distinct sources, counted by the server over the rows it returned.
   *
   * Not derivable in the app: the grouping key is deliberately not sent,
   * because for GitHub it embeds the numeric account id. So this number is
   * displayed as given and never recomputed from `evidence.length`.
   */
  independentSources: number;
  /** The server capped the response. More evidence exists than is shown. */
  truncated: boolean;
};

/** The response shape the API guarantees when a user has nothing yet. */
export const EMPTY_EVIDENCE: EvidenceList = {
  evidence: [],
  independentSources: 0,
  truncated: false,
};

export async function fetchEvidence(options: {
  sourceType?: string;
  limit?: number;
} = {}): Promise<EvidenceList> {
  const params = new URLSearchParams();

  if (options.sourceType !== undefined) {
    params.set('sourceType', options.sourceType);
  }

  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }

  const query = params.toString();

  return await apiRequest<EvidenceList>(
    query === '' ? '/v1/evidence' : `/v1/evidence?${query}`,
  );
}
