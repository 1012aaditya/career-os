import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { connectionTokenAad } from '../crypto/aad.js';
import { fromStorageBytes } from '../crypto/bytes.js';
import { EncryptionService } from '../crypto/encryption.service.js';

import { ExternalSyncRunService } from './external-sync-run.service.js';
import { GithubIngestionService } from './github-ingestion.service.js';
import { GithubRequestError } from './github-rest.client.js';
import { GithubEvidenceRepository } from './evidence/github-evidence.repository.js';
import { projectSyncEvidence } from './evidence/evidence-projection.js';
import type { EvidenceInput } from './evidence/evidence-input.js';
import type { SyncObservation } from './observations/types.js';

/*
 * The sync use case: connection in, Evidence rows and a ledger entry out.
 *
 * This is the only place where the four finished halves of Phase 7 meet -
 * the credential (7.1/7.2), the ingestion (7.3), the projection and the
 * persistence (7.4 A and B) - and it owns exactly the decisions that
 * belong to none of them individually:
 *
 *   - which repositories are allowed to become Evidence at all,
 *   - what the ledger is told,
 *   - what a failure is allowed to say out loud.
 *
 * It deliberately owns no shape decisions and no HTTP. If a rule here
 * starts describing what a row SAYS rather than whether it may exist, it
 * belongs in the projection instead.
 */

const PROVIDER = 'GITHUB' as const;

/*
 * The only connection state a sync may run against.
 *
 * INVALID and REVOKED are not "probably fine": they are our record that
 * the credential already failed, and spending a user's shared rate-limit
 * budget re-proving that is both rude and pointless.
 */
const ACTIVE = 'ACTIVE';

/**
 * No connection this sync is allowed to run against.
 *
 * One error type for "absent", "not ACTIVE" and "holds no token",
 * because from the caller's side they are one situation with one fix:
 * connect GitHub again. `reason` is carried for logs and tests, and is
 * deliberately NOT rendered into the HTTP body - see the controller.
 */
export class GithubConnectionUnavailableError extends Error {
  readonly reason:
    | 'missing'
    | 'inactive'
    | 'no_credential';

  constructor(
    reason:
      | 'missing'
      | 'inactive'
      | 'no_credential',
  ) {
    super('No active GitHub connection');
    this.name =
      'GithubConnectionUnavailableError';
    this.reason = reason;
  }
}

/**
 * A run that opened and could not complete.
 *
 * Carries a REASON CODE, never a caught error. The distinction is the
 * whole point of this class existing: an error thrown by the HTTP client
 * holds the request that produced it, and that request holds the
 * Authorization header. Rethrowing it - or attaching it as `cause`, which
 * serializers walk - is how a token reaches a log or a response body.
 */
export class GithubSyncFailedError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super('GitHub sync failed');
    this.name = 'GithubSyncFailedError';
    this.reasonCode = reasonCode;
  }
}

/** Knobs a caller may set. All optional; all defaulted safely. */
export type SyncOptions = {
  /*
   * Injected so a run is reproducible. Defaulted at the boundary below
   * rather than deep inside the ingestion service, so there is exactly
   * one clock read per sync and every downstream timestamp - the
   * observation's, the projection's capturedAt, the response - is the
   * same instant rather than several nearby ones.
   */
  scannedAt?: string;
  /** Lower bound of the window; null means "since repository creation". */
  scannedSince?: string | null;
  /** Repository depth budget, forwarded verbatim to the ingestion layer. */
  repositoryScanBudget?: number;
};

/**
 * What a completed sync reports.
 *
 * Every field here is either a count, a flag, a status or an instant.
 * Nothing derived from the credential, nothing from a raw GitHub payload,
 * and no repository names - the ledger row holds the per-repository
 * detail, and this response is the part that crosses the network.
 */
