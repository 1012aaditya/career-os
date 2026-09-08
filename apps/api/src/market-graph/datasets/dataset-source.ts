/*
 * The Class B contract: published datasets, not observed postings.
 *
 * A posting is one employer advertising one job, seen by us at a moment we
 * can name. A taxonomy term and a statistical cell are neither. They are
 * assertions an institution published about a population, and they have no
 * observedAt because nobody observed them - they were released.
 *
 * That difference is why this is a separate contract rather than a wider
 * RawPostingRecord. Turning "47,000 vacancies registered in 2023" into
 * 47,000 posting rows would fabricate 47,000 observations, which is the
 * exact failure the posting side is built to prevent. The two paths meet
 * only in the source registry.
 *
 * Deliberately source-NEUTRAL: O*NET, NOC, BLS, StatCan and Indeed Hiring
 * Lab are rows distinguished by data, not five tables distinguished by
 * schema.
 */

export type DatasetKind = 'TAXONOMY' | 'AGGREGATE';

export type TermKind =
  'OCCUPATION' | 'ALTERNATE_TITLE' | 'SKILL' | 'TECHNOLOGY' | 'INDUSTRY';

/** One term, exactly as its publisher states it. Never re-coded by us. */
export type TaxonomyTermRecord = {
  kind: TermKind;
  /** The publisher's code. A STRING: NOC codes carry leading zeros. */
  externalCode: string;
  label: string;
  /** BCP-47. NOC publishes the same code in en and fr. */
  language: string;
  parentCode: string | null;
};

/**
 * One statistical cell.
 *
 * `value` is a string because the figure was published, not computed by
 * us. Parsing "104.3" into a float and storing that introduces
 * representation error into a number we are obliged to reproduce exactly.
 */
export type AggregateObservationRecord = {
  seriesKey: string;
  geography: string;
  category: string | null;
  periodStart: string;
  periodEnd: string;
  periodType: string;
  metric: string;
  value: string;
  unit: string;
};

export type DatasetFetch = {
  /** The publisher's own version string, verbatim. */
  version: string;
  /** When the PUBLISHER released it, not when we fetched it. */
  releasedAt: string | null;
  terms: TaxonomyTermRecord[];
  observations: AggregateObservationRecord[];
};

export interface DatasetSource {
  /** Matches a MarketSource.slug. */
  readonly sourceSlug: string;
  /** Stable key within the source: "onet", "noc", "jolts". Authored. */
  readonly datasetKey: string;
  readonly kind: DatasetKind;
  /**
   * The attribution this dataset obliges us to display, verbatim.
   *
   * Carried on the contract and stored with every version, because an
   * obligation recorded only in documentation is one nobody renders.
   */
  readonly attribution: string;
  /** Network. The only impure member. */
  fetch(): Promise<DatasetFetch>;
}
