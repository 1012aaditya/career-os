import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
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

  async ensureGreenhouseSource(): Promise<{
    id: string;
    slug: string;
    isEnabled: boolean;
  }> {
    return this.prisma.marketSource.upsert({
      where: { slug: 'greenhouse' },
      /*
       * update is empty on purpose. Operational columns - isEnabled, the
       * expected posting lifetime, the poll interval - are meant to be
       * tuned in the database from real observation, and a deploy that
       * reset them to the code's defaults would silently undo that
       * tuning every time the process restarted.
       */
      update: {},
      create: {
        slug: 'greenhouse',
        displayName: 'Greenhouse Job Boards',
        kind: 'JOB_BOARD',
        identityBasis: 'SOURCE_ID',
        /*
         * Not a grant. No terms of service governing this API were found;
         * the endpoint is documented as public, unauthenticated and
         * intended for third parties, and carries no clause forbidding
         * aggregation or requiring deletion. Recorded as its own value so
         * the position is queryable rather than remembered.
         */
        licenceBasis: 'UNADDRESSED_PUBLIC_ENDPOINT',
        licenceNote:
          'No terms of service governing the public Job Board API were found on 2026-09-08. The endpoint is documented as public, unauthenticated and intended for third parties, and carries no clause forbidding aggregation or requiring deletion - which is the inverse of Adzuna, whose terms name aggregation into vacancy counts in their prohibited list. This is an unresolved position, not a grant.',
        licenceReviewedAt: new Date('2026-09-08T00:00:00.000Z'),
        /*
         * Set explicitly, against a schema default of false.
         *
         * The default fails closed because the licence position is the one
         * dimension this phase admits is unresolved, and a source should
         * not become live as a side effect of inserting a row. Enabling it
         * here is a deliberate act by somebody who read the note above.
         */
        isEnabled: true,
        /*
         * Left false. Ingesting for internal analysis and publishing
         * derived aggregates to users are different permissions, and only
         * the first has been reasoned about.
         */
        mayRedistributeDerived: false,
      },
      select: { id: true, slug: true, isEnabled: true },
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