export type GithubSyncSummary = {
  runId: string;
  /*
   * Derived by the ledger from the observation, never chosen here. See
   * ExternalSyncRunService.finish: there is no code path through which a
   * caller can pair a partial scan with the word SUCCEEDED.
   */
  status: string;
  counts: {
    /** Evidence rows inserted by this run. */
    created: number;
    /** Evidence rows already present and re-observed by this run. */
    updated: number;
    /** Repositories actually looked at. */
    reposScanned: number;
    /** Repositories the listing found, scanned or not. */
    reposTotal: number;
    /*
     * Listed but never looked at, and therefore deliberately left
     * without an Evidence row. Reported so a client can say "10 not
     * looked at yet" instead of silently showing fewer rows than
     * repositories.
     */
    reposSkipped: number;
  };
  /** When we looked. Not when the work happened. */
  scannedAt: string;
  /*
   * When this response was produced. The ledger row's finishedAt is the
   * authoritative one; this is the same moment to within a database
   * round trip, and is here so a client can show "synced just now"
   * without a second request.
   */
  finishedAt: string;
  /** The repository LISTING hit a page ceiling, so repos were never enumerated. */
  listingTruncated: boolean;
  /** Always null on this path. Present so the success and failure shapes agree. */
  error: null;
};

/**
 * Turns any thrown value into a short, fixed vocabulary.
 *
 * Fixed on purpose. Every branch below returns a string this file
 * authored, assembled only from values our own code chose (an operation
 * name we pass in, a failure enum the client defines). `error.message` is
 * never read, because a message is arbitrary text from an arbitrary layer
 * and the one thing it must never contain is the thing it is most likely
 * to contain when something goes wrong at an authenticated HTTP boundary.
 */
function sanitizedReason(error: unknown): string {
  if (error instanceof GithubRequestError) {
    return `github:${error.operation}:${error.reason}`;
  }

  if (
    error instanceof
    GithubSyncFailedError
  ) {
    return error.reasonCode;
  }

  return 'internal_error';
}

@Injectable()
export class GithubSyncService {
  /*
   * Facts only: a user id, a run id, a reason code. The caught error is
   * never handed to the logger, for the reason given on
   * GithubSyncFailedError.
   */
  private readonly logger = new Logger(
    GithubSyncService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly ingestion: GithubIngestionService,
    private readonly runs: ExternalSyncRunService,
    private readonly evidence: GithubEvidenceRepository,
  ) {}

  /**
   * Runs one sync for one user.
   *
   * TRANSACTION BOUNDARIES - deliberately none.
   *
   * There is no $transaction anywhere in this method, and that is a
   * decision rather than an omission:
   *
   *   - The ledger row MUST be visible to other connections while the
   *     sync runs. That visibility is the entire mechanism by which
   *     start() refuses a second concurrent sync. Opening the run inside
   *     a transaction would hide it until commit, so two syncs launched
   *     together would both see "no live run" and both proceed.
   *   - The body of this method is minutes of network I/O. Holding a
   *     database transaction - and therefore a pooled connection and a
   *     snapshot - open across it is how a connection pool dies.
   *   - persistMany is intentionally row-at-a-time and independently
   *     idempotent (see GithubEvidenceRepository). Wrapping it would
   *     invert that: one unwritable repository would roll back every
   *     other repository's evidence, so a single bad row could erase a
   *     whole sync's work.
   *
   * What replaces atomicity is idempotency. A run that dies halfway
   * leaves a partially-updated but entirely valid set of rows plus a
   * FAILED (or reclaimable RUNNING) ledger entry, and the next sync
   * completes it.
   */
  async sync(
    userId: string,
    options: SyncOptions = {},
  ): Promise<GithubSyncSummary> {
    const connection =
      await this.loadActiveConnection(userId);

    /*
     * Decrypted here, immediately before the one call that needs it, and
     * held in a local that dies with this method. It is never returned,
     * never logged, never placed on an object that outlives the call.
     */
    const accessToken =
      this.decryptAccessToken(
        userId,
        connection,
      );

    const scannedAt =
      options.scannedAt ??
      new Date().toISOString();

    const scannedSince =
      options.scannedSince ?? null;

    /*
     * Opened BEFORE the try. If start() refuses - because a sync is
     * already running for this connection - there is no run of ours to
     * fail, and swallowing that into a FAILED row would close somebody
     * else's live run.
     */
    const run = await this.runs.start({
      connectionId: connection.id,
      userId,
    });

    let observation: SyncObservation;
    let created: number;
    let updated: number;
    let skipped: number;

    try {
      observation =
        await this.ingestion.ingest({
          accessToken,
          account: {
            accountId:
              connection.externalAccountId,
            login:
              connection.externalAccountLogin,
          },
          scannedAt,
          scannedSince,
          repositoryScanBudget:
            options.repositoryScanBudget,
        });

      const projected =
        evidenceForSync(observation);

      skipped = projected.withheld;

      const persisted =
        await this.evidence.persistMany(
          userId,
          projected.inputs,
        );

      created = persisted.created;
      updated = persisted.updated;
    } catch (error) {
      const reasonCode =
        sanitizedReason(error);

      /*
       * The ledger is told what happened before the caller is. A run
       * that threw and left RUNNING behind would sit there until the
       * staleness sweeper reclaimed it, blocking every retry in the
       * meantime.
       */
      await this.runs.fail(run.id, reasonCode);

      this.logger.warn(
        `GitHub sync failed for user ${userId} run ${run.id}: ${reasonCode}`,
      );

      /*
       * A new error carrying only the code. The caught error is dropped
       * on the floor - not rethrown, not wrapped, not attached as a
       * cause - because it may hold the request that carried the
       * Authorization header.
       */
      throw new GithubSyncFailedError(
        reasonCode,
      );
    }

    /*
     * Outside the try on purpose. finish() throws ConflictException when
     * the run is no longer RUNNING, which means something else already
     * closed it; that is a genuine 409 about the ledger, not a sync
     * failure, and catching it above would rewrite it into one.
     */
    const { status } = await this.runs.finish(
      run.id,
      observation,
    );

    return {
      runId: run.id,
      status,
      counts: {
        created,
        updated,
        reposScanned:
          observation.completeness.reposScanned,
        reposTotal:
          observation.completeness.reposTotal,
        reposSkipped: skipped,
      },
      scannedAt:
        observation.completeness.scannedAt,
      finishedAt: new Date().toISOString(),
      listingTruncated:
        observation.completeness.truncated,
      error: null,
    };
  }

