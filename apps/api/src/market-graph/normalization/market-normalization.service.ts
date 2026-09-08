import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { MarketVocabularyService } from '../ingestion/market-vocabulary.service.js';
import type { RawPostingRecord } from '../sources/source-adapter.js';
import { normalizePosting } from './normalize.js';
import { RULESET_VERSION } from './ruleset.js';

/*
 * Applies the pure normalizer to stored posting versions and records what
 * it decided.
 *
 * Append-only. A version normalized under ruleset v1 keeps its v1 row
 * forever; running v2 writes new rows beside it. Nothing here updates a
 * normalization or a mention, which is what makes a six-month-old signal
 * still explainable under the rules that produced it.
 */

/** A ceiling, so one call cannot walk an unbounded table. */
const DEFAULT_BATCH = 500;

export class NormalizationNotDeterministicError extends Error {
  readonly versionId: string;

  constructor(versionId: string) {
    super(`Normalization is not deterministic for version ${versionId}`);
    this.name = 'NormalizationNotDeterministicError';
    this.versionId = versionId;
  }
}

function isDuplicateNormalization(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class MarketNormalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vocabulary: MarketVocabularyService,
  ) {}

  /**
   * Normalizes every stored version that has no row for this ruleset
   * version yet.
   *
   * `now` is injected. It is written to `normalizedAt` and to nothing
   * else - no posting, no version and no sighting timestamp is touched
   * here, because normalizing is not observing and a backfill that moved
   * an observation time would be fabricating freshness.
   */
  async normalizePending(input: {
    now: Date;
    batchSize?: number;
  }): Promise<{
    normalized: number;
    mentions: number;
    unresolvedRoles: number;
  }> {
    const roleIds = await this.vocabulary.slugIndex('role');
    const skillIds = await this.vocabulary.slugIndex('skill');
    const roleAliasIds = await this.vocabulary.aliasIndex('role');
    const skillAliasIds = await this.vocabulary.aliasIndex('skill');

    const versions = await this.prisma.marketPostingVersion.findMany({
      where: {
        normalizations: { none: { rulesetVersion: RULESET_VERSION } },
      },
      /*
       * Explicit and total. `id` is unique, so the walk is stable across
       * batches; without an orderBy Postgres promises nothing and a batch
       * could revisit or skip rows as the plan changes.
       */
      orderBy: { id: 'asc' },
      take: input.batchSize ?? DEFAULT_BATCH,
      select: {
        id: true,
        titleRaw: true,
        companyRaw: true,
        locationRaw: true,
        descriptionRaw: true,
        descriptionCompleteness: true,
        sourcePublishedAt: true,
        sourceUpdatedAt: true,
        sourceValidThrough: true,
        applyUrlRaw: true,
        sourceCategoriesRaw: true,
        posting: { select: { externalKey: true, sourceScope: true } },
      },
    });

    let mentionCount = 0;
    let unresolvedRoles = 0;

    for (const version of versions) {
      const record: RawPostingRecord = {
        externalKey: version.posting.externalKey,
        sourceScope: version.posting.sourceScope,
        titleRaw: version.titleRaw,
        companyRaw: version.companyRaw,
        locationRaw: version.locationRaw,
        descriptionRaw: version.descriptionRaw,
        descriptionCompleteness: version.descriptionCompleteness,
        sourcePublishedAt: version.sourcePublishedAt?.toISOString() ?? null,
        sourceUpdatedAt: version.sourceUpdatedAt?.toISOString() ?? null,
        sourceValidThrough: version.sourceValidThrough?.toISOString() ?? null,
        applyUrlRaw: version.applyUrlRaw,
        sourceCategoriesRaw: version.sourceCategoriesRaw,
        externalGroupKey: null,
        payload: {},
      };

      const normalized = normalizePosting(record);

      if (normalized.roleSlug === null) {
        unresolvedRoles += 1;
      }

      /*
       * Read-and-compare, not a reliance on the unique constraint.
       *
       * A P2002 says "a row exists"; it does not say "the normalizer
       * agreed with itself". And the mentions live in another table, so a
       * hash over the parent row alone would never notice them - which is
       * why outputHash covers the mentions too.
       */
      const prior = await this.prisma.marketPostingNormalization.findUnique({
        where: {
          versionId_rulesetVersion: {
            versionId: version.id,
            rulesetVersion: RULESET_VERSION,
          },
        },
        select: { outputHash: true },
      });

      if (prior !== null) {
        if (prior.outputHash !== normalized.outputHash) {
          throw new NormalizationNotDeterministicError(version.id);
        }

        continue;
      }

      const roleId =
        normalized.roleSlug === null
          ? null
          : (roleIds.get(normalized.roleSlug) ?? null);

      const roleAliasId =
        normalized.roleAliasKey === null
          ? null
          : (roleAliasIds.get(normalized.roleAliasKey) ?? null);

      /*
       * The CHECK constraint requires roleId IS NULL exactly when the
       * method is UNMAPPED. If the vocabulary has not been synced the slug
       * will not resolve, and reporting UNMAPPED then would be a lie about
       * why - so the mismatch is refused here rather than written.
       */
      const roleMatchMethod =
        roleId === null ? 'UNMAPPED' : normalized.roleMatchMethod;

      let created: { id: string };

      try {
        created = await this.prisma.marketPostingNormalization.create({
          data: {
            versionId: version.id,
            rulesetVersion: RULESET_VERSION,
            titleNormalized: normalized.titleNormalized,
            roleId,
            roleMatchMethod,
            roleAliasId,
            titleModifierRaw: normalized.titleModifierRaw,
            companyNormalized: normalized.companyNormalized,
            descriptionText: normalized.descriptionText,
            skillExtractionStatus: normalized.skillExtractionStatus,
            outputHash: normalized.outputHash,
            normalizedAt: input.now,
          },
          select: { id: true },
        });
      } catch (error) {
        /*
         * Another process normalized this version between the read above
         * and this write. The `none` filter on the batch query is not
         * transactional, so two normalizers can legitimately select the
         * same version - and without this the loser would crash the run on
         * an unhandled P2002.
         *
         * The recovery is also where the determinism guard actually bites.
         * A unique violation says "a row exists"; it does not say the two
         * normalizers agreed. So the winner's hash is read back and
         * compared, and a mismatch is fatal rather than ignored: it means
         * either the normalizer is not a pure function of its input, or
         * the ruleset changed without RULESET_VERSION changing with it.
         * Both make every number computed under this version a lie about
         * which rules produced it.
         */
        if (!isDuplicateNormalization(error)) {
          throw error;
        }

        const winner = await this.prisma.marketPostingNormalization.findUnique({
          where: {
            versionId_rulesetVersion: {
              versionId: version.id,
              rulesetVersion: RULESET_VERSION,
            },
          },
          select: { outputHash: true },
        });

        if (winner !== null && winner.outputHash !== normalized.outputHash) {
          throw new NormalizationNotDeterministicError(version.id);
        }

        continue;
      }

      for (const mention of normalized.mentions) {
        const skillId =
          mention.skillSlug === null
            ? null
            : (skillIds.get(mention.skillSlug) ?? null);

        await this.prisma.marketPostingSkillMention.create({
          data: {
            normalizationId: created.id,
            rulesetVersion: RULESET_VERSION,
            rawTerm: mention.rawTerm,
            termNormalized: mention.termNormalized,
            skillId,
            aliasId:
              mention.aliasKey === null
                ? null
                : (skillAliasIds.get(mention.aliasKey) ?? null),
            matchMethod: skillId === null ? 'UNMAPPED' : mention.matchMethod,
            extractedFrom: mention.extractedFrom,
          },
        });

        mentionCount += 1;
      }
    }

    return {
      normalized: versions.length,
      mentions: mentionCount,
      unresolvedRoles,
    };
  }
}
