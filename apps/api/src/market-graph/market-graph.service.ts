import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { RULESET_VERSION } from './normalization/ruleset.js';

/*
 * The read side of the Market Graph.
 *
 * Every query here names an explicit ordering whose last term is unique.
 * Postgres promises nothing without one, and an ordering that ties is an
 * ordering the storage engine decides - so a list endpoint would return
 * rows in an order that changed after a VACUUM, and a determinism test
 * that inserted rows in a different order would catch it.
 *
 * Nothing here reads a Career Graph table, and there is no query in this
 * file that takes a user id. The market is the same for everybody; that is
 * what makes it the market. Personalising it is Phase 9.
 */

/** A ceiling on every list endpoint, so no response is unbounded. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

@Injectable()
export class MarketGraphService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sources whose derived aggregates may be shown outside the team.
   *
   * `mayRedistributeDerived` was a column nothing consulted - written
   * false, selected for display, and never checked before serving a single
   * signal. That is precisely the failure its neighbour `isEnabled`
   * documents: a column recording an intention that no code path reads is
   * worse than no column, because a reader believes it is doing something.
   *
   * Not yet enforced on the read endpoints, deliberately and visibly: the
   * two sources currently disagree (one CC0, one unresolved), and gating
   * reads on it would silently empty the market rather than raise the
   * question. Exposed here so the question is answerable from the API.
   */
  async redistributableSourceSlugs(): Promise<string[]> {
    const sources = await this.prisma.marketSource.findMany({
      where: { mayRedistributeDerived: true },
      orderBy: { slug: 'asc' },
      select: { slug: true },
    });

    return sources.map((source) => source.slug);
  }

  async listSources() {
    const sources = await this.prisma.marketSource.findMany({
      orderBy: { slug: 'asc' },
      select: {
        slug: true,
        displayName: true,
        kind: true,
        licenceBasis: true,
        isEnabled: true,
        mayRedistributeDerived: true,
        licenceNote: true,
        licenceReviewedAt: true,
        expectedPostingLifetimeDays: true,
        pollIntervalHours: true,
      },
    });

    return { data: sources };
  }

  async listRoles(limit?: number) {
    const roles = await this.prisma.marketRole.findMany({
      where: { deprecatedAt: null },
      orderBy: { slug: 'asc' },
      take: clampLimit(limit),
      select: { slug: true, label: true },
    });

    return { data: roles };
  }

  async listSkills(limit?: number) {
    const skills = await this.prisma.marketSkill.findMany({
      where: { deprecatedAt: null },
      orderBy: { slug: 'asc' },
      take: clampLimit(limit),
      select: { slug: true, label: true },
    });

    return { data: skills };
  }

  /** The most recent completed snapshot, or null when none has been run. */
  private async latestSignalRun() {
    return this.prisma.marketSignalRun.findFirst({
      where: {
        status: 'SUCCEEDED',
        /*
         * A run with no signals is never the snapshot.
         *
         * Two zero-signal runs are already in this database, from an
         * invocation that passed ten board tokens as one space-separated
         * string. They matched nothing and were written SUCCEEDED, and
         * because this query takes the most recent SUCCEEDED run, a typo
         * was one minute away from serving "the market contains no roles"
         * to every reader - which is the null-rendered-as-zero failure the
         * completeness contract exists to forbid.
         */
        signals: { some: {} },
        /*
         * Deliberately NOT filtered on the compile-time RULESET_VERSION.
         * Filtering on it meant that bumping the constant would make every
         * existing signal vanish from every read endpoint at once, serving
         * an empty market until a fresh computation landed. The run states
         * which ruleset produced it; the reader reports that rather than
         * hiding anything that disagrees with the current build.
         */
      },
      /*
       * computedAt then id. Two runs can share a millisecond, and `id` is
       * the only unique column available - arbitrary, but this is a
       * "which one do we show" tiebreak rather than anything a stored
       * number depends on, so an arbitrary total order is sufficient here
       * where it would not be inside a computation.
       */
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        windowStart: true,
        windowEnd: true,
        scopes: true,
        sourceScopeKey: true,
        rulesetVersion: true,
        computationVersion: true,
        minDenominator: true,
        minDistinctCompanies: true,
        coverageComplete: true,
        computedAt: true,
        stats: true,
      },
    });
  }

  async latestSnapshot() {
    const run = await this.latestSignalRun();

    return { data: run };
  }

  /**
   * The skills observed alongside one role, most prevalent first.
   *
   * Returns counts, never a percentage. The caller divides where the
   * denominator is still visible next to the number.
   */
  async roleSkills(roleSlug: string, limit?: number) {
    const role = await this.prisma.marketRole.findUnique({
      where: { slug: roleSlug },
      select: { id: true, slug: true, label: true },
    });

    if (role === null) {
      throw new NotFoundException('Unknown market role');
    }

    const run = await this.latestSignalRun();

    if (run === null) {
      return { data: { role, window: null, signals: [] } };
    }

    const signals = await this.prisma.marketSignal.findMany({
      where: {
        runId: run.id,
        signalType: 'ROLE_SKILL_PREVALENCE',
        roleId: role.id,
      },
      /*
       * Count desc, then denominator desc, then the skill's slug ascending.
       * The slug is unique, so the order is total - two skills with the
       * same counts cannot swap places between two identical requests.
       */
      orderBy: [
        { numeratorCount: 'desc' },
        { denominatorCount: 'desc' },
        { skill: { slug: 'asc' } },
      ],
      take: clampLimit(limit),
      select: {
        id: true,
        numeratorCount: true,
        denominatorCount: true,
        distinctCompanyCount: true,
        distinctSourceCount: true,
        coverageComplete: true,
        dedupeMethod: true,
        skill: { select: { slug: true, label: true } },
      },
    });

    return {
      data: {
        role,
        window: {
          start: run.windowStart,
          end: run.windowEnd,
          scopes: run.scopes,
          coverageComplete: run.coverageComplete,
          rulesetVersion: run.rulesetVersion,
          computationVersion: run.computationVersion,
          minDenominator: run.minDenominator,
          minDistinctCompanies: run.minDistinctCompanies,
          computedAt: run.computedAt,
          signalRunId: run.id,
        },
        signals,
      },
    };
  }

  /** Role volumes for the latest snapshot, largest first. */
  async roleVolumes(limit?: number) {
    const run = await this.latestSignalRun();

    if (run === null) {
      return { data: { window: null, signals: [] } };
    }

    const signals = await this.prisma.marketSignal.findMany({
      where: { runId: run.id, signalType: 'ROLE_POSTING_VOLUME' },
      orderBy: [{ numeratorCount: 'desc' }, { role: { slug: 'asc' } }],
      take: clampLimit(limit),
      select: {
        id: true,
        numeratorCount: true,
        denominatorCount: true,
        distinctCompanyCount: true,
        distinctSourceCount: true,
        coverageComplete: true,
        dedupeMethod: true,
        role: { select: { slug: true, label: true } },
      },
    });

    const stats = run.stats as { postingsRoleUnresolved?: unknown } | null;

    return {
      data: {
        window: {
          start: run.windowStart,
          end: run.windowEnd,
          scopes: run.scopes,
          coverageComplete: run.coverageComplete,
          computedAt: run.computedAt,
          signalRunId: run.id,
          /*
           * Without this the denominator is uninterpretable.
           *
           * A volume signal reads "340 of 2955 postings", and a reader
           * divides. But two thirds of those 2955 resolved to no role at
           * all, so the true share among postings the vocabulary can
           * classify is roughly three times higher. The correction was
           * computed by the projection and stored on the run, and then not
           * returned - so the one number that makes the ratio honest was
           * the one number the reader could not see.
           */
          postingsRoleUnresolved:
            typeof stats?.postingsRoleUnresolved === 'number'
              ? stats.postingsRoleUnresolved
              : null,
        },
        signals,
      },
    };
  }

  /**
   * The titles that did not resolve to a canonical role, most frequent
   * first.
   *
   * This is the curation backlog, and it is exposed rather than hidden
   * because it is the honest measure of how much of the market the
   * vocabulary can currently see. A system that only showed what it
   * understood would look complete at any coverage.
   */
  async unresolvedTitles(limit?: number) {
    const rows = await this.prisma.marketPostingNormalization.groupBy({
      by: ['titleNormalized'],
      where: { rulesetVersion: RULESET_VERSION, roleId: null },
      _count: { titleNormalized: true },
      orderBy: [
        { _count: { titleNormalized: 'desc' } },
        { titleNormalized: 'asc' },
      ],
      take: clampLimit(limit),
    });

    return {
      data: rows.map((row) => ({
        titleNormalized: row.titleNormalized,
        postingCount: row._count.titleNormalized,
      })),
    };
  }

  /**
   * The provenance chain behind one signal, walked to the raw payload.
   *
   * This is the endpoint that makes "why does this signal exist?" a
   * question with an answer rather than a claim in a document.
   */
  async explainSignal(signalId: string) {
    const signal = await this.prisma.marketSignal.findUnique({
      where: { id: signalId },
      select: {
        id: true,
        signalType: true,
        numeratorCount: true,
        denominatorCount: true,
        distinctCompanyCount: true,
        distinctSourceCount: true,
        windowStart: true,
        windowEnd: true,
        rulesetVersion: true,
        computationVersion: true,
        dedupeMethod: true,
        coverageComplete: true,
        computedAt: true,
        role: { select: { slug: true, label: true } },
        skill: { select: { slug: true, label: true } },
        run: {
          select: {
            id: true,
            scopes: true,
            sourceScopeKey: true,
            minDenominator: true,
            minDistinctCompanies: true,
            stats: true,
          },
        },
      },
    });

    if (signal === null) {
      throw new NotFoundException('Unknown market signal');
    }

    /*
     * A bounded sample of the contributing evidence, not the whole set.
     * Enough to check the claim by hand; small enough that this endpoint
     * cannot become an export of the observation store.
     */
    const contributing = signal.skill
      ? await this.prisma.marketPostingSkillMention.findMany({
          where: {
            rulesetVersion: signal.rulesetVersion,
            skill: { slug: signal.skill.slug },
            normalization: {
              role: { slug: signal.role.slug },
              version: {
                sightings: {
                  some: {
                    observedAt: {
                      gte: signal.windowStart,
                      lt: signal.windowEnd,
                    },
                  },
                },
              },
            },
          },
          orderBy: { id: 'asc' },
          take: 10,
          select: {
            rawTerm: true,
            termNormalized: true,
            matchMethod: true,
            extractedFrom: true,
            normalization: {
              select: {
                titleNormalized: true,
                companyNormalized: true,
                roleMatchMethod: true,
                outputHash: true,
                version: {
                  select: {
                    contentHash: true,
                    rawPayloadHash: true,
                    titleRaw: true,
                    sourcePublishedAt: true,
                    firstSeenRun: {
                      select: {
                        id: true,
                        status: true,
                        startedAt: true,
                        queryFingerprint: true,
                        source: { select: { slug: true, licenceBasis: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        })
      : [];

    return { data: { signal, contributing } };
  }
}
