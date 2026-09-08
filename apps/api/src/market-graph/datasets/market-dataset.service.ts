import { ConflictException, Injectable } from '@nestjs/common';

import { canonicalHash } from '../../common/canonical-hash.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { DatasetSource } from './dataset-source.js';

/*
 * Importing a published dataset.
 *
 * One path for taxonomy and aggregates alike. The version is the unit of
 * identity: re-importing the same published version is a no-op, and a new
 * published version is a new row rather than an overwrite - so a statistic
 * computed against O*NET 31.0 stays reproducible after 31.1 lands.
 */

const IMPORT_BATCH = 5_000;

export type DatasetImportResult = {
  datasetVersionId: string;
  sourceSlug: string;
  datasetKey: string;
  version: string;
  rowCount: number;
  /** True when this exact published version was already stored. */
  alreadyImported: boolean;
  contentHash: string;
};

@Injectable()
export class MarketDatasetService {
  constructor(private readonly prisma: PrismaService) {}

  async import(
    dataset: DatasetSource,
    now: Date,
  ): Promise<DatasetImportResult> {
    const source = await this.prisma.marketSource.findUnique({
      where: { slug: dataset.sourceSlug },
      select: { id: true, isEnabled: true },
    });

    if (source === null) {
      throw new ConflictException(`Unknown source: ${dataset.sourceSlug}`);
    }

    if (!source.isEnabled) {
      throw new ConflictException(`Source ${dataset.sourceSlug} is disabled`);
    }

    const fetched = await dataset.fetch();

    const rows =
      dataset.kind === 'TAXONOMY' ? fetched.terms : fetched.observations;

    if (rows.length === 0) {
      /*
       * An empty dataset is a failed fetch reported as a published truth.
       * Refused for the same reason a zero-observation signal run is
       * FAILED rather than SUCCEEDED.
       */
      throw new ConflictException(
        `${dataset.datasetKey} returned no rows; refusing to record an empty version`,
      );
    }

    /*
     * The hash is over the parsed rows, so re-importing the same published
     * version is provably the same bytes - and a publisher silently
     * changing a file under a version number is detectable rather than
     * silently absorbed.
     */
    const contentHash = canonicalHash(rows);

    const existing = await this.prisma.marketDatasetVersion.findUnique({
      where: {
        sourceId_datasetKey_version: {
          sourceId: source.id,
          datasetKey: dataset.datasetKey,
          version: fetched.version,
        },
      },
      select: { id: true, contentHash: true, rowCount: true },
    });

    if (existing !== null) {
      if (existing.contentHash !== contentHash) {
        throw new ConflictException(
          `${dataset.datasetKey} ${fetched.version} was already imported with a different content hash; the publisher changed a released version`,
        );
      }

      return {
        datasetVersionId: existing.id,
        sourceSlug: dataset.sourceSlug,
        datasetKey: dataset.datasetKey,
        version: fetched.version,
        rowCount: existing.rowCount,
        alreadyImported: true,
        contentHash,
      };
    }

    const created = await this.prisma.marketDatasetVersion.create({
      data: {
        sourceId: source.id,
        kind: dataset.kind,
        datasetKey: dataset.datasetKey,
        version: fetched.version,
        releasedAt:
          fetched.releasedAt === null ? null : new Date(fetched.releasedAt),
        retrievedAt: now,
        contentHash,
        rowCount: rows.length,
        attribution: dataset.attribution,
      },
      select: { id: true },
    });

    for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
      const batch = rows.slice(i, i + IMPORT_BATCH);

      if (dataset.kind === 'TAXONOMY') {
        await this.prisma.marketTaxonomyTerm.createMany({
          data: fetched.terms
            .slice(i, i + IMPORT_BATCH)
            .map((term) => ({ ...term, datasetVersionId: created.id })),
          skipDuplicates: true,
        });
      } else {
        await this.prisma.marketAggregateObservation.createMany({
          data: fetched.observations.slice(i, i + IMPORT_BATCH).map((obs) => ({
            ...obs,
            periodStart: new Date(obs.periodStart),
            periodEnd: new Date(obs.periodEnd),
            datasetVersionId: created.id,
          })),
          skipDuplicates: true,
        });
      }

      void batch;
    }

    return {
      datasetVersionId: created.id,
      sourceSlug: dataset.sourceSlug,
      datasetKey: dataset.datasetKey,
      version: fetched.version,
      rowCount: rows.length,
      alreadyImported: false,
      contentHash,
    };
  }
}
