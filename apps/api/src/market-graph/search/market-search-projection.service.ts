import { Injectable } from '@nestjs/common';

import { canonicalHash } from '../../common/canonical-hash.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { tokenize } from '../normalization/normalize.js';
import { RULESET_VERSION } from '../normalization/ruleset.js';
import { projectLocation } from './search-query.js';
import { SEARCH_PROJECTION_VERSION } from './search-ruleset.js';

/*
 * Building the search projection.
 *
 * Reads Phase 8 evidence and Phase 9 normalization; writes only
 * MarketPostingSearchDocument. It cannot corrupt anything upstream because
 * it never opens a write to anything upstream - the guarantee is
 * structural rather than a promise, and a boundary test holds it there.
 *
 * IDEMPOTENT, by content hash and not by "we ran it already". Every
 * document carries a hash of everything it asserts; a rebuild recomputes
 * the hash and writes only where it differs. So a second run over an
 * unchanged corpus writes zero rows, an interrupted run resumes with no
 * duplicate work, and a projection that has silently diverged from its
 * evidence is discovered rather than assumed away.
 *
 * Runs from the CLI, never from an HTTP request. Search is read-only and
 * building an index is not a thing a phone should be able to trigger.
 */

/** How many postings are read, built and written per round trip. */
const BATCH = 500;

export type ProjectionResult = {
  projectionVersion: number;
  rulesetVersion: number;
  postingsScanned: number;
  documentsWritten: number;
  documentsUnchanged: number;
  /**
   * Postings with no normalization at the current ruleset version.
   *
   * Counted and NOT projected. A document built without one would carry
   * no role and no skills while looking exactly like a posting that
   * genuinely resolved to neither, so the honest move is to leave it out
   * of the index and report the number - it names precisely how much of
   * the corpus is waiting on a re-normalization.
   */
  postingsWithoutNormalization: number;
};

type PostingRow = {
  id: string;
  sourceId: string;
  sourceScope: string;
  externalId: string;
  externalGroupKey: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  applyUrlCanonical: string | null;
};

@Injectable()
export class MarketSearchProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async project(projectedAt: Date): Promise<ProjectionResult> {
    const sourceSlugs = await this.sourceSlugs();
    const roleLabels = await this.roleLabels();
    const skillLabels = await this.skillLabels();

    let cursor: string | null = null;
    let scanned = 0;
    let written = 0;
    let unchanged = 0;
    let missing = 0;

