import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type {
  Attribution,
  Authenticity,
  Completeness,
  EvidenceRecord,
  Recency,
  Specificity,
  TrustClass,
} from './contract.js';
import {
  classifyRecord,
  corroborationOf,
  recencyOf,
  specificityOf,
} from './trust.js';

/*
 * Reading a user's evidence, as evidence.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CAREER GRAPH. `GET /v1/career-graph`
 * already returns evidence - attached to skills, experiences and projects,
 * through the join tables. That is the right shape for answering "what
 * backs this skill", and it is the only shape that existed.
 *
 * It has one consequence nobody chose: GitHub evidence creates no joins,
 * by deliberate Phase 7 design, so it was invisible to every consumer.
 * Fourteen repositories were being synced, deduplicated, kept fresh - and
 * never read by anything. Meanwhile 100% of the evidence a user could see
 * came from their own resume.
 *
 * So this endpoint reads Evidence directly, keyed only by the
 * authenticated user. No join is consulted, which is also what keeps it
 * clear of the Phase 6 freeze's standing instruction that nothing may
 * build scoring on those joins.
 */

/** What the client is given. Deliberately narrower than the row. */
export type EvidenceView = {
  id: string;
  sourceType: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;

  occurredAt: string | null;
  capturedAt: string;
  lastObservedAt: string | null;

  /*
   * The reliability contract, passed through structurally. Not collapsed
   * into a number: a score invites averaging and ranking, and every one
   * of those operations throws away the reason behind the value.
   */
  reliability: {
    authenticity: Authenticity;
    attribution: Attribution;
    completeness: Completeness;
    specificity: Specificity;
    recency: Recency;
    trustClass: TrustClass;
    transformVersion: number;
  };
};

export type EvidenceListView = {
  evidence: EvidenceView[];
  /**
   * How many distinct sources are represented, counted by independence
   * key and never by row.
   *
   * Reported here rather than per item because independence is a property
   * of the SET. The keys themselves are not returned - a client needs to
   * know there are two sources, not what the internal grouping identifier
   * is.
   */
  independentSources: number;
  /** True when the cap below hid some rows. */
  truncated: boolean;
};

/**
 * The most evidence one response will carry.
 *
 * A cap rather than cursor pagination, because the real distribution says
 * so: evidence is one row per GitHub repository plus one per confirmed
 * resume, which is tens of rows for an active user and was fourteen in
 * the live verification. Cursor pagination for that would be machinery
 * with no load to justify it.
 *
 * It is still a CAP rather than an unbounded read. "Small today" is a
 * property of today's data, and an endpoint that returns everything is
 * one prolific account away from being a problem. `truncated` says so
 * honestly rather than silently returning a prefix.
 */
const MAX_EVIDENCE = 200;

/*
 * The source types a client may filter by.
 *
 * A closed list rather than an open string, so the filter cannot become a
 * channel for arbitrary values reaching a where clause. It mirrors the
 * EvidenceSourceType enum; a source added there must be added here
 * deliberately.
 */
export const FILTERABLE_SOURCE_TYPES = [
  'MANUAL',
  'RESUME',
  'GITHUB',
  'PORTFOLIO',
  'LINKEDIN',
  'CERTIFICATION',
  'DOCUMENT',
  'OTHER',
] as const;

export type FilterableSourceType =
  (typeof FILTERABLE_SOURCE_TYPES)[number];

const DEFAULT_LIMIT = 100;

/*
 * Exactly the columns the client is given, and nothing else.
 *
 * `metadata` is deliberately absent, which makes "no provider internals
 * reach the client" a property of the QUERY rather than of the mapping
 * below. A field that is never selected cannot be leaked by a later edit
 * that forgets to strip it - and metadata is the column most likely to
 * grow provider-shaped detail over time.
 *
 * `independenceKey` IS selected, because counting distinct sources is
 * impossible without it - but it is absent from EvidenceView, so there is
 * no field for it to be returned in. It is read to count and then
 * dropped: the client needs to know there are two sources, not what the
 * internal grouping identifier is, and for GitHub that identifier embeds
 * the numeric account id.
 */
