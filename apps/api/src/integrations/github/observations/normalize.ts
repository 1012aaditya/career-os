import type {
  AccountObservation,
  ActivityObservation,
  LanguageObservation,
  RepositoryCompleteness,
  RepositoryObservation,
  SyncCompleteness,
  SyncObservation,
} from './types.js';

/*
 * Pure normalization: GitHub's payloads in, observations out.
 *
 * No HTTP, no Prisma, no clock. Every time-dependent value is passed in,
 * so the same input always produces the same output - which is what makes
 * the determinism tests meaningful rather than decorative.
 *
 * Ordering is decided here and nowhere else. Two rules:
 *
 *   - Repositories are ordered by numeric id ascending. Not by name,
 *     which changes under a rename; not by pushed_at or updated_at, which
 *     change constantly and would reshuffle the whole list between syncs;
 *     not by the order GitHub returned them, which is a paging artifact.
 *     The id is the one key that is both total and immutable.
 *   - Languages are ordered by bytes descending, then name ascending.
 *     Bytes first because it is the meaningful order, name second because
 *     bytes tie and object key order must never be allowed to decide.
 *
 * Neither ordering uses a value generated during processing.
 */

/** Trims, and treats an empty or whitespace-only string as absent. */
function optionalString(
  value: unknown,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(
  value: unknown,
): string | null {
  return optionalString(value);
}

function optionalBoolean(
  value: unknown,
): boolean {
  return value === true;
}

/*
 * GitHub emits ISO-8601 instants with a Z offset. Anything else is
 * rejected rather than coerced.
 *
 * The mobile client gates every date through the same shape, and a
 * zone-less timestamp is the specific failure that matters: ECMAScript
 * reads a date-only string as UTC but a date-time string without an
 * offset as LOCAL, so "2026-01-01T00:00:00" is a different instant on two
 * devices. Passing one through would fabricate a date rather than report
 * one.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

function optionalInstant(
  value: unknown,
): string | null {
  const text = optionalString(value);

  if (text === null || !ISO_INSTANT.test(text)) {
    return null;
  }

  const parsed = Date.parse(text);

  if (Number.isNaN(parsed)) {
    return null;
  }

  /*
   * Re-emitted from the parsed instant rather than passed through, so two
   * spellings of one moment - "2024-03-15T10:23:45Z" and
   * "2024-03-15T10:23:45.000Z" - normalize to one string and do not read
   * as a change on the next sync.
   */
  return new Date(parsed).toISOString();
}

/*
 * Numeric ids arrive as JSON numbers, which are doubles. Beyond 2^53 the
 * value has already been rounded by the parser, and a rounded id could
 * collide with a different repository - so it is refused rather than
 * stored.
 */
function numericId(value: unknown): string | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }

  return String(value);
}

function optionalCount(
  value: unknown,
): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }

  return value;
}

export function repositoryExternalId(
  repoId: string,
): string {
  return `github:repo:${repoId}`;
}

/**
 * Normalizes GitHub's languages payload.
 *
 * The payload is an object, and object key order is an implementation
 * detail of whatever produced it - so the entries are sorted rather than
 * iterated. Names are preserved exactly as GitHub spells them.
 */
export function normalizeLanguages(
  raw: unknown,
): LanguageObservation[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return [];
  }

  const entries: LanguageObservation[] = [];

  for (const [name, bytes] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const trimmed = name.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const count = optionalCount(bytes);

    if (count === null) {
      continue;
    }

    entries.push({ name: trimmed, bytes: count });
  }

  return entries.sort((a, b) => {
    if (a.bytes !== b.bytes) {
      return b.bytes - a.bytes;
    }

    return a.name < b.name ? -1 : 1;
  });
}

export type RepositoryNormalizationInput = {
  raw: unknown;
  languages?: unknown;
  activity?: ActivityObservation;
  completeness: RepositoryCompleteness;
};

/**
 * Normalizes one repository, or returns null if it is unusable.
 *
 * Null rather than a partial record: a repository with no resolvable
 * numeric id has no stable identity, and a record that cannot be
 * identified cannot be deduplicated, updated or retracted later.
 */
