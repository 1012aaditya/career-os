import { apiRequest } from '../api/client';

/*
 * The Market Graph, as the app reads it.
 *
 * Every type here mirrors what the API actually returns, and in particular
 * every count arrives as a NUMERATOR AND A DENOMINATOR rather than as a
 * percentage. That is deliberate on the server and it has to survive the
 * trip: a client that stores only a ratio has thrown away the one thing a
 * reader needs to judge it, and there is no way to get it back.
 */

export type MarketWindow = {
  start: string;
  end: string;
  scopes: string[];
  /** False when a board in scope could not be completely read. */
  coverageComplete: boolean;
  computedAt: string;
  signalRunId: string;
};

export type MarketRoleVolume = {
  id: string;
  numeratorCount: number;
  denominatorCount: number;
  distinctCompanyCount: number;
  distinctSourceCount: number;
  coverageComplete: boolean;
  dedupeMethod: string;
  role: { slug: string; label: string };
};

export type MarketRoleSkill = {
  id: string;
  numeratorCount: number;
  denominatorCount: number;
  distinctCompanyCount: number;
  distinctSourceCount: number;
  coverageComplete: boolean;
  dedupeMethod: string;
  skill: { slug: string; label: string };
};

export async function fetchRoleVolumes(): Promise<{
  window: MarketWindow | null;
  signals: MarketRoleVolume[];
}> {
  const response = await apiRequest<{
    data: { window: MarketWindow | null; signals: MarketRoleVolume[] };
  }>('/market/signals?limit=12');

  return response.data;
}

export async function fetchRoleSkills(roleSlug: string): Promise<{
  role: { slug: string; label: string };
  window: MarketWindow | null;
  signals: MarketRoleSkill[];
}> {
  const response = await apiRequest<{
    data: {
      role: { slug: string; label: string };
      window: MarketWindow | null;
      signals: MarketRoleSkill[];
    };
  }>(`/market/roles/${encodeURIComponent(roleSlug)}/skills?limit=12`);

  return response.data;
}

/**
 * Renders a count as a share, at the point of display and nowhere else.
 *
 * The ratio is computed here rather than stored anywhere, so it can never
 * be handed on without the counts it came from.
 */
export function sharePercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    /*
     * Not "0%". A share of nothing is not zero demand, and the two must
     * never render the same way.
     */
    return '—';
  }

  return `${Math.round((numerator / denominator) * 100)}%`;
}

/**
 * The sentence that keeps a number honest.
 *
 * A prevalence drawn from one employer is a fact about that employer, and
 * the reader is told so in words rather than being left to notice a small
 * number in a corner. Everything here is derived from counts the server
 * sent; nothing is a judgement made on the device.
 */
export function sampleCaveat(signal: {
  denominatorCount: number;
  distinctCompanyCount: number;
  coverageComplete: boolean;
}): string | null {
  if (signal.distinctCompanyCount <= 1) {
    return 'From a single employer — not a market-wide figure.';
  }

  if (!signal.coverageComplete) {
    return 'Some boards could not be read, so this is a lower bound.';
  }

  return null;
}
