import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  IdentityBasis,
  SourceDescriptor,
} from '../sources/source-adapter.js';
import type { SourceAccessState } from '../sources/source-access.js';
import {
  ROLE_ALIASES,
  ROLES,
  RULESET_VERSION,
  SKILL_ALIASES,
  SKILLS,
} from '../normalization/ruleset.js';

/*
 * Projects the versioned ruleset in code into the vocabulary tables.
 *
 * The ruleset file is the source of truth; these rows are a materialized
 * copy that exists so a signal can carry a foreign key to a role and a
 * skill rather than a bare string. Normalization never reads them back -
 * a normalizer that consulted mutable database state would be a function
 * of that state and its output could not be reproduced.
 *
 * Idempotent, and append-only in effect: syncing twice writes nothing the
 * second time, and nothing is ever deleted. A role that disappears from
 * the ruleset keeps its row, because historical signals reference it and
 * a foreign key that stops resolving is a signal that stops being
 * explainable.
 */
@Injectable()
export class MarketVocabularyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ensures a source row exists for a descriptor, and returns it.
   *
   * Generic, taking the descriptor the source itself declares. It used to
   * be `ensureGreenhouseSource()` with one source's slug, licence note and
   * enabled flag written into the body of a service whose job is
   * projecting the ruleset - so the vocabulary layer carried one source's
   * legal position as a code literal.
   */
  /**
   * The MarketSource row for a published DATASET rather than a job board.
   *
   * Same row, same licence columns, different kind - so purge, licence
   * enforcement and the read side all keep working unchanged. The empty
   * update block is kept for the same reason as above: an operator's
   * decision to disable a source must survive a deploy.
   *
   * identityBasis is SOURCE_ID because a dataset row is identified by the
   * publisher's own code, and the column is required. It is never used to
   * mint a posting externalId, because datasets produce no postings.
   */
  async ensureDatasetSource(descriptor: {
    slug: string;
    displayName: string;
    licenceBasis:
      'EXPLICIT_GRANT' | 'UNADDRESSED_PUBLIC_ENDPOINT' | 'CONTRACTED';
    licenceNote: string;
    licenceReviewedAt: Date;
    isEnabled: boolean;
    mayRedistributeDerived: boolean;
  }): Promise<{ id: string; slug: string }> {
    return this.prisma.marketSource.upsert({
      where: { slug: descriptor.slug },
      update: {},
      create: {
        slug: descriptor.slug,
        displayName: descriptor.displayName,
        kind: 'SKILL_TAXONOMY',
        /*
         * A published dataset is an open release by its publisher, which
         * is what PUBLIC_OPEN_DATA means. Every dataset in the registry is
         * a government or public-body file under a stated licence.
         */
        category: 'PUBLIC_OPEN_DATA',
        /*
         * Datasets are bulk files behind no gate and no credential, and
         * every one of them carries an affirmative licence - so the
         * lifecycle that exists for negotiated access has nothing to
         * negotiate here. ENABLED where the descriptor says enabled, and
         * DISABLED rather than a half-state where it does not.
         */
        accessState: descriptor.isEnabled ? 'ENABLED' : 'DISABLED',
        requiresCredentials: false,
        identityBasis: 'SOURCE_ID',
        licenceBasis: descriptor.licenceBasis,
        licenceNote: descriptor.licenceNote,
        licenceReviewedAt: descriptor.licenceReviewedAt,
        isEnabled: descriptor.isEnabled,
        mayRedistributeDerived: descriptor.mayRedistributeDerived,
      },
      select: { id: true, slug: true },
    });
  }

  async ensureSource(descriptor: SourceDescriptor): Promise<{
    id: string;
    slug: string;
    isEnabled: boolean;
    accessState: SourceAccessState;
    identityBasis: IdentityBasis;
  }> {
    const enabledByAccess = descriptor.access.state === 'ENABLED';

    return this.prisma.marketSource.upsert({
      where: { slug: descriptor.slug },
      /*
       * The update block used to be empty, and Phase 11 splits the reason
       * it was empty from the thing that reason was protecting.
       *
       * The original argument still stands for OPERATIONAL columns.
       * isEnabled, expectedPostingLifetimeDays and pollIntervalHours are
       * tuned in the database from real observation, and a deploy that
       * reset them to the code's declaration would silently undo that
       * tuning on every restart. They stay untouched.
       *
       * It never stood for REVIEW columns. The access state, the category,
       * the attribution obligation and the licence position are decided in
       * code, in review, under version control - and leaving them out of
       * the update meant a decision could be taken, merged, and never
       * reach the row. That was live rather than hypothetical: two
       * descriptors moved to `isEnabled: false` and neither row changed,
       * because rows are not created twice, so this database held an
       * enabled Greenhouse for as long as anybody cared to look.
       *
       * So review columns are written on every sync, and the one
       * operational column they may touch, they may only touch in the
       * SAFE direction: a declaration that is not ENABLED forces
       * isEnabled false. An operator can still switch an approved source
       * off and have that survive; nobody can switch an unapproved one on.
       */
      update: {
        displayName: descriptor.displayName,
        category: descriptor.category,
        accessState: descriptor.access.state,
        accessNote: descriptor.access.note,
        accessReviewedAt: descriptor.access.reviewedAt,
        requiresCredentials: descriptor.credentials !== null,
        attribution: descriptor.attribution,
        licenceBasis: descriptor.licenceBasis,
        licenceNote: descriptor.licenceNote,
        licenceReviewedAt: descriptor.licenceReviewedAt,
        mayRedistributeDerived: descriptor.mayRedistributeDerived,
        ...(enabledByAccess ? {} : { isEnabled: false }),
      },
      create: {
        slug: descriptor.slug,
        displayName: descriptor.displayName,
        kind: 'JOB_BOARD',
        identityBasis: descriptor.adapter.identityBasis,
        category: descriptor.category,
        accessState: descriptor.access.state,
        accessNote: descriptor.access.note,
        accessReviewedAt: descriptor.access.reviewedAt,
        /*
         * A boolean, from whether a requirement was declared. The KEY
         * NAMES stay in code and the values stay in the environment;
         * neither belongs in a row a read path could select.
         */
        requiresCredentials: descriptor.credentials !== null,
        attribution: descriptor.attribution,
        licenceBasis: descriptor.licenceBasis,
        licenceNote: descriptor.licenceNote,
        licenceReviewedAt: descriptor.licenceReviewedAt,
        /*
         * Taken from the descriptor against a schema default of false, so
         * enabling a source remains an act somebody performed rather than
         * a consequence of inserting a row - and ANDed with the access
         * state, so the two cannot be inserted disagreeing. The database
         * refuses that combination outright as well; this is the same rule
         * said twice, on purpose, because it is the rule that decides
         * whether an unapproved provider can be walked.
         */
        isEnabled: descriptor.isEnabled && enabledByAccess,
        mayRedistributeDerived: descriptor.mayRedistributeDerived,
      },
      select: {
        id: true,
        slug: true,
        isEnabled: true,
        accessState: true,
        identityBasis: true,
      },
    });
  }

  /** Writes roles, skills and their aliases for the current ruleset. */
  async syncVocabulary(): Promise<{
    roles: number;
    skills: number;
    roleAliases: number;
    skillAliases: number;
  }> {
    for (const role of ROLES) {
      await this.prisma.marketRole.upsert({
        where: { slug: role.slug },
        update: { label: role.label },
        create: {
          slug: role.slug,
          label: role.label,
          introducedInRulesetVersion: RULESET_VERSION,
        },
      });
    }

    for (const skill of SKILLS) {
      await this.prisma.marketSkill.upsert({
        where: { slug: skill.slug },
        update: { label: skill.label },
        create: {
          slug: skill.slug,
          label: skill.label,
          introducedInRulesetVersion: RULESET_VERSION,
        },
      });
    }

    const roleIds = await this.slugIndex('role');
    const skillIds = await this.slugIndex('skill');

    /*
     * Aliases are written in sorted key order. The set is the same either
     * way, but a deterministic write order makes two runs of this method
     * produce identical database logs, which is what lets a diff of two
     * environments mean something.
     */
    for (const alias of Object.keys(ROLE_ALIASES).sort()) {
      const slug = ROLE_ALIASES[alias];
      const roleId = slug === undefined ? undefined : roleIds.get(slug);

      if (roleId === undefined) {
        continue;
      }

      await this.prisma.marketRoleAlias.upsert({
        where: {
          rulesetVersion_aliasNormalized: {
            rulesetVersion: RULESET_VERSION,
            aliasNormalized: alias,
          },
        },
        update: {},
        create: {
          rulesetVersion: RULESET_VERSION,
          aliasNormalized: alias,
          roleId,
        },
      });
    }

    for (const alias of Object.keys(SKILL_ALIASES).sort()) {
      const slug = SKILL_ALIASES[alias];
      const skillId = slug === undefined ? undefined : skillIds.get(slug);

      if (skillId === undefined) {
        continue;
      }

      await this.prisma.marketSkillAlias.upsert({
        where: {
          rulesetVersion_aliasNormalized: {
            rulesetVersion: RULESET_VERSION,
            aliasNormalized: alias,
          },
        },
        update: {},
        create: {
          rulesetVersion: RULESET_VERSION,
          aliasNormalized: alias,
          skillId,
        },
      });
    }

    return {
      roles: ROLES.length,
      skills: SKILLS.length,
      roleAliases: Object.keys(ROLE_ALIASES).length,
      skillAliases: Object.keys(SKILL_ALIASES).length,
    };
  }

  async slugIndex(kind: 'role' | 'skill'): Promise<Map<string, string>> {
    const rows =
      kind === 'role'
        ? await this.prisma.marketRole.findMany({
            select: { id: true, slug: true },
            orderBy: { slug: 'asc' },
          })
        : await this.prisma.marketSkill.findMany({
            select: { id: true, slug: true },
            orderBy: { slug: 'asc' },
          });

    return new Map(rows.map((row) => [row.slug, row.id]));
  }

  async aliasIndex(kind: 'role' | 'skill'): Promise<Map<string, string>> {
    const rows =
      kind === 'role'
        ? await this.prisma.marketRoleAlias.findMany({
            where: { rulesetVersion: RULESET_VERSION },
            select: { id: true, aliasNormalized: true },
            orderBy: { aliasNormalized: 'asc' },
          })
        : await this.prisma.marketSkillAlias.findMany({
            where: { rulesetVersion: RULESET_VERSION },
            select: { id: true, aliasNormalized: true },
            orderBy: { aliasNormalized: 'asc' },
          });

    return new Map(rows.map((row) => [row.aliasNormalized, row.id]));
  }
}