const CLIENT_COLUMNS = {
  id: true,
  sourceType: true,
  title: true,
  description: true,
  sourceUrl: true,
  externalId: true,
  occurredAt: true,
  capturedAt: true,
  lastObservedAt: true,
  authenticity: true,
  attribution: true,
  completeness: true,
  transformVersion: true,
  independenceKey: true,
} as const;

type SelectedEvidence = {
  id: string;
  sourceType: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  lastObservedAt: Date | null;
  authenticity: Authenticity;
  attribution: Attribution;
  completeness: Completeness;
  transformVersion: number;
  independenceKey: string | null;
};

/**
 * The shape trust.ts reasons over.
 *
 * `metadata` is null rather than the stored value because it was never
 * read - nothing in the trust layer consults it, so not fetching it costs
 * nothing and removes a column from the blast radius.
 */
function asRecord(row: SelectedEvidence): EvidenceRecord {
  return {
    sourceType: row.sourceType,
    title: row.title,
    description: row.description,
    sourceUrl: row.sourceUrl,
    externalId: row.externalId,
    occurredAt: row.occurredAt,
    capturedAt: row.capturedAt,
    lastObservedAt: row.lastObservedAt,
    authenticity: row.authenticity,
    attribution: row.attribution,
    completeness: row.completeness,
    transformVersion: row.transformVersion,
    independenceKey: row.independenceKey,
    metadata: null,
  };
}

@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One user's evidence, newest capture first.
   *
   * `userId` is a parameter and is supplied by the controller from the
   * verified session. There is no filter on this method that could widen
   * it, and no request value reaches the `where` clause except the source
   * type - so the isolation property does not depend on remembering to
   * scope a query.
   */
  async listForUser(
    userId: string,
    options: {
      sourceType?: FilterableSourceType;
      limit?: number;
    } = {},
  ): Promise<EvidenceListView> {
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_LIMIT, 1),
      MAX_EVIDENCE,
    );

    const rows = (await this.prisma.evidence.findMany({
      where: {
        userId,
        ...(options.sourceType !== undefined
          ? { sourceType: options.sourceType }
          : {}),
      },
      select: CLIENT_COLUMNS,
      /*
       * A TOTAL order. capturedAt alone is not one: a resume import
       * writes its evidence in a single transaction, and two rows can
       * share an instant to the millisecond - at which point Postgres is
       * free to return them in either order, and a client diffing two
       * responses sees a change that did not happen.
       *
       * id ascending breaks the tie. It is unique, so the ordering is
       * fully determined by the data rather than by the plan.
       */
      orderBy: [{ capturedAt: 'desc' }, { id: 'asc' }],
      /*
       * One more than asked for, so truncation is detected by looking
       * rather than by guessing from a count that equals the limit.
       */
      take: limit + 1,
    })) as SelectedEvidence[];

    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;

    const now = new Date();

    /*
     * Counted over the rows the caller can actually see, so the number
     * describes the response rather than the table behind it.
     *
     * corroborationOf drops disqualified rows and null keys itself, so a
     * name-similarity match or an unidentifiable source cannot inflate
     * this - the counting rule lives in one place and this is a caller of
     * it rather than a second implementation.
     */
    const independentSources = corroborationOf(
      visible.map(asRecord),
      now,
    ).independentSources;

    return {
      evidence: visible.map((row) => this.view(row, now)),
      independentSources,
      truncated,
    };
  }

  private view(row: SelectedEvidence, now: Date): EvidenceView {
    const record = asRecord(row);

    return {
      id: row.id,
      sourceType: row.sourceType,
      title: row.title,
      description: row.description,
      sourceUrl: row.sourceUrl,
      externalId: row.externalId,
      occurredAt: row.occurredAt?.toISOString() ?? null,
      capturedAt: row.capturedAt.toISOString(),
      lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
      reliability: {
        authenticity: row.authenticity,
        attribution: row.attribution,
        completeness: row.completeness,
        specificity: specificityOf(record),
        recency: recencyOf(record, now),
        /*
         * Per ROW, not per user. A single class over somebody's whole
         * evidence would be a career score wearing a different name -
         * and trust.ts classifies a set that supports ONE thing, which a
         * user's entire evidence is not.
         */
        trustClass: classifyRecord(record, now),
        transformVersion: row.transformVersion,
      },
    };
  }
}