    for (;;) {
      const postings: PostingRow[] = await this.prisma.marketPosting.findMany({
        where: cursor === null ? {} : { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: {
          id: true,
          sourceId: true,
          sourceScope: true,
          externalId: true,
          externalGroupKey: true,
          firstSeenAt: true,
          lastSeenAt: true,
          applyUrlCanonical: true,
        },
      });

      if (postings.length === 0) {
        break;
      }

      cursor = postings[postings.length - 1]?.id ?? null;
      scanned += postings.length;

      const ids = postings.map((posting) => posting.id);
      const currentVersion = await this.currentVersions(ids);
      const versionIds = [...currentVersion.values()];
      const content = await this.versionContent(versionIds);
      const normalized = await this.normalizations(versionIds);
      const existing = await this.existingHashes(ids);

      for (const posting of postings) {
        const versionId = currentVersion.get(posting.id);
        const version =
          versionId === undefined ? undefined : content.get(versionId);
        const norm =
          versionId === undefined ? undefined : normalized.get(versionId);

        if (versionId === undefined || version === undefined) {
          /* A posting with no version cannot exist; treat as unprojectable. */
          missing += 1;
          continue;
        }

        if (norm === undefined) {
          missing += 1;
          continue;
        }

        const sourceSlug = sourceSlugs.get(posting.sourceId);

        if (sourceSlug === undefined) {
          missing += 1;
          continue;
        }

        const roleSlug =
          norm.roleId === null
            ? null
            : (roleLabels.get(norm.roleId)?.slug ?? null);
        const roleLabel =
          norm.roleId === null
            ? null
            : (roleLabels.get(norm.roleId)?.label ?? null);

        const skills = norm.skillIds
          .map((id) => skillLabels.get(id))
          .filter(
            (skill): skill is { slug: string; label: string } =>
              skill !== undefined,
          );

        const location = projectLocation(version.locationRaw);

        const titleTokens = [...new Set(tokenize(version.titleRaw))].sort();

        /*
         * The free-text index: title, company, location, the canonical
         * role's LABEL and every mentioned skill's label.
         *
         * The role label is here so that searching "software engineer"
         * reaches a posting titled "Utvecklare" that Phase 9 resolved to
         * the software-engineer role - which is the whole reason the
         * canonical vocabulary was built. Slugs are not indexed: a slug
         * is an internal key, and matching one would make the API's
         * behaviour depend on a naming convention no caller can see.
         */
        const searchTokens = [
          ...new Set([
            ...titleTokens,
            ...tokenize(version.companyRaw ?? ''),
            ...location.tokens,
            ...tokenize(roleLabel ?? ''),
            ...skills.flatMap((skill) => tokenize(skill.label)),
          ]),
        ].sort();

        const document = {
          postingId: posting.id,
          projectionVersion: SEARCH_PROJECTION_VERSION,
          rulesetVersion: RULESET_VERSION,
          sourceId: posting.sourceId,
          sourceSlug,
          sourceScope: posting.sourceScope,
          versionId,
          externalId: posting.externalId,
          titleRaw: version.titleRaw,
          titleNormalized: norm.titleNormalized,
          titleTokens,
          companyRaw: version.companyRaw,
          companyNormalized: norm.companyNormalized,
          locationRaw: version.locationRaw,
          locationNormalized: location.normalized,
          locationTokens: location.tokens,
          roleSlug,
          skillSlugs: [...new Set(skills.map((skill) => skill.slug))].sort(),
          searchTokens,
          sourcePublishedAt: version.sourcePublishedAt,
          sourceValidThrough: version.sourceValidThrough,
          firstSeenAt: posting.firstSeenAt,
          lastSeenAt: posting.lastSeenAt,
          /*
           * The canonical apply URL where one exists, and the version's
           * raw one otherwise. Never a URL we constructed: Shipaton is
           * not the employer and the destination has to be the
           * publisher's own page.
           */
          applyUrl: posting.applyUrlCanonical ?? version.applyUrlRaw,
          groupKey: posting.externalGroupKey,
        };

        /*
         * Dates go into the hash as ISO strings. canonicalJson refuses a
         * Date outright - it has no unambiguous JSON form - and that
         * refusal is what stops a hash quietly depending on how a driver
         * chose to serialise a timestamp.
         */
        const contentHash = canonicalHash({
          ...document,
          sourcePublishedAt: document.sourcePublishedAt?.toISOString() ?? null,
          sourceValidThrough:
            document.sourceValidThrough?.toISOString() ?? null,
          firstSeenAt: document.firstSeenAt.toISOString(),
          lastSeenAt: document.lastSeenAt.toISOString(),
        });

        if (existing.get(posting.id) === contentHash) {
          unchanged += 1;
          continue;
        }

        const row = { ...document, contentHash, projectedAt };

        await this.prisma.marketPostingSearchDocument.upsert({
          where: { postingId: posting.id },
          create: row,
          update: row,
        });

        written += 1;
      }
    }

    return {
      projectionVersion: SEARCH_PROJECTION_VERSION,
      rulesetVersion: RULESET_VERSION,
      postingsScanned: scanned,
      documentsWritten: written,
      documentsUnchanged: unchanged,
      postingsWithoutNormalization: missing,
    };
  }

  private async sourceSlugs(): Promise<Map<string, string>> {
    const sources = await this.prisma.marketSource.findMany({
      select: { id: true, slug: true },
    });

    return new Map(sources.map((source) => [source.id, source.slug]));
  }

  private async roleLabels(): Promise<
    Map<string, { slug: string; label: string }>
  > {
    const roles = await this.prisma.marketRole.findMany({
      select: { id: true, slug: true, label: true },
    });

    return new Map(
      roles.map((role) => [role.id, { slug: role.slug, label: role.label }]),
    );
  }