  /**
   * The connection this sync may run against, or an error.
   *
   * The token columns are selected here because this method's caller
   * genuinely needs them. That is the only reason a `select` in this file
   * ever names them, and nothing they contain leaves this class.
   */
  private async loadActiveConnection(
    userId: string,
  ) {
    const connection =
      await this.prisma.externalConnection.findUnique(
        {
          where: {
            userId_provider: {
              userId,
              provider: PROVIDER,
            },
          },
          select: {
            id: true,
            externalAccountId: true,
            externalAccountLogin: true,
            status: true,
            tokenCiphertext: true,
            tokenIv: true,
            tokenTag: true,
            tokenKeyVersion: true,
            tokenAlg: true,
          },
        },
      );

    if (!connection) {
      throw new GithubConnectionUnavailableError(
        'missing',
      );
    }

    if (connection.status !== ACTIVE) {
      throw new GithubConnectionUnavailableError(
        'inactive',
      );
    }

    if (
      !connection.tokenCiphertext ||
      !connection.tokenIv ||
      !connection.tokenTag ||
      connection.tokenKeyVersion === null
    ) {
      /*
       * A credential-less connection is a real state - the schema makes
       * the token columns nullable because a PORTFOLIO connection has no
       * token - so this is a shape we refuse rather than a shape we
       * assume away with a non-null assertion.
       */
      throw new GithubConnectionUnavailableError(
        'no_credential',
      );
    }

    return connection;
  }

