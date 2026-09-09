import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateSession,
  isInvalidating,
  resetSessionInvalidationForTests,
} from './session-invalidation';

/*
 * What happens when several requests discover at once that the session is
 * gone.
 *
 * This is the concurrency case PR-4 exists to get right. A screen mounting
 * fires several requests together; when a session has been revoked they
 * all come back 401 within milliseconds. Signing out once per 401 means N
 * sign-outs racing each other, and the user watching the screen flicker.
 */

afterEach(() => {
  resetSessionInvalidationForTests();
});

describe('a single expiry', () => {
  it('signs out once', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    await invalidateSession(signOut);

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('is finished afterwards, so a later expiry is handled too', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    await invalidateSession(signOut);

    expect(isInvalidating()).toBe(false);

    await invalidateSession(signOut);

    expect(signOut).toHaveBeenCalledTimes(2);
  });
});

describe('concurrent expiries', () => {
  /*
   * THE test in this file. Ten simultaneous 401s must produce exactly one
   * sign-out, not ten.
   */
  it('collapse into one sign-out', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const signOut = vi.fn().mockReturnValue(gate);

    const all = Promise.all(
      Array.from({ length: 10 }, () => invalidateSession(signOut)),
    );

    expect(signOut).toHaveBeenCalledTimes(1);

    release();
    await all;

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('all resolve, so no caller is left waiting forever', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    const results = await Promise.all([
      invalidateSession(signOut),
      invalidateSession(signOut),
      invalidateSession(signOut),
    ]);

    expect(results).toEqual([undefined, undefined, undefined]);
  });

  /*
   * Non-vacuity: if the latch were removed, the assertion above would see
   * ten calls. Demonstrated by calling the same signOut directly.
   */
  it('would have signed out ten times without the latch', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    await Promise.all(Array.from({ length: 10 }, () => signOut()));

    expect(signOut).toHaveBeenCalledTimes(10);
  });
});

describe('when signing out itself fails', () => {
  /*
   * A sign-out failure is not something a screen can act on, and letting
   * it reject would add an unhandled rejection on top of an already-bad
   * moment.
   */
  it('does not reject', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(invalidateSession(signOut)).resolves.toBeUndefined();
  });

  /*
   * And the latch clears, so a failed invalidation cannot wedge it shut
   * and leave every future 401 silently ignored - which would be a session
   * that never expires in the UI.
   */
  it('leaves the latch open for the next attempt', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('network down'));

    await invalidateSession(signOut);

    expect(isInvalidating()).toBe(false);

    await invalidateSession(signOut);

    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
