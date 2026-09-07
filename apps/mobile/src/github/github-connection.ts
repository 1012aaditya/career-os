/*
 * The GitHub connection's logic, with no React and no React Native in it.
 *
 * Everything that decides what the user is told lives here as pure
 * functions, for the same reason the Career Graph projections do: the
 * mobile suite runs under plain vitest in Node with no native transform,
 * so anything importable without React Native is testable directly, and
 * anything else is not tested at all. The screen is left as thin as it
 * can be - it renders what these functions return.
 *
 * The rule that shapes all of it: the deep link is a HINT, never a fact.
 * The server is the only thing that knows whether a connection exists,
 * and the UI must never say "Connected" on the strength of a URL that
 * any application on the device could have sent.
 */

export type GithubUiState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'partial'
  | 'error';

/*
 * The closed set, mirrored from the backend's CallbackOutcome plus the
 * catch-all this module assigns to anything it does not recognise.
 *
 * A union rather than `string`, so a caller's switch is exhaustive and
 * nobody can render a value that arrived in a URL.
 */
export type CallbackFailureReason =
  | 'access_denied'
  | 'invalid_state'
  | 'exchange_failed'
  | 'unverified_email'
  | 'account_unavailable'
  | 'account_already_linked'
  | 'server_error'
  | 'unknown';

export type CallbackResult =
  | { outcome: 'success' }
  | {
      outcome: 'error';
      reason: CallbackFailureReason;
    };

/*
 * Derived from the bundle identifier rather than invented, because RFC
 * 8252 requires a native app's redirect scheme to be based on a domain
 * the app controls, expressed in reverse order. A bare "careeros" would
 * not meet that: any application could plausibly claim it.
 *
 * It is worth being clear about what this does and does not buy. Another
 * app CAN still register this scheme - iOS resolves duplicates
 * first-come, first-served with no ownership check - so the reverse-domain
 * form is a claim of intent, not an enforcement mechanism. What actually
 * makes hijacking pointless here is that the link carries nothing worth
 * stealing and proves nothing: see parseCallbackUrl.
 */
export const CALLBACK_SCHEME = 'com.careeros.mobile';

export const CALLBACK_PATH = 'github/callback';

/*
 * The reasons the backend can report, and what each one means to a
 * person. The set is closed on the server (CallbackOutcome in
 * github-oauth.service.ts) and is mirrored closed here: an unrecognised
 * code gets a generic sentence rather than being echoed, because echoing
 * a value from a URL into the interface is how an attacker gets to write
 * text on our screen.
 */
const FAILURE_SENTENCES: Record<
  CallbackFailureReason,
  string
> = {
  unknown:
    'GitHub was not connected. Please try again.',
  access_denied:
    'You did not finish authorising Career OS on GitHub. Nothing was connected.',
  invalid_state:
    'That sign-in link was no longer valid. Please start again.',
  exchange_failed:
    'GitHub could not complete the connection. Please try again.',
  unverified_email:
    'GitHub needs a verified primary email on your account before it will connect. Verify one on GitHub, then try again.',
  account_unavailable:
    'GitHub could not be reached to confirm your account. Please try again.',
  account_already_linked:
    'That GitHub account is already connected to another Career OS account.',
  server_error:
    'Something went wrong on our side. Please try again.',
};

const GENERIC_FAILURE =
  'GitHub was not connected. Please try again.';

/**
 * Reads a deep link, or returns null if it is not our callback.
 *
 * Returns null - not an error - for links that belong to something else,
 * so an unrelated deep link cannot disturb the GitHub UI.
 *
 * Only `status` is ever read. Any other query parameter is ignored
 * entirely rather than carried into the result: the backend puts nothing
 * else there, so anything else present did not come from us, and copying
 * it anywhere would be laundering an attacker's data into our state.
 */
export function parseCallbackUrl(
  url: string | null,
): CallbackResult | null {
  if (!url) {
    return null;
  }

  const parsed = parseUrl(url);

  if (parsed === null) {
    return null;
  }

  if (
    parsed.scheme !== CALLBACK_SCHEME ||
    parsed.path !== CALLBACK_PATH
  ) {
    return null;
  }

  const status = parsed.params.get('status');

  if (status === 'success') {
    return { outcome: 'success' };
  }

  /*
   * Everything that is not exactly "success" is a failure, including a
   * missing status and a value we do not recognise. Defaulting the other
   * way would let a link reading ?status=SUCCESS, or one with no status
   * at all, be treated as a completed connection.
   */
  const reason =
    parsed.params.get('reason') ?? 'server_error';

  return {
    outcome: 'error',
    /*
     * Normalised against the known set before it is kept. The raw value
     * never leaves this function, so nothing downstream can render an
     * arbitrary string that arrived in a URL.
     */
    reason: isKnownReason(reason)
      ? reason
      : 'unknown',
  };
}

function isKnownReason(
  reason: string,
): reason is CallbackFailureReason {
  return reason in FAILURE_SENTENCES;
}

export function describeCallbackFailure(
  reason: string,
): string {
  return isKnownReason(reason)
    ? FAILURE_SENTENCES[reason]
    : GENERIC_FAILURE;
}

export function isPartialSync(
  status: string,
): boolean {
  return status !== 'SUCCEEDED';
}

