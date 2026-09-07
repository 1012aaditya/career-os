import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Linking } from 'react-native';

import {
  disconnectGithub,
  fetchGithubStatus,
  startGithubConnect,
  syncGithub,
  type GithubStatus,
  type GithubSyncSummary,
} from '../api/github';
import { useAuth } from '../auth/AuthProvider';

import {
  describeCallbackFailure,
  describeSyncSummary,
  deriveUiState,
  parseCallbackUrl,
  type GithubUiState,
} from './github-connection';

/*
 * The GitHub connection, held above navigation.
 *
 * It lives at the application root rather than inside the Profile screen
 * because the callback can arrive when Profile is not mounted. A cold
 * start FROM the deep link renders no screen until the OS hands over the
 * URL, and a resume from background can land on any tab. Logic that only
 * ran in a screen's effect would miss both, and the user would come back
 * from GitHub to an app that still said "Not connected".
 *
 * Four rules hold the security of this component, and each exists because
 * of a specific way the naive version is wrong:
 *
 *   1. The deep link never decides connectedness. Any app on the device
 *      can send it - iOS resolves duplicate URL schemes first-come,
 *      first-served with no ownership check - so a forged "success" must
 *      be harmless. It triggers a status fetch and nothing else.
 *   2. Nothing is acted on until the session is RESOLVED and present.
 *      apiRequest omits the Authorization header when there is no session
 *      rather than failing, so acting early would send an anonymous
 *      request, take a 401, and tell the user a successful connection had
 *      failed. A link that arrives early is held, not dropped.
 *   3. A callback is discarded if the signed-in user changed since the
 *      flow began. The link carries no user binding, so without this the
 *      app would report user A's result to user B.
 *   4. The callback refreshes status and never starts a sync. A deep link
 *      is unauthenticated and replayable without limit; wiring it to sync
 *      would let any app on the device burn the user's GitHub rate limit,
 *      which is shared with every other integration they have authorised.
 */

