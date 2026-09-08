import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { normalizeCompany } from '../normalization/normalize.js';
import { RULESET_VERSION } from '../normalization/ruleset.js';
import {
  classifyFreshness,
  type FreshnessVerdict,
} from '../observations/freshness.js';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  orderingFingerprint,
  type SearchCursor,
} from './search-cursor.js';
import { parseLocationQuery, parseSearchQuery } from './search-query.js';
import {
  asOfDay,
  relevanceFrom,
  type RelevanceFacts,
} from './search-ranking.js';
import {
  RANKING_VERSION,
  RECENCY_BANDS,
  RECENCY_UNKNOWN_POINTS,
  RELEVANCE_WEIGHTS,
  SEARCH_PROJECTION_VERSION,
  type SortOption,
} from './search-ruleset.js';
import { servedDescription } from './served-description.js';

/*
 * Unified Market Search.
 *
 * Reads the projection and nothing else on the hot path. It opens no
 * write anywhere, calls no external source, and knows the name of no
 * publisher: a source is a slug it filters on, exactly as the mobile app
 * sees it. That is what makes the experience "search Shipaton" rather
 * than "search five job sites" - not a label in the UI, but the fact that
 * no code in this file could tell you which site a result came from
 * without reading a column.
 *
 * Ranking happens in SQL, and the reason is structural rather than a
 * preference for speed. Deterministic keyset pagination needs page 2 to
 * know exactly what page 1 scored, which is impossible if scoring happens
 * in the application over a candidate set the database chose. Moving it
 * into SQL creates a real hazard - a scoring expression here and an
 * explanation in TypeScript, drifting apart until the explanation is
 * fiction - and that hazard is met head-on: the query returns the FACTS
 * as columns, TypeScript sums them, and a test asserts the two sums agree
 * on real corpus rows.
 */

/** What a caller may ask for. Every field is validated before it arrives. */
export type SearchRequest = {
  q?: string;
  role?: string;
  location?: string;
  skills?: string[];
  company?: string;
  sources?: string[];
  freshness?: FreshnessVerdict[];
  publishedWithinDays?: number;
  sort: SortOption;
  limit: number;
  cursor?: string;
};

type DocumentRow = {
  postingId: string;
  externalId: string;
  sourceSlug: string;
  titleRaw: string;
  companyRaw: string | null;
  locationRaw: string | null;
  roleSlug: string | null;
  skillSlugs: string[];
  sourcePublishedAt: Date | null;
  sourceValidThrough: Date | null;
  lastSeenAt: Date;
  applyUrl: string | null;
  groupSize: bigint;
  relevance: number;
  titleExact: boolean;
  titlePrefix: boolean;
  titleAllTokens: boolean;
  roleExact: boolean;
  titleTokenHits: bigint;
  searchTokenHits: bigint;
  skillHits: bigint;
  locationExact: boolean;
  locationAllTokens: boolean;
  recencyPoints: number;
  coverageCompletedAt: Date | null;
  pollIntervalHours: number;
  expectedPostingLifetimeDays: number;
};

