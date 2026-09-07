import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
import { CareerGraphIngestionService } from '../career-graph/career-graph-ingestion.service.js';

@Injectable()
export class ResumeImportService {
  private readonly bucket = 'resumes';

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseClientService,
    private readonly careerGraphIngestionService: CareerGraphIngestionService,
  ) {}

  async create(
    userId: string,
    fileName: string,
  ) {
    const normalizedFileName =
      fileName.trim();

    if (!normalizedFileName) {
      throw new BadRequestException(
        'fileName is required',
      );
    }

    const safeFileName =
      normalizedFileName
        .replace(
          /[^a-zA-Z0-9._-]/g,
          '_',
        )
        .slice(0, 200);

    const id = randomUUID();

    const storagePath =
      `${userId}/${id}/${safeFileName}`;

    const resumeImport =
      await this.prisma.resumeImport.create({
        data: {
          id,
          userId,
          fileName: normalizedFileName,
          storagePath,
        },
      });

    const {
      data,
      error,
    } =
      await this.supabase.client.storage
        .from(this.bucket)
        .createSignedUploadUrl(
          storagePath,
        );

    if (error) {
      await this.prisma.resumeImport.update({
        where: {
          id: resumeImport.id,
        },
        data: {
          status: 'FAILED',
          errorMessage:
            error.message,
        },
      });

      throw new BadRequestException(
        `Unable to create upload URL: ${error.message}`,
      );
    }

    return {
      id: resumeImport.id,
      fileName: resumeImport.fileName,
      storagePath:
        resumeImport.storagePath,
      status: resumeImport.status,
      uploadToken: data.token,
      uploadPath: data.path,
    };
  }

  async findAll(userId: string) {
    return this.prisma.resumeImport.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(
    userId: string,
    id: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    return resumeImport;
  }

  async updateExtraction(
    userId: string,
    id: string,
    extractionResult: unknown,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    /*
     * Editable while awaiting review, and also while CONFIRMED but not yet
     * ingested.
     *
     * The second case is what makes retry work from the review screen. The
     * screen saves before it confirms, so once a first confirm had flipped
     * the row to CONFIRMED, a second attempt failed here on the save — the
     * user was told "cannot be edited in status CONFIRMED" and the import
     * could never reach the graph again, which defeats the recovery the
     * ledger was designed to allow.
     *
     * It is also the right rule on its own terms. Nothing has been written
     * to the career graph yet, so nothing downstream can disagree with an
     * edit; and an ingestion that failed on bad data can only be fixed by
     * letting the user correct that data. Once the ledger row exists the
     * import is immutable again, because by then the graph is built from
     * it and an edit would silently contradict records already there.
     */
    if (
      resumeImport.status !==
        'NEEDS_REVIEW' &&
      resumeImport.status !== 'CONFIRMED'
    ) {
      throw new ConflictException(
        `Resume import cannot be edited in status ${resumeImport.status}`,
      );
    }

    if (
      resumeImport.status === 'CONFIRMED' &&
      (await this.prisma.careerGraphIngestion.findUnique(
        {
          where: {
            resumeImportId: resumeImport.id,
          },
        },
      )) !== null
    ) {
      throw new ConflictException(
        'Resume import has already been added to your career graph and can no longer be edited',
      );
    }

    if (
      typeof extractionResult !==
        'object' ||
      extractionResult === null ||
      Array.isArray(
        extractionResult,
      )
    ) {
      throw new BadRequestException(
        'extractionResult must be a JSON object',
      );
    }

    return this.prisma.resumeImport.update({
      where: {
        id: resumeImport.id,
      },
      data: {
        extractionResult:
          extractionResult as Prisma.InputJsonValue,
      },
    });
  }

  async confirm(
    userId: string,
    id: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    /*
     * Confirming is idempotent, and deliberately so.
     *
     * The lifecycle here used to be: flip the row to CONFIRMED, ingest,
     * and on failure flip it back to NEEDS_REVIEW. Two things were wrong
     * with that. The rollback discarded a confirmation the user had
     * actually given — their decision, thrown away to report someone
     * else's failure. And neither the flip nor the rollback shared a
     * transaction with the ingestion, so a process death between them left
     * an import CONFIRMED with nothing in the graph and no way back:
     * confirm() accepted NEEDS_REVIEW only, and no other route reached
     * ingestion.
     *
     * Making the two writes atomic is not a real option. The ingestion is
     * its own long transaction across a dozen tables, and the confirmation
     * has to be durable BEFORE it starts, or a crash loses the user's
     * decision rather than merely delaying the graph.
     *
     * So the states are made recoverable instead of atomic. Confirmation
     * is committed once and never reverted. Ingestion is a separate,
     * idempotent step keyed on the CareerGraphIngestion ledger row, which
     * is written last inside the ingestion transaction — so "CONFIRMED
     * with no ledger row" is a precise, crash-safe, retryable state, and
     * confirming again resumes exactly there.
     *
     * No new column and no job runner: the ledger already records the only
     * fact that was missing.
     */
    if (
      resumeImport.status !==
        'NEEDS_REVIEW' &&
      resumeImport.status !== 'CONFIRMED'
    ) {
      throw new ConflictException(
        `Resume import cannot be confirmed in status ${resumeImport.status}`,
      );
    }

    if (!resumeImport.extractionResult) {
      throw new ConflictException(
        'Resume import has no extraction result',
      );
    }

    /*
     * Compare-and-swap, so only a row still awaiting review moves. A row
     * already CONFIRMED is a retry and falls through untouched; so does
     * the loser of two simultaneous confirms, which is the same case
     * arrived at by a different route.
     */
    if (
      resumeImport.status === 'NEEDS_REVIEW'
    ) {
      await this.prisma.resumeImport.updateMany(
        {
          where: {
            id: resumeImport.id,
            status: 'NEEDS_REVIEW',
          },
          data: {
            status: 'CONFIRMED',
            errorMessage: null,
          },
        },
      );
    }

    return this.ingest(
      userId,
      resumeImport.id,
    );
  }

  /*
   * Drives a CONFIRMED import into the Career Graph.
   *
   * Safe to call any number of times. ingestConfirmedResume returns
   * ALREADY_INGESTED as soon as the ledger row exists, so a repeat creates
   * no second entity and re-attaches no evidence; and where two calls race
   * past that check, the unique index on the ledger settles it and the
   * loser rolls back whole.
   *
   * Exposed on its own route as well as being the tail of confirm(),
   * because an import can be stranded by a crash the user never saw an
   * error for. Without a route of its own, recovering one would need a
   * database script.
   */
  async ingest(
    userId: string,
    id: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    if (
      resumeImport.status !== 'CONFIRMED'
    ) {
      throw new ConflictException(
        `Resume import cannot be ingested in status ${resumeImport.status}`,
      );
    }

    /*
     * Only the ingestion is inside the try.
     *
     * The bookkeeping write that clears errorMessage used to sit here too,
     * and that was wrong in a way worth naming: if the ingestion committed
     * and then the clear failed — a dropped connection, a statement
     * timeout — the catch would fire and stamp "ingestion failed" onto an
     * import whose graph was already built, then return a 500 for an
     * operation that had succeeded. That is the same false failure the
     * P2002 guard inside ingestConfirmedResume exists to prevent,
     * reintroduced one layer up.
     */
    let careerGraph;

    try {
      careerGraph =
        await this.careerGraphIngestionService.ingestConfirmedResume(
          userId,
          resumeImport.id,
        );
    } catch (error) {
      await this.recordIngestionFailure(
        resumeImport.id,
        error,
      );

      throw error;
    }

    const ingested =
      await this.prisma.resumeImport.update({
        where: {
          id: resumeImport.id,
        },
        data: {
          errorMessage: null,
        },
      });

    return {
      resumeImport: ingested,
      careerGraph,
    };
  }

  /*
   * Records WHY an ingestion did not happen, without touching the status.
   *
   * The confirmation stands: reverting it here would discard a decision
   * the user made, in order to report a failure that happened afterwards.
   *
   * Two guards, both about not lying:
   *
   *   - Nothing is written if a ledger row exists. A concurrent call may
   *     have ingested this import between the failure and this write, and
   *     leaving "ingestion failed" on a row whose graph is live would send
   *     the user to retry something already done.
   *   - The write cannot mask the real error. If the database is what
   *     broke, this update fails too; letting it propagate would replace
   *     the ingestion error with a bookkeeping one and lose the cause.
   */
  private async recordIngestionFailure(
    id: string,
    error: unknown,
  ) {
    try {
      const committed =
        await this.prisma.careerGraphIngestion.findUnique(
          {
            where: {
              resumeImportId: id,
            },
          },
        );

      if (committed) {
        return;
      }

      await this.prisma.resumeImport.update({
        where: { id },
        data: {
          errorMessage:
            error instanceof Error
              ? `Career graph ingestion failed: ${error.message}`
              : 'Career graph ingestion failed.',
        },
      });
    } catch {
      /*
       * Deliberately swallowed. The caller rethrows the original error,
       * which is the one worth surfacing.
       */
    }
  }
}
