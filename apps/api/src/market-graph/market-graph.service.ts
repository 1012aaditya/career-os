import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { canonicalHash } from '../common/canonical-hash.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RULESET_VERSION } from './normalization/ruleset.js';
import { classifyFreshness } from './observations/freshness.js';

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

/**
 * The bounded evidence sample: enough to check a claim by hand, small
 * enough that this endpoint cannot become an export of the observation
 * store.
 */
const EXPLAIN_SAMPLE_SIZE = 10;

/*
 * A ceiling on the population this endpoint will reconstruct. One signal
 * is a single (role, skill) pair inside one window, which is small; a
 * number this large means the predicate is wrong, and finding that out by
 * walking millions of rows on a GET is the wrong way to find it out.
 */
const MAX_EXPLAIN_CANDIDATES = 50_000;

/*
 * How far back the snapshot search looks for a run belonging to a source
 * a reader is allowed to see. Bounded so the query cannot degrade as run
 * history grows; deep enough that a source not computed for months is
 * still findable.
 */
const MAX_RUN_SCAN = 200;

/** Matches the sighting walk in the computation this reconstructs. */
const SIGHTING_PAGE_SIZE = 5_000;
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
        /*
         * Phase 11. `category` and `attribution` are facts about the
         * relationship and about what must be displayed - both safe, both
         * useful to a reader deciding what a source is.
         *
         * accessState, accessNote and requiresCredentials are DELIBERATELY
         * absent. They record who was asked what, which sources were
         * refused and on what grounds, and whether a host is configured -
         * internal operational material with no reader-facing meaning. The
         * CLI's `health` report is where those live.
         */
        category: true,
        attribution: true,
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
  /**
   * The snapshot a reader is served, and WHOSE market it is.
   *
   * This took no source at all. It returned the globally most recent
   * successful run, so "the market" was whichever CLI invocation finished
   * last - and with two sources that was decided by 591 milliseconds. The
   * consequence was live, not theoretical: for 51 minutes the API served
   * derived aggregates computed from Greenhouse, whose descriptor says
   * mayRedistributeDerived is false, purely because its run landed later.
   * At seven sources it would have been a lottery over what "the market"
   * means, re-rolled on every ingest.
   *
   * Two changes. The candidate set is restricted to sources permitted to
   * have their derived aggregates shown - which is the enforcement
   * mayRedistributeDerived was written for and never got; it had zero
   * callers. And the chosen source is returned, so every response says
   * whose market it describes rather than leaving a reader to assume it is
   * everyone's.
   *
   * A caller may name a source instead. It is still one source's view -
   * this phase has no cross-source aggregation and no cross-source
   * dedupe, so a merged number would be a count of postings that might be
   * the same job twice - but which one is now stated rather than raced
   * for.
   */
  private async latestSignalRun(sourceSlug?: string) {
    const sources = await this.prisma.marketSource.findMany({
      where:
        sourceSlug === undefined
          ? { mayRedistributeDerived: true }
          : { slug: sourceSlug },
      orderBy: { slug: 'asc' },
      select: {
        slug: true,
        displayName: true,
        licenceBasis: true,
        mayRedistributeDerived: true,
      },
    });

    if (sourceSlug !== undefined) {
      const named = sources[0];

      if (named === undefined) {
        throw new NotFoundException(`Unknown market source: ${sourceSlug}`);
      }

      /*
       * Refused rather than served. A licence that permits ingestion for
       * internal analysis and a licence that permits showing derived
       * aggregates to a reader are different permissions, and only the
       * second one is being exercised here.
       */
      if (!named.mayRedistributeDerived) {
        throw new ConflictException(
          `Source ${sourceSlug} may not have derived aggregates redistributed`,
        );
      }
    }

    if (sources.length === 0) {
      return null;
    }

    /*
     * MarketSignalRun records no source - only sourceScopeKey, which is
     * canonicalHash({source, scopes}) and one-way. So candidates are
     * walked most-recent-first and each is attributed by recomputing that
     * key, which is deterministic and bounded by the scan below.
     */
    const candidates = await this.prisma.marketSignalRun.findMany({
      where: { status: 'SUCCEEDED', signals: { some: {} } },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      take: MAX_RUN_SCAN,
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

    for (const run of candidates) {
      const owner = sources.find(
        (source) =>
          canonicalHash({ source: source.slug, scopes: run.scopes }) ===
          run.sourceScopeKey,
      );

      if (owner !== undefined) {
        return { ...run, source: owner };
      }
    }

    return null;
  }

  async latestSnapshot(sourceSlug?: string) {
    const run = await this.latestSignalRun(sourceSlug);

    return { data: run };
  }

  /**
   * The skills observed alongside one role, most prevalent first.
   *
   * Returns counts, never a percentage. The caller divides where the
   * denominator is still visible next to the number.
   */
  async roleSkills(roleSlug: string, limit?: number, sourceSlug?: string) {
    const role = await this.prisma.marketRole.findUnique({
      where: { slug: roleSlug },
      select: { id: true, slug: true, label: true },
    });

    if (role === null) {
      throw new NotFoundException('Unknown market role');
    }

    const run = await this.latestSignalRun(sourceSlug);

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
          /*
           * Whose market this is. Every signal in this phase is "the market
           * as covered by these employers, on this source" - the honesty
           * rule the schema states - and until now the two read endpoints a
           * reader actually hits named the employers and not the source.
           */
          source: run.source,
        },
        signals,
      },
    };
  }

  /** Role volumes for the latest snapshot, largest first. */
  async roleVolumes(limit?: number, sourceSlug?: string) {
    const run = await this.latestSignalRun(sourceSlug);

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
          source: run.source,
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
   * The source a signal run drew from, recovered from its scope key.
   *
   * MarketSignalRun records `scopes` and `sourceScopeKey` and NO source
   * column - the source exists only inside `canonicalHash({source,
   * scopes})`, which is one-way. So the owner is recovered by recomputing
   * that key for every registered source and matching. Deterministic, and
   * O(number of sources).
   *
   * Matching on the scope list instead would be wrong rather than merely
   * slower. Scope tokens are not namespaced per source - the CHECK permits
   * '*' for "a source with no sub-scope", so two such sources collide
   * exactly - and two historical runs in this database carry a malformed
   * single scope string that matches no posting scope on any source, which
   * a scope match would attribute to nothing.
   *
   * Fails closed. Zero matches or more than one means the population
   * cannot be reconstructed, and serving unfiltered evidence is worse than
   * serving none.
   */
  private async resolveRunSource(run: {
    scopes: string[];
    sourceScopeKey: string;
  }) {
    const sources = await this.prisma.marketSource.findMany({
      orderBy: { slug: 'asc' },
      select: {
        id: true,
        slug: true,
        mayRedistributeDerived: true,
        pollIntervalHours: true,
        expectedPostingLifetimeDays: true,
      },
    });

    const owners = sources.filter(
      (source) =>
        canonicalHash({ source: source.slug, scopes: run.scopes }) ===
        run.sourceScopeKey,
    );

    const owner = owners[0];

    if (owners.length !== 1 || owner === undefined) {
      throw new ConflictException(
        `Signal run attributes to ${owners.length} sources; refusing to explain it`,
      );
    }

    return owner;
  }

  /**
   * Each posting read at the version of its LATEST in-window sighting.
   *
   * The same rule the computation applies, and the same total ordering:
   * observedAt is millisecond-resolution, so ties are ordinary and runSeq
   * breaks them. runSeq is a sequence rather than a uuid because a uuid is
   * arbitrary and different between dev, CI and production.
   *
   * "Latest in-window" and not "latest overall". The predicate this
   * replaces asked whether a version had EVER been sighted in the window,
   * which admits a superseded version alongside the successor that
   * actually contributed - so the endpoint cited text the signal was not
   * computed from.
   */
  private async latestInWindowVersions(
    postingIds: string[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Map<string, string>> {
    const latest = new Map<string, string>();

    if (postingIds.length === 0) {
      return latest;
    }

    for (let skip = 0; ; skip += SIGHTING_PAGE_SIZE) {
      const page = await this.prisma.marketPostingSighting.findMany({
        where: {
          postingId: { in: postingIds },
          observedAt: { gte: windowStart, lt: windowEnd },
        },
        orderBy: [
          { postingId: 'asc' },
          { observedAt: 'desc' },
          { runSeq: 'desc' },
          { versionId: 'asc' },
        ],
        skip,
        take: SIGHTING_PAGE_SIZE,
        select: { postingId: true, versionId: true },
      });

      for (const sighting of page) {
        if (!latest.has(sighting.postingId)) {
          latest.set(sighting.postingId, sighting.versionId);
        }
      }

      if (page.length < SIGHTING_PAGE_SIZE) {
        return latest;
      }
    }
  }

  /**
   * The provenance chain behind one signal, walked to the raw payload.
   *
   * This is the endpoint that makes "why does this signal exist?" a
   * question with an answer rather than a claim in a document.
   *
   * The contributing population is reconstructed by applying the same
   * selection predicates the computation applied - source, scopes, window,
   * the latest in-window version, the ruleset version, and for a
   * prevalence signal the eligibility conjunction - written INDEPENDENTLY
   * here rather than by calling the computation's own walk. Calling that
   * walk would guarantee agreement and prove nothing: an audit endpoint
   * that re-runs the thing it audits confirms its own bugs, and would have
   * reported the 8.8 sighting-truncation defect as correct. Two
   * implementations that agree are evidence; one called twice is not.
   *
   * Every filter below was absent, and the omission was not theoretical.
   * With two sources loaded this endpoint returned 168 mention rows for a
   * signal whose numerator was 22 - 145 of them from the other source, on
   * another continent - and returned the IDENTICAL rows as the explanation
   * for a different signal whose numerator was 145. The explanation
   * carried no information about which signal it explained.
   */
  async explainSignal(signalId: string, asOf: Date) {
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

    const source = await this.resolveRunSource(signal.run);
    const skill = signal.skill;

    /*
     * Candidates first, then the latest-in-window rule, then the predicate
     * re-checked on the version that rule selected.
     *
     * A posting is a candidate if ANY of its versions carries a matching
     * normalization. That is deliberately looser than the answer and is
     * what keeps the walk bounded: an edited posting whose earlier version
     * mentioned the skill and whose latest one does not is a candidate,
     * and is discarded below.
     */
    const candidates = await this.prisma.marketPosting.findMany({
      where: {
        sourceId: source.id,
        sourceScope: { in: signal.run.scopes },
        sightings: {
          some: {
            observedAt: { gte: signal.windowStart, lt: signal.windowEnd },
          },
        },
        versions: {
          some: {
            normalizations: {
              some: {
                rulesetVersion: signal.rulesetVersion,
                role: { slug: signal.role.slug },
                ...(skill === null
                  ? {}
                  : {
                      mentions: {
                        some: {
                          rulesetVersion: signal.rulesetVersion,
                          skill: { slug: skill.slug },
                        },
                      },
                    }),
              },
            },
          },
        },
      },
      orderBy: { externalId: 'asc' },
      take: MAX_EXPLAIN_CANDIDATES + 1,
      select: { id: true },
    });

    if (candidates.length > MAX_EXPLAIN_CANDIDATES) {
      throw new ConflictException(
        `Signal has more than ${MAX_EXPLAIN_CANDIDATES} candidate postings; refusing to reconstruct a population this large on a read`,
      );
    }

    const latestVersion = await this.latestInWindowVersions(
      candidates.map((posting) => posting.id),
      signal.windowStart,
      signal.windowEnd,
    );

    const rows = await this.prisma.marketPostingNormalization.findMany({
      where: {
        rulesetVersion: signal.rulesetVersion,
        versionId: { in: [...latestVersion.values()] },
        role: { slug: signal.role.slug },
        /*
         * Eligibility applies to prevalence and NOT to volume. A volume
         * denominator is every posting that entered role resolution,
         * whatever its description completeness; filtering it here would
         * be the same defect as omitting it there, in the other direction.
         */
        ...(skill === null
          ? {}
          : {
              skillExtractionStatus: 'EXTRACTED',
              version: { descriptionCompleteness: 'FULL' },
              mentions: {
                some: {
                  rulesetVersion: signal.rulesetVersion,
                  skill: { slug: skill.slug },
                },
              },
            }),
      },
      select: {
        titleNormalized: true,
        companyNormalized: true,
        roleMatchMethod: true,
        outputHash: true,
        skillExtractionStatus: true,
        mentions:
          skill === null
            ? {
                where: { skillId: null, termNormalized: '' },
                select: {
                  rawTerm: true,
                  termNormalized: true,
                  matchMethod: true,
                  extractedFrom: true,
                },
              }
            : {
                where: {
                  rulesetVersion: signal.rulesetVersion,
                  skill: { slug: skill.slug },
                },
                orderBy: [{ extractedFrom: 'asc' }, { termNormalized: 'asc' }],
                select: {
                  rawTerm: true,
                  termNormalized: true,
                  matchMethod: true,
                  extractedFrom: true,
                },
              },
        version: {
          select: {
            contentHash: true,
            rawPayloadHash: true,
            titleRaw: true,
            sourcePublishedAt: true,
            sourceValidThrough: true,
            descriptionCompleteness: true,
            firstSeenRun: {
              select: {
                id: true,
                status: true,
                startedAt: true,
                queryFingerprint: true,
                source: { select: { slug: true, licenceBasis: true } },
              },
            },
            posting: {
              select: {
                id: true,
                externalId: true,
                sourceScope: true,
                lastSeenAt: true,
              },
            },
          },
        },
      },
    });

    /*
     * Ordered on externalId, which is unique and derived from the source's
     * own key - so the order is total AND identical in dev, CI and
     * production. The predicate this replaces ordered by the mention row's
     * uuid, which made the sample a reader saw machine-local: two people
     * checking the same claim by hand got different rows.
     */
    const contributing = [...rows].sort((a, b) =>
      a.version.posting.externalId < b.version.posting.externalId
        ? -1
        : a.version.posting.externalId > b.version.posting.externalId
          ? 1
          : 0,
    );

    /*
     * The latest-in-window rule already gives at most one normalization
     * per posting, so this count is over postings. The old shape counted
     * MENTION rows - unique on (normalization, term, locus) - so a posting
     * matching a skill in both its title and its description produced two
     * rows, and a "sample of 10" could be five postings against a
     * numerator of 22.
     */
    const contributingPostingCount = contributing.length;

    const completeCoverage = await this.prisma.marketRunScopeCoverage.groupBy({
      by: ['sourceScope'],
      where: {
        sourceId: source.id,
        sourceScope: { in: signal.run.scopes },
        completeForScope: true,
        finishedAt: { not: null },
      },
      _max: { finishedAt: true },
    });

    /*
     * Keyed per (source, scope) and filtered to COMPLETE reads.
     *
     * Both halves carry weight. Grouping per source instead would lend one
     * scope's completion certificate to another: JobTech's naturvetenskap
     * finished at 09:19:23, and a per-source maximum would relabel 3999
     * postings on two scopes the offset cap made it impossible to finish
     * reading as FRESH. Dropping completeForScope is worse still -
     * finishedAt is populated even on a scope that 404'd, so a failed read
     * would count as coverage and UNAVAILABLE would become unreachable for
     * all 9628 postings.
     */
    const coverageByScope = new Map(
      completeCoverage.map((row) => [row.sourceScope, row._max.finishedAt]),
    );

    const sample = contributing.slice(0, EXPLAIN_SAMPLE_SIZE).map((row) => ({
      ...row,
      /*
       * Freshness is a property of an OBSERVATION, so it is computed
       * here - where the subject is a posting - from that posting's own
       * lastSeenAt against an injected asOf. No row timestamp reaches
       * it: updatedAt moves whenever anything rewrites the row, and a
       * verdict built from it would report a re-ingest as new market
       * evidence.
       */
      freshness: classifyFreshness({
        asOf,
        lastSeenAt: row.version.posting.lastSeenAt,
        lastCompleteCoverageAt:
          coverageByScope.get(row.version.posting.sourceScope) ?? null,
        sourceValidThrough: row.version.sourceValidThrough,
        pollIntervalHours: source.pollIntervalHours,
        expectedPostingLifetimeDays: source.expectedPostingLifetimeDays,
      }),
    }));

    return {
      data: {
        signal,
        /*
         * Echoed, because a freshness verdict without the instant it was
         * taken at is unreproducible - and every verdict below is a
         * function of it.
         */
        asOf,
        evidence: {
          /*
           * Named rather than left to be inferred from the shape. The two
           * populations differ in a way that changes how the numbers may
           * be read, and a volume signal previously returned a bare empty
           * array - indistinguishable from "we looked and found nothing
           * supports this number", which for an auditability endpoint is
           * the worst available answer.
           */
          kind:
            skill === null
              ? 'ROLE_RESOLVED_POSTINGS'
              : 'ELIGIBLE_POSTINGS_MENTIONING_SKILL',
          source: {
            slug: source.slug,
            mayRedistributeDerived: source.mayRedistributeDerived,
          },
          scopes: signal.run.scopes,
          /*
           * The number the sample is drawn from. Without it the sample
           * cannot be checked against numeratorCount, which is this
           * endpoint's whole purpose - ten rows of unknown provenance
           * prove nothing about a numerator of 22.
           */
          contributingPostingCount,
          sampleSize: sample.length,
          sampleTruncated: contributingPostingCount > sample.length,
          /*
           * The other half of a volume fraction. A sample of the numerator
           * explains only the top of the ratio, and the denominator - every
           * posting that entered role resolution, 6456 of 6671 of which
           * resolved to no role at all - is the number that makes the share
           * honest. These come off the run's own stats; no extra query.
           */
          denominatorComposition: skill === null ? signal.run.stats : null,
          contributing: sample,
        },
      },
    };
  }

  /**
   * Published statistics, with the attribution their licences oblige.
   *
   * Kept separate from the signal endpoints, and that separation is the
   * point. A signal is computed by us from postings we observed; these are
   * figures a statistical agency published. Serving them through one
   * endpoint would invite a reader to add them together, and they do not
   * add - one counts postings, the other counts openings.
   */
  async marketStatistics(limit?: number) {
    const versions = await this.prisma.marketDatasetVersion.findMany({
      where: {
        kind: 'AGGREGATE',
        source: { mayRedistributeDerived: true },
      },
      orderBy: [{ datasetKey: 'asc' }, { version: 'desc' }],
      select: {
        id: true,
        datasetKey: true,
        version: true,
        releasedAt: true,
        retrievedAt: true,
        rowCount: true,
        attribution: true,
        source: { select: { slug: true, displayName: true } },
        observations: {
          orderBy: [{ periodStart: 'desc' }, { seriesKey: 'asc' }],
          take: clampLimit(limit),
          select: {
            seriesKey: true,
            geography: true,
            category: true,
            periodStart: true,
            periodEnd: true,
            periodType: true,
            metric: true,
            value: true,
            unit: true,
          },
        },
      },
    });

    return {
      data: versions.map((version) => ({
        source: version.source,
        datasetKey: version.datasetKey,
        version: version.version,
        /*
         * Both instants, deliberately. releasedAt is the publisher's, and
         * retrievedAt is ours - importing today does not make a 2023
         * release current, and only showing one of them would let it.
         */
        releasedAt: version.releasedAt,
        retrievedAt: version.retrievedAt,
        rowCount: version.rowCount,
        attribution: version.attribution,
        observations: version.observations,
      })),
    };
  }

  /**
   * Occupational vocabulary imported from published taxonomies.
   *
   * These are NOT the canonical roles and skills this phase authored -
   * they are somebody else's assertions, retained separately so a mapping
   * between the two is a reviewable artefact rather than an overwrite.
   */
  async marketOccupations(limit?: number, language?: string) {
    const terms = await this.prisma.marketTaxonomyTerm.findMany({
      where: {
        kind: 'OCCUPATION',
        ...(language === undefined ? {} : { language }),
        datasetVersion: { source: { mayRedistributeDerived: true } },
      },
      orderBy: [{ externalCode: 'asc' }, { label: 'asc' }],
      take: clampLimit(limit),
      select: {
        externalCode: true,
        label: true,
        language: true,
        parentCode: true,
        datasetVersion: {
          select: {
            datasetKey: true,
            version: true,
            attribution: true,
            source: { select: { slug: true } },
          },
        },
      },
    });

    return { data: terms };
  }
}