export function normalizeRepository(
  input: RepositoryNormalizationInput,
): RepositoryObservation | null {
  const raw = input.raw;

  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return null;
  }

  const source = raw as Record<string, unknown>;

  const repoId = numericId(source['id']);

  if (repoId === null) {
    return null;
  }

  const name = requiredString(source['name']);
  const fullName = requiredString(
    source['full_name'],
  );
  const htmlUrl = requiredString(
    source['html_url'],
  );

  if (
    name === null ||
    fullName === null ||
    htmlUrl === null
  ) {
    return null;
  }

  const ownerRaw = source['owner'];

  const ownerId =
    typeof ownerRaw === 'object' &&
    ownerRaw !== null
      ? numericId(
          (ownerRaw as Record<string, unknown>)[
            'id'
          ],
        )
      : null;

  const ownerLogin =
    typeof ownerRaw === 'object' &&
    ownerRaw !== null
      ? requiredString(
          (ownerRaw as Record<string, unknown>)[
            'login'
          ],
        )
      : null;

  if (ownerId === null || ownerLogin === null) {
    return null;
  }

  /*
   * `private` is the field GitHub has always emitted; `visibility` is the
   * newer one and carries "public" | "private" | "internal". Public is
   * asserted only when a field actually says so, so an unexpected payload
   * defaults to NOT public rather than to public.
   */
  const visibility = optionalString(
    source['visibility'],
  );

  const isPublic =
    visibility !== null
      ? visibility === 'public'
      : source['private'] === false;

  return {
    externalId: repositoryExternalId(repoId),
    repoId,
    nodeId: optionalString(source['node_id']),
    name,
    fullName,
    htmlUrl,
    owner: {
      id: ownerId,
      login: ownerLogin,
      type:
        typeof ownerRaw === 'object' &&
        ownerRaw !== null
          ? optionalString(
              (
                ownerRaw as Record<
                  string,
                  unknown
                >
              )['type'],
            )
          : null,
    },
    isPublic,
    isFork: optionalBoolean(source['fork']),
    isArchived: optionalBoolean(
      source['archived'],
    ),
    isDisabled: optionalBoolean(
      source['disabled'],
    ),
    defaultBranch: optionalString(
      source['default_branch'],
    ),
    description: optionalString(
      source['description'],
    ),
    sizeKb: optionalCount(source['size']),
    createdAt: optionalInstant(
      source['created_at'],
    ),
    updatedAt: optionalInstant(
      source['updated_at'],
    ),
    /*
     * Nullable in practice: a repository that has never been pushed to
     * reports null, and reading that as "never active" would be an
     * inference rather than an observation.
     */
    pushedAt: optionalInstant(
      source['pushed_at'],
    ),
    languages: normalizeLanguages(
      input.languages,
    ),
    activity:
      input.activity ?? emptyActivity(),
    completeness: input.completeness,
  };
}

/** Activity that was not established. Null everywhere, never zero. */
export function emptyActivity(): ActivityObservation {
  return {
    commitsAttributed: null,
    pullRequestsAuthored: null,
    issuesAuthored: null,
    firstActivityAt: null,
    lastActivityAt: null,
  };
}

/**
 * Orders and deduplicates repositories.
 *
 * Duplicates are real: GitHub's paginated listings can repeat an entry
 * when the underlying set changes mid-walk. Resolution is by numeric id,
 * keeping the FIRST occurrence, so the result does not depend on how far
 * through a page the duplicate appeared.
 */
export function orderRepositories(
  repositories: RepositoryObservation[],
): RepositoryObservation[] {
  const seen = new Map<
    string,
    RepositoryObservation
  >();

  for (const repository of repositories) {
    if (!seen.has(repository.repoId)) {
      seen.set(repository.repoId, repository);
    }
  }

  return [...seen.values()].sort((a, b) => {
    /*
     * Numeric comparison on an id held as text. String order would put
     * "1000" before "999", which is stable but arbitrary; numeric order
     * is stable AND corresponds to repository creation order, which makes
     * the output readable as well as reproducible.
     */
    const left = Number(a.repoId);
    const right = Number(b.repoId);

    if (left !== right) {
      return left - right;
    }

    return 0;
  });
}

export type SyncNormalizationInput = {
  account: AccountObservation;
  repositories: RepositoryObservation[];
  reposTotal: number;
  scannedAt: string;
  scannedSince: string | null;
  truncated: boolean;
  authoredActivityEstablished?: boolean;
};

export function buildSyncObservation(
  input: SyncNormalizationInput,
): SyncObservation {
  const repositories = orderRepositories(
    input.repositories,
  );

  /*
   * Scanned means "we looked at it", which is not the same as "it is in
   * the list". A repository present but marked NOT_SCANNED was listed and
   * then skipped for budget, and counting it as scanned is exactly the
   * mistake that turns a PARTIAL run into a false SUCCEEDED.
   */
  const reposScanned = repositories.filter(
    (repository) =>
      repository.completeness.commits !==
      'NOT_SCANNED',
  ).length;

  const completeness: SyncCompleteness = {
    reposScanned,
    /*
     * Never less than what we hold. If the listing itself was truncated,
     * the caller supplies the larger number it knows about; if it did not,
     * the count we have is the best available total.
     */
    reposTotal: Math.max(
      input.reposTotal,
      repositories.length,
    ),
    scannedAt: input.scannedAt,
    scannedSince: input.scannedSince,
    truncated: input.truncated,
    /*
     * Defaults to true so a caller that predates this field is not
     * retroactively reported as incomplete.
     */
    authoredActivityEstablished:
      input.authoredActivityEstablished ?? true,
  };

  return {
    account: input.account,
    repositories,
    completeness,
  };
}

/**
 * Whether a run may be reported as fully successful.
 *
 * The one rule the completeness contract turns on: a run that looked at
 * fewer repositories than it found is PARTIAL, and a truncated listing is
 * PARTIAL too, because there are repositories we never even enumerated.
 */
export function isCompleteScan(
  completeness: SyncCompleteness,
): boolean {
  return (
    completeness.authoredActivityEstablished &&
    !completeness.truncated &&
    completeness.reposScanned >=
      completeness.reposTotal
  );
}