type GithubConnectionValue = {
  state: GithubUiState;
  status: GithubStatus | null;
  /** A safe sentence for the user. Never a raw error or provider text. */
  message: string | null;
  connect: () => Promise<void>;
  sync: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const GithubConnectionContext = createContext<
  GithubConnectionValue | undefined
>(undefined);

export function GithubConnectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { session, loading } = useAuth();

  const userId = session?.user.id ?? null;

  const [status, setStatus] =
    useState<GithubStatus | null>(null);

  const [busy, setBusy] = useState<
    'connecting' | 'syncing' | null
  >(null);

  const [lastSyncStatus, setLastSyncStatus] =
    useState<string | null>(null);

  const [message, setMessage] = useState<
    string | null
  >(null);

  const [hasError, setHasError] =
    useState(false);

  /*
   * Guards against a double tap and against a second request while one is
   * in flight. A ref rather than state because it must be correct
   * synchronously: a disabled prop is one render behind the tap that set
   * it, so two taps in the same tick would both pass a state check.
   */
  const inFlight = useRef(false);

  /*
   * Which user opened GitHub, and whether we are expecting a callback at
   * all. Memory-only on purpose - persisting it would survive a sign-out
   * and defeat the point. The consequence is that an OS-killed app loses
   * the flag, so a cold-start link is still honoured as "re-read status",
   * never as "show success". That asymmetry is the resolution, not a gap.
   */
  const pendingConnect = useRef<string | null>(
    null,
  );

  const state = deriveUiState({
    serverStatus: status,
    busy,
    lastSyncStatus,
    hasError,
  });

  const refresh = useCallback(async () => {
    if (!userId) {
      return;
    }

    try {
      setStatus(await fetchGithubStatus());
      setHasError(false);
    } catch {
      /*
       * A failed read is not a disconnection. The previous answer stays,
       * because claiming the connection is gone on one failed request
       * would be a stronger statement than the evidence supports.
       */
      setHasError(true);
      setMessage(
        'Could not check your GitHub connection. Please try again.',
      );
    }
  }, [userId]);

  /*
   * Both ways a callback can arrive. getInitialURL covers a cold start -
   * the app was launched BY the link, so no listener existed when it was
   * delivered. The url event covers running or resumed. Handling only one
   * is the classic way this breaks, in whichever case went untested.
   */
  useEffect(() => {
    if (loading || !userId) {
      /*
       * Rule 2. Nothing is read or acted on until there is a resolved
       * session; the effect re-runs when there is, and getInitialURL
       * still returns the launch URL then, so the link is held rather
       * than lost.
       */
      return;
    }

    let cancelled = false;

    const handle = (url: string | null) => {
      if (cancelled) {
        return;
      }

      const result = parseCallbackUrl(url);

      if (result === null) {
        /* Not our link - someone else's deep link, or none. */
        return;
      }

      /* Rule 3. */
      const startedBy = pendingConnect.current;

      if (
        startedBy !== null &&
        startedBy !== userId
      ) {
        pendingConnect.current = null;
        return;
      }

      pendingConnect.current = null;

      setMessage(
        result.outcome === 'success'
          ? null
          : describeCallbackFailure(
              result.reason,
            ),
      );

      /*
       * Rule 1 and 4. Refreshed on failure as well as success - a failed
       * callback does not prove nothing changed, and re-reading is the
       * only way to be sure of what is shown. No sync is started here.
       */
      void refresh();
    };

    void Linking.getInitialURL().then(handle);

    const subscription = Linking.addEventListener(
      'url',
      (event) => handle(event.url),
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [loading, userId, refresh]);

  /* The first authoritative read, once there is someone to read for. */
  useEffect(() => {
    if (userId) {
      void refresh();
      return;
    }

    setStatus(null);
    setMessage(null);
    setHasError(false);
    setLastSyncStatus(null);
    pendingConnect.current = null;
  }, [userId, refresh]);

  const connect = useCallback(async () => {
    if (inFlight.current || !userId) {
      return;
    }

    inFlight.current = true;
    setBusy('connecting');
    setMessage(null);
    setHasError(false);

    try {
      const { authorizationUrl } =
        await startGithubConnect();

      /*
       * Recorded before the browser opens, so a callback that arrives
       * while a different account is signed in can be discarded.
       */
      pendingConnect.current = userId;

      /*
       * The system browser, not an in-app web view. RFC 8252 requires an
       * external user agent: an embedded view could read the GitHub
       * credentials the user types, and GitHub may refuse to render in
       * one. Linking is built into React Native, so this costs no new
       * dependency.
       *
       * authorizationUrl is never logged, stored or handed to an error
       * reporter. It carries the live OAuth state, which for its ten
       * minute lifetime is a capability: anyone holding it can complete
       * the flow against this user's pending request.
       */
      await Linking.openURL(authorizationUrl);
    } catch {
      pendingConnect.current = null;
      setHasError(true);
      setMessage(
        'Could not start the GitHub connection. Please try again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [userId]);

  const sync = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setBusy('syncing');
    setMessage(null);
    setHasError(false);

    let summary: GithubSyncSummary | null = null;

    try {
      summary = await syncGithub();
    } catch {
      setHasError(true);
      /*
       * Deliberately generic. The API's failure body carries a reason
       * code rather than a provider message, and even that is not shown -
       * it exists for support, not for the screen.
       */
      setMessage(
        'The GitHub sync did not finish. Please try again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }

    if (summary === null) {
      return;
    }

    setMessage(describeSyncSummary(summary));

    /*
     * Recorded so deriveUiState can keep the connection visibly partial.
     * Set before the refresh, so a completed-but-incomplete run cannot be
     * rounded up to 'connected' by the status read that follows.
     */
    setLastSyncStatus(summary.status);

    await refresh();
  }, [refresh]);

  const disconnect = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    try {
      await disconnectGithub();
      setMessage(null);
      setLastSyncStatus(null);
      setHasError(false);
    } catch {
      setHasError(true);
      setMessage(
        'Could not disconnect GitHub. Please try again.',
      );
    } finally {
      inFlight.current = false;
    }

    /*
     * The server decides whether it worked. Nothing local is cleared for
     * the provider's sake, because nothing GitHub-related is stored on
     * the device in the first place.
     */
    await refresh();
  }, [refresh]);

  return (
    <GithubConnectionContext.Provider
      value={{
        state,
        status,
        message,
        connect,
        sync,
        disconnect,
        refresh,
      }}
    >
      {children}
    </GithubConnectionContext.Provider>
  );
}

export function useGithubConnection() {
  const value = useContext(
    GithubConnectionContext,
  );

  if (!value) {
    throw new Error(
      'useGithubConnection must be used inside a GithubConnectionProvider',
    );
  }

  return value;
}