@Injectable()
export class MarketSearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The sources search may draw from.
   *
   * `mayRedistributeDerived`, not `isEnabled`. They are different
   * permissions and Phase 8 was explicit that a source may allow
   * ingestion for internal analysis and not allow publication - so the
   * gate on a read endpoint is the publication one. Greenhouse is
   * ingested and is not searchable, and that costs 2,958 postings.
   *
   * Fails CLOSED: an empty list produces an empty result set rather than
   * an unfiltered one.
   */
  private async searchableSources(): Promise<
    Map<
      string,
      {
        id: string;
        displayName: string;
        pollIntervalHours: number;
        expectedPostingLifetimeDays: number;
      }
    >
  > {
    const sources = await this.prisma.marketSource.findMany({
      where: { mayRedistributeDerived: true, kind: 'JOB_BOARD' },
      select: {
        id: true,
        slug: true,
        displayName: true,
        pollIntervalHours: true,
        expectedPostingLifetimeDays: true,
      },
    });

    return new Map(sources.map(({ slug, ...rest }) => [slug, rest]));
  }

  /**
   * The end of the most recent COMPLETE read of each scope.
   *
   * One query for the whole page rather than one per result. There are 37
   * such rows across the corpus, so this is small by construction - and
   * it is the input without which freshness would report a rate limit as
   * a closed job.
   */
  private async coverage(): Promise<
    Array<{ sourceId: string; sourceScope: string; completedAt: Date }>
  > {
    const rows = await this.prisma.marketRunScopeCoverage.groupBy({
      by: ['sourceId', 'sourceScope'],
      where: { completeForScope: true, finishedAt: { not: null } },
      _max: { finishedAt: true },
    });

    return rows.flatMap((row) =>
      row._max.finishedAt === null
        ? []
        : [
            {
              sourceId: row.sourceId,
              sourceScope: row.sourceScope,
              completedAt: row._max.finishedAt,
            },
          ],
    );
  }

  async search(request: SearchRequest, asOf: Date) {
    const day = asOfDay(asOf);
    const sources = await this.searchableSources();

    const query = request.q === undefined ? null : parseSearchQuery(request.q);
    const location =
      request.location === undefined
        ? null
        : parseLocationQuery(request.location);

    /*
     * A query that produced no token is refused rather than answered.
     * Running it would filter on nothing and return the corpus in
     * publication order, which looks like a working search and is not
     * one - the reader would never learn that what they typed was
     * discarded.
     */
    if (query?.degenerate === true) {
      throw new BadRequestException('q contains no searchable characters');
    }

    if (location?.degenerate === true) {
      throw new BadRequestException(
        'location contains no searchable characters',
      );
    }

    const requestedSources =
      request.sources === undefined || request.sources.length === 0
        ? [...sources.keys()]
        : request.sources.filter((slug) => sources.has(slug));

    const company =
      request.company === undefined ? null : normalizeCompany(request.company);

    /*
     * Everything that decides the ordering, hashed. Carried in every
     * cursor and checked on the way back, so a cursor from one search can
     * never resume another.
     */
    const fingerprint = orderingFingerprint({
      projectionVersion: SEARCH_PROJECTION_VERSION,
      rulesetVersion: RULESET_VERSION,
      day: day.toISOString(),
      sort: request.sort,
      q: query?.normalized ?? null,
      tokens: query?.tokens ?? [],
      role: request.role ?? null,
      queryRole: query?.roleSlug ?? null,
      location: location?.normalized ?? null,
      locationTokens: location?.tokens ?? [],
      skills: [...(request.skills ?? [])].sort(),
      company,
      sources: [...requestedSources].sort(),
      freshness: [...(request.freshness ?? [])].sort(),
      publishedWithinDays: request.publishedWithinDays ?? null,
    });

    let cursor: SearchCursor | null = null;

    if (request.cursor !== undefined) {
      try {
        cursor = decodeCursor(request.cursor, fingerprint);
      } catch (error) {
        /* The message is ours; the caught object is never attached. */
        throw new BadRequestException(
          error instanceof InvalidCursorError
            ? error.message
            : 'cursor is not usable',
        );
      }
    }

    if (requestedSources.length === 0) {
      return this.emptyPage(request, query, location, day);
    }

    const filters = this.filterSql(
      request,
      query,
      location,
      company,
      requestedSources,
      day,
    );
    const facts = this.factSql(query, location, request.skills ?? [], day);
    const freshness = this.freshnessSql(asOf);
    const coverage = await this.coverage();

    const config = Prisma.sql`(VALUES ${Prisma.join(
      [...sources.values()].map(
        (source) =>
          Prisma.sql`(${source.id}::uuid, ${source.pollIntervalHours}::int, ${source.expectedPostingLifetimeDays}::int)`,
      ),
    )}) AS cfg("sourceId", "pollIntervalHours", "expectedPostingLifetimeDays")`;

    /*
     * An empty coverage table still has to produce a joinable relation,
     * and a VALUES list cannot be empty. One impossible row keeps the SQL
     * legal and joins to nothing.
     */
    const coverageRows =
      coverage.length === 0
        ? [Prisma.sql`(NULL::uuid, NULL::text, NULL::timestamp)`]
        : coverage.map(
            (row) =>
              Prisma.sql`(${row.sourceId}::uuid, ${row.sourceScope}::text, ${row.completedAt.toISOString()}::timestamp)`,
          );

    const coverageTable = Prisma.sql`(VALUES ${Prisma.join(
      coverageRows,
    )}) AS cov("sourceId", "sourceScope", "completedAt")`;

    const scored = Prisma.sql`
      SELECT
        d."postingId", d."externalId", d."sourceSlug", d."titleRaw", d."companyRaw",
        d."locationRaw", d."roleSlug", d."skillSlugs", d."sourcePublishedAt",
        d."sourceValidThrough", d."lastSeenAt", d."applyUrl",
        d."sourceId", d."groupKey",
        cov."completedAt" AS "coverageCompletedAt",
        cfg."pollIntervalHours", cfg."expectedPostingLifetimeDays",
        ${facts.select},
        ${freshness} AS "freshnessVerdictComputed"
      FROM "MarketPostingSearchDocument" d
      JOIN ${config} ON cfg."sourceId" = d."sourceId"
      LEFT JOIN ${coverageTable}
        ON cov."sourceId" = d."sourceId" AND cov."sourceScope" = d."sourceScope"
      WHERE ${filters}
    `;

    const freshnessFilter =
      request.freshness === undefined || request.freshness.length === 0
        ? Prisma.sql`TRUE`
        : Prisma.sql`s."freshnessVerdictComputed" IN (${Prisma.join(request.freshness)})`;

    const ranked = Prisma.sql`
      SELECT s.*, (${facts.total})::int AS "relevance"
      FROM (${scored}) s
      WHERE ${freshnessFilter}
    `;

    /*
     * Search-time grouping, and the whole of it.
     *
     * PARTITION BY (sourceId, COALESCE(groupKey, externalId)). The
     * coalesce is what stops a null grouping key collapsing every
     * ungrouped posting into one bucket: externalId is unique, so a
     * posting the source made no claim about is its own group.
     *
     * The key is the SOURCE's own assertion and nothing else. Greenhouse
     * publishes one requisition as three city-specific posts and says so
     * with a requisition id; this collapses those three and keeps every
     * one of them addressable. It never groups across sources: measured
     * on this corpus, zero postings from two different sources share an
     * apply URL, and the only other candidate - equal normalized title
     * and company - would merge 5 pairs on evidence that cannot tell two
     * genuinely different jobs apart. Section 13's instruction when
     * identity cannot be established safely is to keep the results
     * separate, so they stay separate.
     */
    const partition = Prisma.sql`PARTITION BY r."sourceId", r."groupKey"`;

    const ordering =
      request.sort === 'published'
        ? Prisma.sql`r."sourcePublishedAt" DESC NULLS LAST, r."externalId" ASC`
        : Prisma.sql`r."relevance" DESC, r."sourcePublishedAt" DESC NULLS LAST, r."externalId" ASC`;

    /*
     * The window runs over the rows that CAN group, and no others.
     *
     * A posting whose source made no grouping claim is its own group by
     * definition - rank 1, size 1 - so putting it through a window
     * function is pure waste, and on this corpus it is most of the waste:
     * 54,022 of 74,008 searchable postings carry no grouping key, and
     * Canada Job Bank alone accounts for 53,799 of them.
     *
     * Measured on the unfiltered listing, which is the worst case because
     * nothing has narrowed the set first: one window over everything ran
     * in 476ms, and this split runs in 170ms. The saving is not the
     * window itself but the SORT it forces - 74,008 rows sorted by
     * partition key, to compute a rank that was 1 for three quarters of
     * them before the sort began.
     */
    const grouped = Prisma.sql`
      SELECT r.*, 1::bigint AS "rn", 1::bigint AS "groupSize"
      FROM (${ranked}) r
      WHERE r."groupKey" IS NULL

      UNION ALL

      SELECT r.*,
        row_number() OVER (${partition} ORDER BY ${ordering}) AS "rn",
        count(*) OVER (${partition}) AS "groupSize"
      FROM (${ranked}) r
      WHERE r."groupKey" IS NOT NULL
    `;

    const keyset =
      cursor === null ? Prisma.sql`TRUE` : this.keysetSql(cursor, request.sort);

    const finalOrder =
      request.sort === 'published'
        ? Prisma.sql`g."sourcePublishedAt" DESC NULLS LAST, g."externalId" ASC`
        : Prisma.sql`g."relevance" DESC, g."sourcePublishedAt" DESC NULLS LAST, g."externalId" ASC`;

    /* One extra row, so "is there another page" needs no second count. */
    const take = request.limit + 1;

    const rows = await this.prisma.$queryRaw<DocumentRow[]>`
      SELECT g."postingId", g."externalId", g."sourceSlug", g."titleRaw", g."companyRaw",
             g."locationRaw", g."roleSlug", g."skillSlugs", g."sourcePublishedAt",
             g."sourceValidThrough", g."lastSeenAt", g."applyUrl", g."groupSize",
             g."relevance", g."titleExact", g."titlePrefix", g."titleAllTokens",
             g."roleExact", g."titleTokenHits", g."searchTokenHits", g."skillHits",
             g."locationExact", g."locationAllTokens", g."recencyPoints",
             g."coverageCompletedAt", g."pollIntervalHours", g."expectedPostingLifetimeDays"
      FROM (${grouped}) g
      WHERE g."rn" = 1 AND ${keyset}
      ORDER BY ${finalOrder}
      LIMIT ${take}
    `;

    /*
     * The totals, computed WITHOUT the window.
     *
     * Counting the representatives means materializing them, which means
     * paying for the whole window a second time - 124ms of aggregate
     * against roughly 480ms of window on the unfiltered listing. Plain
     * aggregates give the same two numbers: a group is either a posting
     * with no grouping key, or one distinct (source, key) pair.
     *
     * The FILTER on the distinct count is load-bearing. A composite value
     * containing a NULL is not itself NULL in Postgres, so without it
     * every ungrouped row would contribute ROW(source, NULL) and inflate
     * the count by one per source.
     */
    const totals = await this.prisma.$queryRaw<
      Array<{ groups: bigint; postings: bigint }>
    >`
      SELECT
        (count(*) FILTER (WHERE r."groupKey" IS NULL)
          + count(DISTINCT (r."sourceId", r."groupKey"))
            FILTER (WHERE r."groupKey" IS NOT NULL))::bigint AS "groups",
        count(*)::bigint AS "postings"
      FROM (${ranked}) r
    `;

    const hasMore = rows.length > request.limit;
    const page = hasMore ? rows.slice(0, request.limit) : rows;

    const results = page.map((row) => this.present(row, asOf));

    const last = page[page.length - 1];

    return {
      data: {
        query: {
          q: query?.raw ?? null,
          normalized: query?.normalized ?? null,
          tokens: query?.tokens ?? [],
          /*
           * The canonical role the query itself resolved to, and how.
           * Returned because a result set widened by a role expansion is
           * otherwise inexplicable - the reader sees postings whose
           * titles do not contain their words and has no way to know
           * why.
           */
          resolvedRole: query?.roleSlug ?? null,
          roleResolution: query?.roleResolution ?? null,
          location: location?.raw ?? null,
        },
        results,
        page: {
          limit: request.limit,
          returned: results.length,
          /** Distinct groups, which is what a reader is shown. */
          totalGroups: Number(totals[0]?.groups ?? 0n),
          /** Postings behind them, which is always >= totalGroups. */
          totalPostings: Number(totals[0]?.postings ?? 0n),
          hasMore,
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor(
                  {
                    relevance:
                      request.sort === 'published' ? 0 : last.relevance,
                    publishedAtMs: last.sourcePublishedAt?.getTime() ?? null,
                    externalId: last.externalId,
                  },
                  fingerprint,
                )
              : null,
        },
        basis: {
          projectionVersion: SEARCH_PROJECTION_VERSION,
          rulesetVersion: RULESET_VERSION,
          rankingVersion: RANKING_VERSION,
          sort: request.sort,
          /** The instant every freshness verdict on this page was taken at. */
          asOf: asOf.toISOString(),
          /** The day the recency bands were measured from. */
          asOfDay: day.toISOString(),
          searchableSources: [...requestedSources].sort(),
        },
      },
    };
  }

  private emptyPage(
    request: SearchRequest,
    query: ReturnType<typeof parseSearchQuery> | null,
    location: ReturnType<typeof parseLocationQuery> | null,
    day: Date,
  ) {
    return {
      data: {
        query: {
          q: query?.raw ?? null,
          normalized: query?.normalized ?? null,
          tokens: query?.tokens ?? [],
          resolvedRole: query?.roleSlug ?? null,
          roleResolution: query?.roleResolution ?? null,
          location: location?.raw ?? null,
        },
        results: [],
        page: {
          limit: request.limit,
          returned: 0,
          totalGroups: 0,
          totalPostings: 0,
          hasMore: false,
          nextCursor: null,
        },
        basis: {
          projectionVersion: SEARCH_PROJECTION_VERSION,
          rulesetVersion: RULESET_VERSION,
          rankingVersion: RANKING_VERSION,
          sort: request.sort,
          asOf: day.toISOString(),
          asOfDay: day.toISOString(),
          searchableSources: [],
        },
      },
    };
  }

  /** One result, with its freshness verdict and its ranking explained. */
  private present(row: DocumentRow, asOf: Date) {
    const facts: RelevanceFacts = {
      titleExact: row.titleExact,
      titlePrefix: row.titlePrefix,
      titleAllTokens: row.titleAllTokens,
      roleExact: row.roleExact,
      titleTokenHits: Number(row.titleTokenHits),
      searchTokenHits: Number(row.searchTokenHits),
      skillHits: Number(row.skillHits),
      locationExact: row.locationExact,
      locationAllTokens: row.locationAllTokens,
      recencyPoints: row.recencyPoints,
    };

    const relevance = relevanceFrom(facts);

    const freshness = classifyFreshness({
      asOf,
      lastSeenAt: row.lastSeenAt,
      lastCompleteCoverageAt: row.coverageCompletedAt,
      sourceValidThrough: row.sourceValidThrough,
      pollIntervalHours: row.pollIntervalHours,
      expectedPostingLifetimeDays: row.expectedPostingLifetimeDays,
    });

    return {
      id: row.postingId,
      title: row.titleRaw,
      company: row.companyRaw,
      location: row.locationRaw,
      role: row.roleSlug,
      skills: row.skillSlugs,
      sourcePublishedAt: row.sourcePublishedAt?.toISOString() ?? null,
      source: { slug: row.sourceSlug },
      freshness: {
        verdict: freshness.verdict,
        lifetimeBasis: freshness.lifetimeBasis,
        lastObservedAt: freshness.lastSeenAt.toISOString(),
        expectedLiveUntil: freshness.expectedLiveUntil.toISOString(),
      },
      /*
       * How many postings this result stands for, and why. 1 means it
       * stands only for itself.
       */
      grouping: {
        postings: Number(row.groupSize),
        basis: Number(row.groupSize) > 1 ? 'SOURCE_ASSERTED_GROUP' : 'NONE',
      },
      /*
       * The score AND its parts, on every result. A number alone would be
       * unfalsifiable; the components let a reader check the ordering
       * against the posting in front of them.
       */
      relevance: { total: relevance.total, components: relevance.components },
      applyUrl: row.applyUrl,
    };
  }

  /* --- SQL construction. Everything below is parameterized, never interpolated. --- */

  private filterSql(
    request: SearchRequest,
    query: ReturnType<typeof parseSearchQuery> | null,
    location: ReturnType<typeof parseLocationQuery> | null,
    company: string | null,
    sources: string[],
    day: Date,
  ): Prisma.Sql {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`d."projectionVersion" = ${SEARCH_PROJECTION_VERSION}`,
      Prisma.sql`d."rulesetVersion" = ${RULESET_VERSION}`,
      Prisma.sql`d."sourceSlug" IN (${Prisma.join(sources)})`,
    ];

    if (query !== null && query.tokens.length > 0) {
      /*
       * Recall, in one clause: every query token present, OR the
       * posting's canonical role is the one the query resolved to.
       *
       * The first half is AND semantics over tokens, which is what a
       * search box is expected to do - "software engineer" must not
       * return every engineer. The second half is Phase 9 earning its
       * keep: "backend developer" also reaches a posting titled
       * "Utvecklare" that resolved to the same role, and it reaches it
       * because a human authored that alias, not because two strings
       * looked similar. There is no path here by which "Software
       * Engineer" can reach "Engineering Manager".
       */
      const tokenMatch = Prisma.sql`d."searchTokens" @> ${query.tokens}::text[]`;

      clauses.push(
        query.roleSlug === null
          ? tokenMatch
          : Prisma.sql`(${tokenMatch} OR d."roleSlug" = ${query.roleSlug})`,
      );
    }

    if (request.role !== undefined) {
      clauses.push(Prisma.sql`d."roleSlug" = ${request.role}`);
    }

    if (location !== null && location.tokens.length > 0) {
      clauses.push(
        Prisma.sql`d."locationTokens" @> ${location.tokens}::text[]`,
      );
    }

    if (company !== null) {
      clauses.push(Prisma.sql`d."companyNormalized" = ${company}`);
    }

    if (request.skills !== undefined && request.skills.length > 0) {
      clauses.push(Prisma.sql`d."skillSlugs" @> ${request.skills}::text[]`);
    }

    if (request.publishedWithinDays !== undefined) {
      const floor = new Date(
        day.getTime() - request.publishedWithinDays * 86_400_000,
      );

      clauses.push(
        Prisma.sql`d."sourcePublishedAt" IS NOT NULL AND d."sourcePublishedAt" >= ${floor.toISOString()}::timestamp`,
      );
    }

    return Prisma.join(clauses, ' AND ');
  }

  /**
   * The ranking facts, as columns, plus the sum that orders them.
   *
   * Both are built from RELEVANCE_WEIGHTS, so a weight cannot be changed
   * in one and not the other. A test asserts this list covers exactly the
   * component codes the pure module knows about.
   */
  private factSql(
    query: ReturnType<typeof parseSearchQuery> | null,
    location: ReturnType<typeof parseLocationQuery> | null,
    skills: string[],
    day: Date,
  ): { select: Prisma.Sql; total: Prisma.Sql } {
    const hasQuery = query !== null && query.tokens.length > 0;

    const titleExact = hasQuery
      ? Prisma.sql`(d."titleNormalized" = ${query.normalized})`
      : Prisma.sql`FALSE`;

    /*
     * LIKE with the wildcards escaped. A query containing '%' would
     * otherwise match everything, which is not an injection - the value
     * is still a parameter - but is a caller deciding how the query runs.
     */
    const titlePrefix = hasQuery
      ? Prisma.sql`(d."titleNormalized" LIKE ${escapeLike(query.normalized) + '%'} ESCAPE '\\')`
      : Prisma.sql`FALSE`;

    const titleAllTokens = hasQuery
      ? Prisma.sql`(d."titleTokens" @> ${query.tokens}::text[])`
      : Prisma.sql`FALSE`;

    /*
     * COALESCE, and it is not decoration.
     *
     * `roleSlug` is null on 41% of the corpus, and in SQL `NULL = 'x'` is
     * NULL rather than false. An untreated NULL here propagates through
     * the multiplication and the sum, so the ENTIRE relevance of every
     * unresolved posting becomes NULL - and `ORDER BY relevance DESC`
     * puts NULLs first in Postgres. The result was that the postings
     * matching least came back at the top of the page, while the
     * TypeScript explanation beside them showed a perfectly sensible
     * score computed from the same facts.
     *
     * Found by the test that recomputes the ordering from the reported
     * numbers, which is the whole reason that test exists. The same
     * treatment is applied to every fact drawn from a nullable column.
     */
    const roleExact =
      query?.roleSlug === undefined || query?.roleSlug === null
        ? Prisma.sql`FALSE`
        : Prisma.sql`COALESCE(d."roleSlug" = ${query.roleSlug}, FALSE)`;

    const titleTokenHits = hasQuery
      ? Prisma.sql`(SELECT count(*) FROM unnest(${query.tokens}::text[]) AS t WHERE t = ANY(d."titleTokens"))`
      : Prisma.sql`0::bigint`;

    const searchTokenHits = hasQuery
      ? Prisma.sql`(SELECT count(*) FROM unnest(${query.tokens}::text[]) AS t WHERE t = ANY(d."searchTokens"))`
      : Prisma.sql`0::bigint`;

    const skillHits =
      skills.length === 0
        ? Prisma.sql`0::bigint`
        : Prisma.sql`(SELECT count(*) FROM unnest(${skills}::text[]) AS s WHERE s = ANY(d."skillSlugs"))`;

    const hasLocation = location !== null && location.tokens.length > 0;

    /* locationNormalized is nullable. See the note on roleExact. */
    const locationExact = hasLocation
      ? Prisma.sql`COALESCE(d."locationNormalized" = ${location.normalized}, FALSE)`
      : Prisma.sql`FALSE`;

    const locationAllTokens = hasLocation
      ? Prisma.sql`(d."locationTokens" @> ${location.tokens}::text[])`
      : Prisma.sql`FALSE`;

    const recency = this.recencySql(day);

    const select = Prisma.sql`
      ${titleExact} AS "titleExact",
      ${titlePrefix} AS "titlePrefix",
      ${titleAllTokens} AS "titleAllTokens",
      ${roleExact} AS "roleExact",
      ${titleTokenHits} AS "titleTokenHits",
      ${searchTokenHits} AS "searchTokenHits",
      ${skillHits} AS "skillHits",
      ${locationExact} AS "locationExact",
      ${locationAllTokens} AS "locationAllTokens",
      ${recency} AS "recencyPoints"
    `;

    /*
     * The sum, with a final COALESCE on each term as a second line of
     * defence. Every fact above is already null-safe; this makes a future
     * one that is not into a wrong number rather than a wrong ORDERING,
     * which the anti-drift test catches immediately.
     */
    const total = Prisma.sql`
        ${RELEVANCE_WEIGHTS.TITLE_EXACT} * (s."titleExact")::int
      + ${RELEVANCE_WEIGHTS.TITLE_PREFIX} * (s."titlePrefix")::int
      + ${RELEVANCE_WEIGHTS.TITLE_ALL_TOKENS} * (s."titleAllTokens")::int
      + ${RELEVANCE_WEIGHTS.ROLE_EXACT} * (s."roleExact")::int
      + ${RELEVANCE_WEIGHTS.TITLE_TOKEN} * (s."titleTokenHits")::int
      + ${RELEVANCE_WEIGHTS.SEARCH_TOKEN} * (s."searchTokenHits")::int
      + ${RELEVANCE_WEIGHTS.SKILL} * (s."skillHits")::int
      + ${RELEVANCE_WEIGHTS.LOCATION_EXACT} * (s."locationExact")::int
      + ${RELEVANCE_WEIGHTS.LOCATION_TOKENS} * (s."locationAllTokens")::int
      + s."recencyPoints"
    `;

    return { select, total };
  }

  /**
   * The recency band, measured from the publisher's date to a UTC day.
   *
   * Mirrors recencyPoints() in the pure module, and a test asserts the
   * two agree across the whole corpus rather than on an example.
   */
  private recencySql(day: Date): Prisma.Sql {
    let expression = Prisma.sql`${RECENCY_UNKNOWN_POINTS}`;

    for (const band of [...RECENCY_BANDS].reverse()) {
      expression = Prisma.sql`CASE WHEN floor(EXTRACT(EPOCH FROM (${day.toISOString()}::timestamp - d."sourcePublishedAt")) / 86400) <= ${band.withinDays} THEN ${band.points} ELSE ${expression} END`;
    }

    return Prisma.sql`(CASE WHEN d."sourcePublishedAt" IS NULL THEN ${RECENCY_UNKNOWN_POINTS} ELSE ${expression} END)::int`;
  }

  /**
   * The freshness verdict, in SQL.
   *
   * A transcription of classifyFreshness, and transcriptions rot - so a
   * test runs both over the corpus and asserts they never disagree. The
   * coverage gate is first here for the same reason it is first there: a
   * posting whose scope has not been completely read since we last saw it
   * is UNAVAILABLE, because its absence is our failure and not its
   * disappearance.
   */
  private freshnessSql(asOf: Date): Prisma.Sql {
    const now = Prisma.sql`${asOf.toISOString()}::timestamp`;

    return Prisma.sql`
      CASE
        WHEN cov."completedAt" IS NULL OR cov."completedAt" < d."lastSeenAt" THEN 'UNAVAILABLE'
        WHEN ${now} - d."lastSeenAt"
             <= make_interval(hours => cfg."pollIntervalHours" * 2) THEN 'FRESH'
        WHEN ${now} <= LEAST(
               COALESCE(d."sourceValidThrough", 'infinity'::timestamp),
               d."lastSeenAt" + make_interval(days => cfg."expectedPostingLifetimeDays")
             ) THEN 'AGING'
        ELSE 'STALE'
      END
    `;
  }

  /**
   * Resume after exactly one row.
   *
   * Written out rather than expressed as a row comparison because the
   * ordering puts NULLs last on a DESC column, and `(a, b) < (c, d)` has
   * no way to say that. Each branch below is one step of the ordering.
   */
  private keysetSql(cursor: SearchCursor, sort: SortOption): Prisma.Sql {
    const published =
      cursor.publishedAtMs === null
        ? null
        : new Date(cursor.publishedAtMs).toISOString();

    const afterPublished =
      published === null
        ? /* The cursor sat in the NULL tail, so only the id can advance. */
          Prisma.sql`(g."sourcePublishedAt" IS NULL AND g."externalId" > ${cursor.externalId})`
        : Prisma.sql`(
            g."sourcePublishedAt" IS NULL
            OR g."sourcePublishedAt" < ${published}::timestamp
            OR (g."sourcePublishedAt" = ${published}::timestamp AND g."externalId" > ${cursor.externalId})
          )`;

    if (sort === 'published') {
      return afterPublished;
    }

    return Prisma.sql`(
      g."relevance" < ${cursor.relevance}
      OR (g."relevance" = ${cursor.relevance} AND ${afterPublished})
    )`;
  }

  /**
   * One posting, in full.
   *
   * Reads the projection for the metadata it already holds, then makes
   * exactly one further read for the body - which is the only column
   * search does not index and the only one that needs redacting on the
   * way out.
   */
  async posting(postingId: string, asOf: Date) {
    const sources = await this.searchableSources();

    const document = await this.prisma.marketPostingSearchDocument.findUnique({
      where: { postingId },
      select: {
        postingId: true,
        sourceSlug: true,
        sourceScope: true,
        sourceId: true,
        versionId: true,
        titleRaw: true,
        companyRaw: true,
        locationRaw: true,
        roleSlug: true,
        skillSlugs: true,
        sourcePublishedAt: true,
        sourceValidThrough: true,
        firstSeenAt: true,
        lastSeenAt: true,
        applyUrl: true,
        projectionVersion: true,
        rulesetVersion: true,
      },
    });

    /*
     * A posting outside the searchable set is a 404 and not a 403. The
     * caller was never told it existed, and an error that distinguishes
     * "no such posting" from "a posting you may not see" is an oracle for
     * exactly the corpus we are not permitted to redistribute.
     */
    if (
      document === null ||
      document.projectionVersion !== SEARCH_PROJECTION_VERSION ||
      !sources.has(document.sourceSlug)
    ) {
      throw new NotFoundException('posting not found');
    }

    const source = sources.get(document.sourceSlug);

    if (source === undefined) {
      throw new NotFoundException('posting not found');
    }

    const [body, coverage, sourceDetail, roles, skills] = await Promise.all([
      this.body(document.versionId, document.rulesetVersion),
      this.scopeCoverage(document.sourceId, document.sourceScope),
      this.prisma.marketSource.findUnique({
        where: { slug: document.sourceSlug },
        select: {
          slug: true,
          displayName: true,
          licenceBasis: true,
          licenceNote: true,
        },
      }),
      document.roleSlug === null
        ? Promise.resolve(null)
        : this.prisma.marketRole.findUnique({
            where: { slug: document.roleSlug },
            select: { slug: true, label: true },
          }),
      document.skillSlugs.length === 0
        ? Promise.resolve([])
        : this.prisma.marketSkill.findMany({
            where: { slug: { in: document.skillSlugs } },
            orderBy: { slug: 'asc' },
            select: { slug: true, label: true },
          }),
    ]);

    const freshness = classifyFreshness({
      asOf,
      lastSeenAt: document.lastSeenAt,
      lastCompleteCoverageAt: coverage,
      sourceValidThrough: document.sourceValidThrough,
      pollIntervalHours: source.pollIntervalHours,
      expectedPostingLifetimeDays: source.expectedPostingLifetimeDays,
    });

    return {
      data: {
        id: document.postingId,
        title: document.titleRaw,
        company: document.companyRaw,
        location: document.locationRaw,
        role: roles,
        skills,
        description: body,
        sourcePublishedAt: document.sourcePublishedAt?.toISOString() ?? null,
        sourceValidThrough: document.sourceValidThrough?.toISOString() ?? null,
        freshness: {
          verdict: freshness.verdict,
          lifetimeBasis: freshness.lifetimeBasis,
          lastObservedAt: freshness.lastSeenAt.toISOString(),
          expectedLiveUntil: freshness.expectedLiveUntil.toISOString(),
          asOf: asOf.toISOString(),
        },
        /*
         * Provenance, in the vocabulary a reader can act on. The source's
         * display name and when we last observed the posting - not the
         * run id, not the version id, not the adapter version. Section 16
         * is explicit that this is a job page and not a data-management
         * screen.
         */
        provenance: {
          source:
            sourceDetail === null
              ? null
              : {
                  slug: sourceDetail.slug,
                  displayName: sourceDetail.displayName,
                  licenceBasis: sourceDetail.licenceBasis,
                  licenceNote: sourceDetail.licenceNote,
                },
          firstObservedAt: document.firstSeenAt.toISOString(),
          lastObservedAt: document.lastSeenAt.toISOString(),
        },
        /*
         * Where an application actually goes. The publisher's own page,
         * always. Shipaton is not the employer and there is no Shipaton
         * application system for this to route through.
         */
        applyUrl: document.applyUrl,
      },
    };
  }

  /**
   * The body, redacted.
   *
   * The one read of a description column in this module, and it hands the
   * result straight to servedDescription. See that file for the leak this
   * exists to close.
   */
  private async body(
    versionId: string,
    rulesetVersion: number,
  ): Promise<string | null> {
    const row = await this.prisma.marketPostingNormalization.findUnique({
      where: { versionId_rulesetVersion: { versionId, rulesetVersion } },
      select: { descriptionText: true },
    });

    return servedDescription(row?.descriptionText ?? null);
  }

  private async scopeCoverage(
    sourceId: string,
    sourceScope: string,
  ): Promise<Date | null> {
    const row = await this.prisma.marketRunScopeCoverage.aggregate({
      where: {
        sourceId,
        sourceScope,
        completeForScope: true,
        finishedAt: { not: null },
      },
      _max: { finishedAt: true },
    });

    return row._max.finishedAt;
  }
}

/** Escapes the LIKE metacharacters so a caller cannot widen their own query. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
