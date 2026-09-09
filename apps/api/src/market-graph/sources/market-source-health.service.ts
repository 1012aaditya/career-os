import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  evaluateIngestGate,
  type CredentialState,
  type IngestRefusalReason,
  type SourceAccessState,
  type SourceCategory,
} from './source-access.js';
import { MarketSourceCredentials } from './source-credentials.js';
import { MarketSourceRegistry } from './source-registry.js';

/*
 * What is actually happening with each source.
 *
 * DERIVED, never stored. Every number below is computed from the ledger
 * Phase 8 already keeps - runs, scope coverage, postings, versions,
 * sightings - at an instant the caller supplies. That is the same rule
 * freshness follows and for the same reason: a stored health row is a
 * judgement made at time T that goes on asserting itself at T plus six
 * months, and the schema forbids storing one anyway.
 *
 * INTERNAL. This is an operator's report. It names credential variables,
 * quotes access notes recording who was asked what, and says which sources
 * were refused and why - none of which belongs anywhere near the Market
 * Search API. It is reachable from the CLI and from nothing else, and a
 * boundary test keeps the read controllers from importing it.
 *
 * It answers the questions an operator actually has, which are mostly
 * about telling similar-looking failures apart:
 *
 *   is it off because nobody approved it, or because I turned it off?
 *   is it failing, or is the key not deployed on this host?
 *   did the last run read everything, or just not fail?
 *   is the code's decision the same as the row's?
 */

export type SourceHealth = {
  slug: string;
  displayName: string;
  category: SourceCategory | null;
  /** What the registry declares, in code, under review. */
  declaredAccessState: SourceAccessState;
  /** What the row records. Equal to the above unless somebody edited one. */
  storedAccessState: SourceAccessState | null;
  isEnabled: boolean;
  mayRedistributeDerived: boolean;
  licenceBasis: string;
  /** Kind and missing key NAMES. Never a value. */
  credentials: CredentialState;
  /**
   * Whether a run started right now would be permitted, and if not, which
   * of the four refusals it would be.
   */
  ingestible: boolean;
  refusal: { reason: IngestRefusalReason; detail: string } | null;
  attribution: string | null;

  /** Null where the source has never been walked at all. */
  lastAttemptedImportAt: string | null;
  /**
   * The last run that ENDED in a usable state, PARTIAL included.
   *
   * PARTIAL counts, and that is deliberate: a run that read three boards
   * of ten succeeded at what it did, and calling it unsuccessful would
   * report a source with real recent data as one that has none.
   */
  lastSuccessfulImportAt: string | null;
  runs: {
    total: number;
    succeeded: number;
    partial: number;
    failed: number;
    /** Still RUNNING. A stuck run blocks every later one for its source. */
    running: number;
  };
  corpus: {
    postings: number;
    versions: number;
    sightings: number;
  };
  lastRun: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    /** The run's own reason code. Never a caught error. */
    errorReason: string | null;
    scopesRequested: number;
    scopesRead: number;
    /** Read to the END. `scopesRead` minus this is partial coverage. */
    scopesComplete: number;
    postingsCreated: number;
    versionsCreated: number;
    sightingsCreated: number;
  } | null;
  /**
   * Scope failures across the source's whole history, by reason code.
   *
   * Grouped by reason rather than listed, because the shape of the
   * histogram is the diagnosis: a hundred `rate_limited` is a pacing
   * problem, a hundred `board_not_found` is a stale scope list, and one of
   * each is a Tuesday.
   */
  scopeFailures: Array<{ reason: string; count: number }>;
  /** Scopes read but not read to the end, on the most recent run. */
  partialCoverageScopes: number;
};