/*
 * The only thing that may decide the UI state.
 *
 * Its signature is the security argument: there is no parameter for the
 * deep link, so no arrangement of callback URLs can produce 'connected'.
 * The link's role ends at triggering a status fetch; this function reads
 * only what the server said. Written as a pure function rather than left
 * inline in the provider precisely so that claim is testable in a suite
 * that cannot import React Native.
 *
 * `connected` alone is not enough, either. The API reports connected: true
 * whenever a connection row exists, and carries the row's real state in a
 * separate field - so a REVOKED or INVALID connection reads as connected
 * while the sync endpoint refuses it with a 404. Rendering the boolean on
 * its own would offer a Sync button that cannot work. ACTIVE is the only
 * state that means what the word "connected" implies to a person.
 */
export function deriveUiState(input: {
  serverStatus: {
    connected: boolean;
    status: string | null;
  } | null;
  busy: 'connecting' | 'syncing' | null;
  lastSyncStatus: string | null;
  hasError: boolean;
}): GithubUiState {
  if (input.busy !== null) {
    return input.busy;
  }

  if (input.hasError) {
    return 'error';
  }

  const usable =
    input.serverStatus?.connected === true &&
    input.serverStatus.status === 'ACTIVE';

  if (!usable) {
    return 'disconnected';
  }

  /*
   * A connection whose last run did not complete stays visibly partial,
   * so an incomplete sync is never rounded up to a finished one just
   * because the connection itself is healthy.
   */
  if (
    input.lastSyncStatus !== null &&
    isPartialSync(input.lastSyncStatus)
  ) {
    return 'partial';
  }

  return 'connected';
}

export type SyncSummaryCounts = {
  created: number;
  updated: number;
  reposScanned: number;
  reposRevalidated: number;
  reposTotal: number;
  reposSkipped: number;
};

/**
 * The sentence shown after a sync.
 *
 * Written to be true rather than encouraging. A partial run is never
 * described as finished, a run that carried most of its counts forward
 * does not claim to have re-read them, and repositories that were listed
 * but never looked at are disclosed instead of quietly shrinking the
 * numbers.
 */
export function describeSyncSummary(summary: {
  status: string;
  counts: SyncSummaryCounts;
}): string {
  const { counts } = summary;

  const repositories = plural(
    counts.reposScanned,
    'repository',
    'repositories',
  );

  const parts: string[] = [];

  parts.push(
    isPartialSync(summary.status)
      ? `Partly updated: ${repositories} of ${counts.reposTotal} covered.`
      : `Up to date: ${repositories} covered.`,
  );

  /*
   * Stated whenever it happened. Without it a steady-state sync reads as
   * though everything was re-read, when in fact almost nothing was.
   */
  if (counts.reposRevalidated > 0) {
    parts.push(
      `${counts.reposRevalidated} unchanged since the last sync.`,
    );
  }

  if (counts.reposSkipped > 0) {
    parts.push(
      `${counts.reposSkipped} not looked at yet.`,
    );
  }

  if (counts.created > 0) {
    parts.push(
      `${plural(counts.created, 'new record', 'new records')} added.`,
    );
  }

  /*
   * Mentioned only when nothing was created, so a run that changed
   * something says what, and a routine run does not pad the sentence with
   * a number that means "nothing new happened".
   */
  if (
    counts.created === 0 &&
    counts.updated > 0
  ) {
    parts.push(
      `${plural(counts.updated, 'record', 'records')} refreshed.`,
    );
  }

  return parts.join(' ');
}

function plural(
  count: number,
  one: string,
  many: string,
): string {
  return `${count} ${count === 1 ? one : many}`;
}

/*
 * A deliberately small URL reader.
 *
 * React Native's URL implementation does not parse custom schemes
 * consistently across platforms, and this only ever has to read one shape
 * that we ourselves generate. Anything it cannot read returns null, which
 * the caller treats as "not our link" - failing closed.
 */
function parseUrl(url: string): {
  scheme: string;
  path: string;
  params: URLSearchParams;
} | null {
  const schemeEnd = url.indexOf('://');

  if (schemeEnd <= 0) {
    return null;
  }

  /*
   * Lower-cased because RFC 3986 makes a URI scheme case-insensitive, so
   * COM.CAREEROS.MOBILE:// is the same link. Failing closed on it would
   * merely lose a callback, but there is no reason to.
   */
  const scheme = url
    .slice(0, schemeEnd)
    .toLowerCase();

  /*
   * The fragment is cut here rather than left to be absorbed into the
   * last query value. Without this, a link ending in #<something> puts
   * that something inside the reason - safe today only because the reason
   * is later clamped to a known set, which is a downstream guard carrying
   * an upstream parsing bug.
   */
  const withoutFragment = url.slice(
    schemeEnd + 3,
  );

  const fragmentStart =
    withoutFragment.indexOf('#');

  const rest =
    fragmentStart === -1
      ? withoutFragment
      : withoutFragment.slice(0, fragmentStart);

  const queryStart = rest.indexOf('?');

  const path = (
    queryStart === -1
      ? rest
      : rest.slice(0, queryStart)
  ).replace(/^\/+|\/+$/g, '');

  const query =
    queryStart === -1
      ? ''
      : rest.slice(queryStart + 1);

  let params: URLSearchParams;

  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }

  return { scheme, path, params };
}
