/*
 * What happens when the server says the session is no longer valid.
 *
 * THE PROBLEM THIS SOLVES. A screen mounting fires several requests at
 * once. When a session has been revoked - the user signed out on another
 * device, the refresh token expired, the account was deleted - all of them
 * come back 401 within a few milliseconds of each other. The naive
 * response is for each to sign out and navigate, which means N sign-outs
 * racing each other and N navigations, and the user watching the screen
 * flicker before landing somewhere arbitrary.
 *
 * THE SHAPE OF THE FIX. One latch. The first 401 starts the invalidation
 * and every concurrent 401 joins the same promise; nothing starts a second
 * one while the first is running. Once it settles the latch clears, so a
 * genuinely later expiry - the user signs in again, and that session
 * expires too - is handled normally rather than swallowed forever.
 *
 * AND THERE IS NO NAVIGATION HERE, deliberately. Invalidating the session
 * clears it from Supabase, which fires onAuthStateChange, which flips
 * AuthProvider's `session` to null, which makes RootNavigator render the
 * sign-in screen. That is the app's existing declarative architecture, and
 * routing through it avoids the two bugs an imperative navigate() would
 * introduce: navigating before the NavigationContainer is mounted, and
 * navigating twice because two requests both decided to.
 */

type SignOut = () => Promise<unknown>;

let inFlight: Promise<void> | null = null;

/**
 * Signs the session out, at most once at a time.
 *
 * Never throws. A sign-out that fails is not something a screen can act
 * on, and letting it reject would turn "your session expired" into an
 * unhandled rejection on top of it. The local session is cleared by
 * Supabase either way; the worst case is that the next request also gets a
 * 401 and tries again, which is exactly the behaviour we want.
 */
export function invalidateSession(signOut: SignOut): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      await signOut();
    } catch {
      /*
       * Swallowed on purpose. See above: there is no recovery a caller
       * could perform, and the alternative is an unhandled rejection
       * arriving during an already-bad moment.
       */
    } finally {
      /*
       * Cleared in `finally`, so a failed invalidation does not wedge the
       * latch shut and leave every future 401 silently ignored.
       */
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Whether an invalidation is currently running. Exposed for tests. */
export function isInvalidating(): boolean {
  return inFlight !== null;
}

/**
 * Drops the latch without signing anything out.
 *
 * For tests only, so one case cannot leak a pending latch into the next.
 */
export function resetSessionInvalidationForTests(): void {
  inFlight = null;
}