type RunStatsShape = {
  scopesRequested?: unknown;
  scopesRead?: unknown;
  scopesComplete?: unknown;
  postingsCreated?: unknown;
  versionsCreated?: unknown;
  sightingsCreated?: unknown;
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

@Injectable()
export class MarketSourceHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MarketSourceRegistry,
    private readonly credentials: MarketSourceCredentials,
  ) {}

  /**
   * One report per source the REGISTRY declares.
   *
   * Driven by the registry rather than by the table, so a source that has
   * never been synced still appears - with nulls where a run would be -
   * instead of being invisible because it has no row. A source that exists
   * only in the database and no longer in the code is a different problem
   * and is not this report's job; the purge path already refuses those by
   * routing through the registry.
   */
  async report(): Promise<SourceHealth[]> {
    const descriptors = this.registry.descriptors();

    const rows = await this.prisma.marketSource.findMany({
      where: { slug: { in: descriptors.map((entry) => entry.slug) } },
      select: {
        id: true,
        slug: true,
        accessState: true,
        isEnabled: true,
        attribution: true,
      },
    });

    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const report: SourceHealth[] = [];

    for (const descriptor of descriptors) {
      const row = bySlug.get(descriptor.slug);
      const credentials = this.credentials.state(descriptor.credentials);

      const gate = evaluateIngestGate({
        declared: descriptor.access.state,
        /*
         * The stored state when there is a row, and the declared one when
         * there is not - so a source that has never been synced is
         * reported on its own declaration rather than as a disagreement
         * with a row that does not exist.
         */
        stored: row?.accessState ?? descriptor.access.state,
        storedIsEnabled: row?.isEnabled ?? descriptor.isEnabled,
        credentials,
      });

      report.push({
        slug: descriptor.slug,
        displayName: descriptor.displayName,
        category: descriptor.category,
        declaredAccessState: descriptor.access.state,
        storedAccessState: row?.accessState ?? null,
        isEnabled: row?.isEnabled ?? descriptor.isEnabled,
        mayRedistributeDerived: descriptor.mayRedistributeDerived,
        licenceBasis: descriptor.licenceBasis,
        credentials,
        ingestible: gate.permitted,
        refusal: gate.permitted
          ? null
          : { reason: gate.reason, detail: gate.detail },
        attribution: row?.attribution ?? descriptor.attribution,
        ...(row === undefined
          ? {
              lastAttemptedImportAt: null,
              lastSuccessfulImportAt: null,
              runs: {
                total: 0,
                succeeded: 0,
                partial: 0,
                failed: 0,
                running: 0,
              },
              corpus: { postings: 0, versions: 0, sightings: 0 },
              lastRun: null,
              scopeFailures: [],
              partialCoverageScopes: 0,
            }
          : await this.activity(row.id)),
      });
    }

    return report;
  }

  /** Everything that needs the source row's id. */
  private async activity(sourceId: string): Promise<
    Pick<
      SourceHealth,
      | 'lastAttemptedImportAt'
      | 'lastSuccessfulImportAt'
      | 'runs'
      | 'corpus'
      | 'lastRun'
      | 'scopeFailures'
      | 'partialCoverageScopes'
    >
  > {
    const [byStatus, lastRun, lastGood, postings, versions, sightings, failures] =
      await Promise.all([
        this.prisma.marketIngestionRun.groupBy({
          by: ['status'],
          where: { sourceId },
          _count: { _all: true },
        }),
        this.prisma.marketIngestionRun.findFirst({
          where: { sourceId },
          orderBy: { startedAt: 'desc' },
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            errorReason: true,
            stats: true,
          },
        }),
        this.prisma.marketIngestionRun.findFirst({
          where: { sourceId, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
          orderBy: { startedAt: 'desc' },
          select: { finishedAt: true, startedAt: true },
        }),
        this.prisma.marketPosting.count({ where: { sourceId } }),
        this.prisma.marketPostingVersion.count({
          where: { posting: { sourceId } },
        }),
        this.prisma.marketPostingSighting.count({
          where: { posting: { sourceId } },
        }),
        this.prisma.marketRunScopeCoverage.groupBy({
          by: ['failureReason'],
          where: { sourceId, failureReason: { not: null } },
          _count: { _all: true },
        }),
      ]);

    const statusCount = (status: string): number =>
      byStatus.find((entry) => entry.status === status)?._count._all ?? 0;

    const partialCoverageScopes =
      lastRun === null
        ? 0
        : await this.prisma.marketRunScopeCoverage.count({
            where: { runId: lastRun.id, read: true, completeForScope: false },
          });

    const stats = (lastRun?.stats ?? null) as RunStatsShape | null;

    return {
      lastAttemptedImportAt: lastRun?.startedAt.toISOString() ?? null,
      /*
       * finishedAt, falling back to startedAt. A finished run always has
       * the first; the fallback exists so a row written by an older build
       * reports a time rather than null, which would read as "never ran".
       */
      lastSuccessfulImportAt:
        (lastGood?.finishedAt ?? lastGood?.startedAt)?.toISOString() ?? null,
      runs: {
        total: byStatus.reduce((sum, entry) => sum + entry._count._all, 0),
        succeeded: statusCount('SUCCEEDED'),
        partial: statusCount('PARTIAL'),
        failed: statusCount('FAILED'),
        running: statusCount('RUNNING'),
      },
      corpus: { postings, versions, sightings },
      lastRun:
        lastRun === null
          ? null
          : {
              status: lastRun.status,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt?.toISOString() ?? null,
              errorReason: lastRun.errorReason,
              scopesRequested: count(stats?.scopesRequested),
              scopesRead: count(stats?.scopesRead),
              scopesComplete: count(stats?.scopesComplete),
              postingsCreated: count(stats?.postingsCreated),
              versionsCreated: count(stats?.versionsCreated),
              sightingsCreated: count(stats?.sightingsCreated),
            },
      scopeFailures: failures
        .map((entry) => ({
          reason: entry.failureReason ?? 'unknown',
          count: entry._count._all,
        }))
        /* Ordered by us, so two machines print the same report. */
        .sort((a, b) =>
          b.count !== a.count
            ? b.count - a.count
            : a.reason < b.reason
              ? -1
              : a.reason > b.reason
                ? 1
                : 0,
        ),
      partialCoverageScopes,
    };
  }
}
