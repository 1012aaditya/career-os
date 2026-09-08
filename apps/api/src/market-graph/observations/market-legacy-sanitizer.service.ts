import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  redactContactText,
  redactPayload,
  REDACTION_VERSION,
  type ContactRedaction,
} from '../observations/redaction.js';

/*
 * Sanitizing evidence that was stored BEFORE redaction existed.
 *
 * Redaction protects every future observation and no past one. JobTech and
 * Greenhouse were ingested under contentHashVersion 1, before the
 * redactor, and re-ingesting does not clean them: CONTENT_HASH_VERSION
 * moved to 2, so a re-ingest mints new redacted versions ALONGSIDE the old
 * ones rather than replacing them. Only a rewrite in place removes the
 * legacy rows, and this is it.
 *
 * WHAT THIS COSTS, stated rather than discovered later. A version row's
 * contentHash committed to the text as it was stored. Rewriting that text
 * means the hash no longer reproduces from it. That is inherent to
 * erasure - you cannot both destroy a preimage and keep a commitment to
 * it - and it is confined to contentHashVersion 1 rows, which are already
 * a distinct hash regime from everything ingested since. The alternative,
 * keeping a verifiable hash over personal data we decided not to hold, is
 * worse: it would make the hash an oracle for the very text it commits to.
 *
 * This does NOT weaken the pre-persistence sanitizer. It runs after it,
 * over rows that predate it, and the pipeline redactor is untouched.
 */

const BATCH = 500;

/*
 * Applied to legacy rows. Both national forms are included because the
 * legacy corpus is Swedish and US - a source-specific profile is not
 * available retrospectively, since the row no longer knows which adapter
 * shaped it beyond its source slug.
 */
const LEGACY_REDACTION: ContactRedaction = {
  structuredFields: [
    'application_contacts',
    'employer.email',
    'employer.phone_number',
    'application_details.email',
  ],
  nationalPhone: /\b07[02369][-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b/,
};

export type LegacySanitizeResult = {
  redactionVersion: number;
  scannedVersions: number;
  descriptionsRewritten: number;
  payloadsRewritten: number;
  normalizationTextRewritten: number;
  /** True when a run found nothing left to do. */
  alreadyClean: boolean;
};

@Injectable()
export class MarketLegacySanitizerService {
  constructor(private readonly prisma: PrismaService) {}

  async sanitize(): Promise<LegacySanitizeResult> {
    let scanned = 0;
    let descriptions = 0;
    let payloads = 0;
    let cursor: string | null = null;

    for (;;) {
      const versions: Array<{
        id: string;
        descriptionRaw: string | null;
        rawPayload: Prisma.JsonValue;
      }> = await this.prisma.marketPostingVersion.findMany({
        where: cursor === null ? {} : { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true, descriptionRaw: true, rawPayload: true },
      });

      if (versions.length === 0) {
        break;
      }

      cursor = versions[versions.length - 1]?.id ?? null;

      for (const version of versions) {
        scanned += 1;

        const cleanText = redactContactText(
          version.descriptionRaw,
          LEGACY_REDACTION,
        );

        const payload =
          typeof version.rawPayload === 'object' &&
          version.rawPayload !== null &&
          !Array.isArray(version.rawPayload)
            ? redactPayload(
                version.rawPayload as Record<string, unknown>,
                LEGACY_REDACTION,
              )
            : null;

        const textChanged = cleanText !== version.descriptionRaw;
        const payloadChanged =
          payload !== null &&
          JSON.stringify(payload) !== JSON.stringify(version.rawPayload);

        /*
         * Only rows that actually change are written. That is what makes a
         * second run a genuine no-op rather than a rewrite of everything
         * with the same values.
         */
        if (!textChanged && !payloadChanged) {
          continue;
        }

        const data: Prisma.MarketPostingVersionUpdateInput = {};

        if (textChanged) {
          data.descriptionRaw = cleanText;
        }

        if (payloadChanged && payload !== null) {
          data.rawPayload = payload as Prisma.InputJsonValue;
        }

        await this.prisma.marketPostingVersion.update({
          where: { id: version.id },
          data,
        });

        if (textChanged) descriptions += 1;
        if (payloadChanged) payloads += 1;
      }
    }

    const normalizations = await this.sanitizeNormalizations();

    return {
      redactionVersion: REDACTION_VERSION,
      scannedVersions: scanned,
      descriptionsRewritten: descriptions,
      payloadsRewritten: payloads,
      normalizationTextRewritten: normalizations,
      alreadyClean:
        descriptions === 0 && payloads === 0 && normalizations === 0,
    };
  }

  /**
   * descriptionText mirrors descriptionRaw, once per ruleset version, so a
   * contaminated body exists in as many copies as there are rulesets.
   */
  private async sanitizeNormalizations(): Promise<number> {
    let rewritten = 0;
    let cursor: string | null = null;

    for (;;) {
      const rows: Array<{ id: string; descriptionText: string | null }> =
        await this.prisma.marketPostingNormalization.findMany({
          where: {
            descriptionText: { not: null },
            ...(cursor === null ? {} : { id: { gt: cursor } }),
          },
          orderBy: { id: 'asc' },
          take: BATCH,
          select: { id: true, descriptionText: true },
        });

      if (rows.length === 0) {
        return rewritten;
      }

      cursor = rows[rows.length - 1]?.id ?? null;

      for (const row of rows) {
        const clean = redactContactText(row.descriptionText, LEGACY_REDACTION);

        if (clean === row.descriptionText) {
          continue;
        }

        await this.prisma.marketPostingNormalization.update({
          where: { id: row.id },
          data: { descriptionText: clean },
        });

        rewritten += 1;
      }
    }
  }
}
