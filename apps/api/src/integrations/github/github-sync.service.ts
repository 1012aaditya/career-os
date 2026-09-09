import { Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { connectionTokenAad } from '../crypto/aad.js';
import { fromStorageBytes } from '../crypto/bytes.js';
import { EncryptionService } from '../crypto/encryption.service.js';

import { ExternalSyncRunService } from './external-sync-run.service.js';
import {
  GithubIngestionService,
  type PriorRepositoryState,
} from './github-ingestion.service.js';
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
    /** Repositories with an established count, freshly read or carried. */
    reposScanned: number;
    /*
     * Of those, how many were carried forward from a previous run because
     * their last push had not moved, rather than re-read.
     *
     * Reported separately because otherwise a steady-state sync says "40
     * scanned" having read none of them, which overstates what it did.
     */
    reposRevalidated: number;
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

/*
 * Reads one stored Evidence row back into prior state, or returns null.
 *
 * Everything is validated rather than asserted. A row whose metadata is
 * missing, malformed, or written by an older shape must produce null and
 * be re-read from GitHub - never a partially-trusted state that could let
 * a repository be skipped on the strength of a value nobody wrote.
 *
 * Null is the safe answer everywhere here: it costs one repository's
 * worth of requests and guarantees the count is re-derived.
 */
function readPriorState(row: {
  externalId: string | null;
  metadata: unknown;
}): PriorRepositoryState | null {
  if (
    row.externalId === null ||
    typeof row.metadata !== 'object' ||
    row.metadata === null ||
    Array.isArray(row.metadata)
  ) {
    return null;
  }

  const metadata = row.metadata as Record<
    string,
    unknown
  >;

  const repository = asRecord(
    metadata['repository'],
  );

  const completeness = asRecord(
    metadata['completeness'],
  );

  const activity = asRecord(
    metadata['activity'],
  );

  if (
    repository === null ||
    completeness === null ||
    activity === null
  ) {
    return null;
  }

  const commits = completeness['commits'];

  if (
    commits !== 'DEFAULT_BRANCH_ONLY' &&
    commits !== 'NOT_SCANNED' &&
    commits !== 'ACCESS_LOST'
  ) {
    return null;
  }

  const scannedAt = completeness['scannedAt'];

  if (typeof scannedAt !== 'string') {
    return null;
  }

  return {
    externalId: row.externalId,
    pushedAt: asStringOrNull(
      repository['pushedAt'],
    ),
    defaultBranch: asStringOrNull(
      repository['defaultBranch'],
    ),
    scannedSince: asStringOrNull(
      completeness['scannedSince'],
    ),
    /*
     * Anything other than an explicit false is treated as truncated, so
     * an absent or unreadable flag can never be mistaken for a complete
     * count and carried forward.
     */
    truncated: completeness['truncated'] !== false,
    commits,
    scannedAt,
    activity: {
      commitsAttributed: asCountOrNull(
        activity['commitsAttributed'],
      ),
      pullRequestsAuthored: asCountOrNull(
        activity['pullRequestsAuthored'],
      ),
      issuesAuthored: asCountOrNull(
        activity['issuesAuthored'],
      ),
      firstActivityAt: asStringOrNull(
        activity['firstActivityAt'],
      ),
      lastActivityAt: asStringOrNull(
        activity['lastActivityAt'],
      ),
    },
    languages: readLanguages(
      metadata['languages'],
    ),
  };
}

function asRecord(
  value: unknown,
): Record<string, unknown> | null {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringOrNull(
  value: unknown,
): string | null {
  return typeof value === 'string' &&
    value.length > 0
    ? value
    : null;
}

function asCountOrNull(
  value: unknown,
): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function readLanguages(
  value: unknown,
): Array<{ name: string; bytes: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const languages: Array<{
    name: string;
    bytes: number;
  }> = [];

  for (const entry of value) {
    const record = asRecord(entry);

    if (record === null) {
      continue;
    }

    const name = asStringOrNull(record['name']);
    const bytes = asCountOrNull(record['bytes']);

    if (name !== null && bytes !== null) {
      languages.push({ name, bytes });
    }
  }

  return languages;
}

@Injectable()
export class GithubSyncService {
  /*
   * Facts only: a user id, a run id, a reason code. The caught error is
   * never handed to the logger, for the reason given on
   * GithubSyncFailedError.
   */

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly ingestion: GithubIngestionService,
    private readonly runs: ExternalSyncRunService,
    private readonly evidence: GithubEvidenceRepository,
    /*
     * Optional with a default, matching the pattern the source clients
     * already use for their injected sleep and credentials. The container
     * supplies the shared singleton; the default exists so the Phase 7
     * specs, which construct these services directly with a fixed
     * argument list, keep working without being rewritten for a
     * diagnostics change.
     */
    @Optional()
    private readonly structured: StructuredLogger = new StructuredLogger(),
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
          priorRepositories:
            await this.readPriorRepositories(
              userId,
            ),
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

      /*
       * The user id used to be interpolated into this line in plain text.
       * It is the key that indexes somebody's career history, and a log
       * aggregator is not where it belongs - so it is replaced by a stable
       * pseudonym, which still answers "is this the same person failing
       * repeatedly" without carrying the id itself. PR-5.
       */
      this.structured.event('warn', 'github.sync.failed', {
        actor: this.structured.actor(userId),
        provider: 'github',
        operation: 'sync',
        errorCode: reasonCode,
        errorCategory: 'dependency',
      });

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

    /*
     * Written AFTER the ledger closes, and never allowed to fail the
     * sync. finish() throws deliberately when a run is no longer RUNNING,
     * so stamping this first would claim a completion that then did not
     * happen.
     *
     * It means "a sync run completed", NOT "the data is fresh to this
     * point" - PARTIAL is the normal outcome for any account over the
     * scan budget, and those repositories are genuinely unobserved. The
     * status is returned alongside so a client can say which.
     */
    await this.stampLastSyncedAt(userId);

    const reposRevalidated =
      observation.repositories.filter(
        (repository) =>
          repository.completeness
            .revalidatedBy !== null,
      ).length;

    return {
      runId: run.id,
      status,
      counts: {
        created,
        updated,
        reposScanned:
          observation.completeness.reposScanned,
        /*
         * Separated from reposScanned on purpose. Without it a steady
         * state reads "40 scanned" when nothing was re-read, which
         * overstates what the run did.
         */
        reposRevalidated,
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
   * What previous runs established, keyed by the row's own unique key.
   *
   * Scoped by userId AND sourceType in the WHERE clause, not filtered in
   * JavaScript afterwards. This map decides whether a repository is
   * re-read, and a cross-user key here would carry one person's commit
   * counts onto another person's evidence - a corruption that is silent,
   * durable and unfalsifiable after the fact.
   *
   * Keyed on externalId rather than metadata.repository.repoId: the
   * former is the column the unique index is built on, so it cannot
   * collide. Keying on a field read back out of JSON would reintroduce
   * identity-by-metadata, which is exactly what externalId exists to
   * avoid - and rows with unreadable metadata would collapse onto one
   * undefined key whose winner depended on row order.
   *
   * orderBy is stated even though the unique index makes contents
   * order-independent, because it documents that this read must never
   * become order-sensitive if a limit is ever added.
   */
  private async readPriorRepositories(
    userId: string,
  ): Promise<
    ReadonlyMap<string, PriorRepositoryState>
  > {
    const rows =
      await this.prisma.evidence.findMany({
        where: {
          userId,
          sourceType: 'GITHUB',
        },
        select: {
          externalId: true,
          metadata: true,
        },
        orderBy: { externalId: 'asc' },
      });

    const prior = new Map<
      string,
      PriorRepositoryState
    >();

    for (const row of rows) {
      const state = readPriorState(row);

      if (state !== null) {
        prior.set(state.externalId, state);
      }
    }

    return prior;
  }

  /*
   * Records that a run finished. Failure here is swallowed on purpose:
   * the sync succeeded, the ledger says so, and a bookkeeping write must
   * not turn that into an error the user sees.
   *
   * updateMany, not update - disconnect DELETES the connection row, so a
   * disconnect racing a long sync would make update() throw P2025 after
   * the work was already done. The data payload names one field, so this
   * write is structurally incapable of touching a token column.
   */
  /*
   * The run id used to be a parameter because the failure path
   * interpolated it into a log message. PR-5 replaced that message with a
   * structured event carrying an event code, so the argument had no
   * remaining reader and is gone rather than left as dead weight.
   */
  private async stampLastSyncedAt(userId: string): Promise<void> {
    try {
      await this.prisma.externalConnection.updateMany(
        {
          where: {
            userId,
            provider: PROVIDER,
          },
          data: { lastSyncedAt: new Date() },
        },
      );
    } catch {
      /*
       * The run id is dropped rather than logged. It is not personal data,
       * but it is not in the log allowlist either, and the event code plus
       * the request id already identify this failure - adding a field to
       * the allowlist for one line would be widening the control for
       * convenience.
       */
      this.structured.event('warn', 'github.sync.stamp_failed', {
        provider: 'github',
        operation: 'stamp_last_synced_at',
        errorCategory: 'dependency',
      });
    }
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