  /**
   * Decrypts the stored access token.
   *
   * WHY THIS IS HERE AND NOT ON GithubConnectionService.
   *
   * That service is the natural home for a "get me the decrypted token"
   * method and it does not have one: its only decryption happens inline
   * inside disconnect(). It is frozen for this phase and may not be
   * edited, so rather than reach for it, the same three steps it performs
   * are repeated here - fromStorageBytes on each column, the SAME
   * connectionTokenAad(userId, 'GITHUB') domain, and EncryptionService.
   *
   * The AAD is the part that must not drift. It is what binds a
   * ciphertext to the user that owns it: a row copied into another user's
   * record fails to decrypt instead of silently syncing as the victim.
   * Reconstructing it from the SAME helper - rather than rebuilding the
   * string by hand - is what makes this duplication safe. If a public
   * accessor is added to GithubConnectionService in a later phase, this
   * method should be deleted in favour of it; it is duplication of three
   * lines, not of the security decision.
   *
   * The thrown error deliberately carries nothing. EncryptionService
   * already returns one opaque message for every failure mode so it
   * cannot be used as an oracle, and this converts it into a reason code
   * with no ciphertext, key version or cause chain attached.
   */
  private decryptAccessToken(
    userId: string,
    connection: {
      tokenCiphertext: Uint8Array | null;
      tokenIv: Uint8Array | null;
      tokenTag: Uint8Array | null;
      tokenKeyVersion: number | null;
      tokenAlg: string | null;
    },
  ): string {
    if (
      !connection.tokenCiphertext ||
      !connection.tokenIv ||
      !connection.tokenTag ||
      connection.tokenKeyVersion === null
    ) {
      throw new GithubConnectionUnavailableError(
        'no_credential',
      );
    }

    try {
      return this.encryption.decrypt(
        {
          ciphertext: fromStorageBytes(
            connection.tokenCiphertext,
          ),
          iv: fromStorageBytes(
            connection.tokenIv,
          ),
          tag: fromStorageBytes(
            connection.tokenTag,
          ),
          keyVersion:
            connection.tokenKeyVersion,
          alg:
            connection.tokenAlg ??
            'aes-256-gcm',
        },
        connectionTokenAad(userId, PROVIDER),
      );
    } catch {
      /*
       * Thrown before any run is opened, so there is no ledger row to
       * fail - which is correct: nothing was attempted at GitHub.
       */
      throw new GithubSyncFailedError(
        'credential_unreadable',
      );
    }
  }
}

/**
 * The repositories a sync is allowed to write Evidence for.
 *
 * THE NOT_SCANNED RULE, AND WHY THE FILTER LIVES HERE.
 *
 * projectSyncEvidence (7.4 A) does NOT filter these. It was read, not
 * assumed: it maps every repository in the observation, and for a
 * NOT_SCANNED one it emits a correctly-worded row saying "listed but not
 * scanned in this sync, so no activity was established for it. That is
 * not the same as no activity."
 *
 * That is the right behaviour for a PROJECTION, which answers "if this
 * became a row, what would the row say" and is a pure function with no
 * opinion about persistence. It is the wrong behaviour for a SYNC,
 * because the row it produces asserts something about a repository we
 * never looked at, and a row's mere EXISTENCE is a claim independent of
 * its prose: it appears in counts, in lists, in exports, and in any
 * downstream consumer that reads a title without reading a description.
 *
 * So the projection stays honest about wording, and this layer - the one
 * that decides what is written - owns the decision that an unlooked-at
 * repository produces nothing at all. The repository is not lost: it is
 * in the ledger's per-repository stats as NOT_SCANNED, it is in
 * reposTotal, it is counted in reposSkipped on the response, and the next
 * run with budget for it will write its evidence properly.
 *
 * ACCESS_LOST is deliberately NOT filtered. It means the repository was
 * reachable in an earlier sync and is not now - so unlike NOT_SCANNED,
 * something WAS established about it once, and its row is retained and
 * marked stale rather than withheld or deleted. That matches the
 * retention policy in GithubEvidenceRepository: absence from a sync is
 * not evidence of absence.
 *
 * The filter keys on externalId taken from the observation, rather than
 * re-reading completeness out of the projected metadata. The observation
 * is the authority on what was scanned; metadata is a rendering of it,
 * and reaching into a rendering to recover a fact it was derived from is
 * how the two silently diverge.
 */
export function evidenceForSync(
  observation: SyncObservation,
): {
  inputs: EvidenceInput[];
  /*
   * Distinct repositories withheld. Counted from the set rather than as
   * (repositories - inputs), because the projection ALSO collapses
   * duplicate listings, and a subtraction would silently report a
   * paginated duplicate as a skipped repository.
   */
  withheld: number;
} {
  const withheld = new Set(
    observation.repositories
      .filter(
        (repository) =>
          repository.completeness.commits ===
          'NOT_SCANNED',
      )
      .map(
        (repository) => repository.externalId,
      ),
  );

  const inputs = projectSyncEvidence(
    observation,
  ).filter(
    (input) => !withheld.has(input.externalId),
  );

  return { inputs, withheld: withheld.size };
}