  private async skillLabels(): Promise<
    Map<string, { slug: string; label: string }>
  > {
    const skills = await this.prisma.marketSkill.findMany({
      select: { id: true, slug: true, label: true },
    });

    return new Map(
      skills.map((skill) => [
        skill.id,
        { slug: skill.slug, label: skill.label },
      ]),
    );
  }

  /**
   * Each posting's CURRENT version, decided by its latest sighting.
   *
   * Not "the newest version row": MarketPostingVersion has no ordering of
   * its own, and createdAt is our clock rather than the market's. The
   * sighting is what records that a version was the one actually being
   * advertised at an observed instant, and (observedAt, runSeq) is a
   * total order over sightings by construction - runSeq exists precisely
   * because two sightings can share a millisecond.
   */
  private async currentVersions(
    postingIds: string[],
  ): Promise<Map<string, string>> {
    const sightings = await this.prisma.marketPostingSighting.findMany({
      where: { postingId: { in: postingIds } },
      select: {
        postingId: true,
        versionId: true,
        observedAt: true,
        runSeq: true,
      },
    });

    const best = new Map<
      string,
      { versionId: string; observedAt: number; runSeq: number }
    >();

    for (const sighting of sightings) {
      const current = best.get(sighting.postingId);
      const observedAt = sighting.observedAt.getTime();

      const wins =
        current === undefined ||
        observedAt > current.observedAt ||
        (observedAt === current.observedAt &&
          sighting.runSeq > current.runSeq) ||
        /* Final tie-break, so the choice never depends on row order. */
        (observedAt === current.observedAt &&
          sighting.runSeq === current.runSeq &&
          sighting.versionId < current.versionId);

      if (wins) {
        best.set(sighting.postingId, {
          versionId: sighting.versionId,
          observedAt,
          runSeq: sighting.runSeq,
        });
      }
    }

    return new Map(
      [...best].map(([postingId, row]) => [postingId, row.versionId]),
    );
  }

  private async versionContent(versionIds: string[]): Promise<
    Map<
      string,
      {
        titleRaw: string;
        companyRaw: string | null;
        locationRaw: string | null;
        applyUrlRaw: string | null;
        sourcePublishedAt: Date | null;
        sourceValidThrough: Date | null;
      }
    >
  > {
    const versions = await this.prisma.marketPostingVersion.findMany({
      where: { id: { in: versionIds } },
      /*
       * descriptionRaw and rawPayload are deliberately absent. The
       * projection indexes neither, so reading them would carry a body
       * across a boundary for no purpose - and a select is the only thing
       * standing between a findMany and every column of the row.
       */
      select: {
        id: true,
        titleRaw: true,
        companyRaw: true,
        locationRaw: true,
        applyUrlRaw: true,
        sourcePublishedAt: true,
        sourceValidThrough: true,
      },
    });

    return new Map(versions.map(({ id, ...rest }) => [id, rest]));
  }

  private async normalizations(versionIds: string[]): Promise<
    Map<
      string,
      {
        titleNormalized: string;
        companyNormalized: string | null;
        roleId: string | null;
        skillIds: string[];
      }
    >
  > {
    const rows = await this.prisma.marketPostingNormalization.findMany({
      where: { versionId: { in: versionIds }, rulesetVersion: RULESET_VERSION },
      select: {
        versionId: true,
        titleNormalized: true,
        companyNormalized: true,
        roleId: true,
        mentions: {
          where: { skillId: { not: null } },
          select: { skillId: true },
        },
      },
    });

    return new Map(
      rows.map((row) => [
        row.versionId,
        {
          titleNormalized: row.titleNormalized,
          companyNormalized: row.companyNormalized,
          roleId: row.roleId,
          skillIds: row.mentions
            .map((mention) => mention.skillId)
            .filter((id): id is string => id !== null),
        },
      ]),
    );
  }

  private async existingHashes(
    postingIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.prisma.marketPostingSearchDocument.findMany({
      where: {
        postingId: { in: postingIds },
        projectionVersion: SEARCH_PROJECTION_VERSION,
        rulesetVersion: RULESET_VERSION,
      },
      select: { postingId: true, contentHash: true },
    });

    return new Map(rows.map((row) => [row.postingId, row.contentHash]));
  }
}
