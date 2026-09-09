import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
import { CareerGraphIngestionService } from '../career-graph/career-graph-ingestion.service.js';
import { UserStorageService } from '../account/user-storage.service.js';
import {
  ACTIVE_IMPORT_STATUSES,
  checkFileName,
  IMPORT_WINDOW_MS,
  MAX_ACTIVE_IMPORTS,
  MAX_IMPORTS_PER_WINDOW,
  rejectionMessage,
  sanitizeFileName,
} from './upload-policy.js';

@Injectable()
export class ResumeImportService {
  private readonly bucket = 'resumes';

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseClientService,
    private readonly careerGraphIngestionService: CareerGraphIngestionService,
    private readonly userStorage: UserStorageService,
  ) {}

  /**
   * Starts an import: validates, reserves a slot, and mints an upload URL.
   *
   * `now` is a parameter rather than a clock read inside, so the rolling
   * window can be tested at a stated instant instead of by waiting.
   */
  async create(
    userId: string,
    fileName: string,
    now: Date = new Date(),
  ) {
    /*
     * Server-side, and not because the client is untrustworthy in
     * principle but because it is untrusted in fact: anything holding a
     * bearer token can call this endpoint directly, and the app's own
     * `.pdf` check never runs for those callers.
     */
    const rejection = checkFileName(fileName);

    if (rejection !== null) {
      throw new BadRequestException(rejectionMessage(rejection));
    }

    const normalizedFileName = fileName.trim();
    const safeFileName = sanitizeFileName(normalizedFileName);

    const id = randomUUID();

    const storagePath =
      `${userId}/${id}/${safeFileName}`;

    /*
     * The count and the insert happen under one row lock, and that is the
     * whole point of the transaction.
     *
     * Counting outside it is the classic check-then-act race: two requests
     * both read "2 active", both decide there is room for a third, and the
     * user ends with four. Locking the USER row serialises only that one
     * user's import creations - two different users never contend - and it
     * needs no new schema, because the row already exists and is already
     * the thing both requests have in common.
     *
     * FOR UPDATE on User rather than a lock on ResumeImport: the rows being
     * counted are the rows being created, so there is nothing stable to
     * lock on that side. The user is the invariant.
     */
    const resumeImport = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;

      const active = await tx.resumeImport.count({
        where: {
          userId,
          status: { in: [...ACTIVE_IMPORT_STATUSES] },
        },
      });

      if (active >= MAX_ACTIVE_IMPORTS) {
        throw new ConflictException(
          `You already have ${MAX_ACTIVE_IMPORTS} resume imports in progress. Finish or remove one before starting another.`,
        );
      }

      const recent = await tx.resumeImport.count({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - IMPORT_WINDOW_MS) },
        },
      });

      if (recent >= MAX_IMPORTS_PER_WINDOW) {
        throw new ConflictException(
          'Too many resume imports started recently. Please try again later.',
        );
      }

      return tx.resumeImport.create({
        data: {
          id,
          userId,
          fileName: normalizedFileName,
          storagePath,
        },
      });
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

    if (error || !data) {
      await this.prisma.resumeImport.update({
        where: {
          id: resumeImport.id,
        },
        data: {
          status: 'FAILED',
          /*
           * The provider's own text, kept INTERNALLY. This column is read
           * back by the owner of the import and by nobody else, and it is
           * the only place the real cause survives until PR-5 gives us
           * somewhere better to put it.
           */
          errorMessage: error?.message ?? 'Unknown storage error',
        },
      });

      /*
       * A stable sentence, not the provider's. A raw storage error names
       * buckets, internal endpoints and occasionally request ids - none of
       * which helps the person holding the phone, and all of which
       * describes our infrastructure to whoever asked.
       */
      throw new BadRequestException(
        'Unable to start the resume upload. Please try again.',
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
  /**
   * Deletes one resume import: the row, its file, and the evidence that
   * provably came from it.
   *
   * WHAT THIS DOES NOT DELETE, and why that is a finding rather than a
   * shortcut. Experience, Project, Education, Achievement, UserSkill and
   * Profile carry NO reference to the import that produced them - only
   * Evidence and CareerGraphIngestion do. So for a user with two imports
   * there is no column, and no derivable fact, that says which of their
   * experiences came from which resume. Deleting "the career data from
   * this resume" is therefore not something the schema can express, and
   * guessing at it would silently destroy rows the user reviewed, edited
   * and may have built on since.
   *
   * The response says so explicitly rather than leaving the caller to
   * assume, because a deletion that quietly does less than its name
   * suggests is worse than one that is clear about its scope.
   *
   * WHY EVIDENCE IS DELETED RATHER THAN ORPHANED. The schema's own
   * behaviour for `Evidence.resumeImport` is SetNull, which would leave a
   * row titled "Resume: jane-doe-cv.pdf" pointing at nothing - residual
   * personal data, the user's own filename, surviving a deletion they
   * asked for. Deleting those rows is both cleaner and closer to what
   * "delete this resume" means. The links from that evidence to
   * experiences and skills cascade with it; the experiences themselves do
   * not, which is the same boundary as above.
   *
   * Scoped by { id, userId } like every other read and write here, so an
   * id belonging to another user is a 404 and never a deletion.
   *
   * Idempotent: a second call finds nothing and says so.
   */
  async remove(userId: string, id: string) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: { id, userId },
        select: { id: true, storagePath: true },
      });

    if (!resumeImport) {
      /*
       * The same answer for "already deleted" and "belongs to somebody
       * else". A caller must not be able to tell those apart - the
       * difference is exactly the information an id-guessing attack is
       * looking for.
       */
      throw new NotFoundException('Resume import not found');
    }

    /*
     * Storage first, for the same reason account deletion does it first:
     * the row is the only record of which object to remove. Losing it
     * while the file remains leaves an object nothing points at.
     */
    const fileDeleted = await this.userStorage.deleteObject(
      userId,
      resumeImport.storagePath,
    );

    if (!fileDeleted) {
      throw new InternalServerErrorException(
        'The resume file could not be removed. Nothing was deleted; please try again.',
      );
    }

    /*
     * One transaction for the two row deletions, so a failure between
     * them cannot leave evidence referring to an import that is gone.
     */
    const evidenceDeleted = await this.prisma.$transaction(async (tx) => {
      const evidence = await tx.evidence.deleteMany({
        where: { userId, resumeImportId: id },
      });

      await tx.resumeImport.deleteMany({ where: { id, userId } });

      return evidence.count;
    });

    return {
      id,
      deleted: true,
      fileDeleted,
      evidenceDeleted,
      /*
       * Stated in the response, not only in a comment. The client shows
       * this to the user, because "your resume was deleted" and "the
       * experiences it created are still in your profile" are two
       * different sentences and the user is entitled to both.
       */
      careerGraphRetained: true,
      careerGraphNote:
        'Experiences, projects, education and skills already in your profile were kept. They cannot be traced back to a single resume, and may have been edited since.',
    };
  }

}
