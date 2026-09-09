import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DELETION_CONFIRMATION,
  canStartDeletion,
  completeDeletion,
  deletionButtonLabel,
  failDeletion,
  INITIAL_ACCOUNT_DELETION_STATE,
  isDeleting,
  shouldClearSession,
  startDeletion,
} from './account-deletion';

/*
 * The account-deletion flow.
 *
 * The property that matters most: the client must never decide on its own
 * that the account is gone. The server deletes the auth identity LAST and
 * returns an error if that step fails, so a failure can mean the data is
 * deleted and the login is not - and signing the user out anyway would
 * show them a sign-in screen for an account that still exists.
 */

describe('before anything happens', () => {
  it('starts idle', () => {
    expect(INITIAL_ACCOUNT_DELETION_STATE.status).toBe('idle');
    expect(canStartDeletion(INITIAL_ACCOUNT_DELETION_STATE)).toBe(true);
    expect(isDeleting(INITIAL_ACCOUNT_DELETION_STATE)).toBe(false);
  });

  /*
   * "This cannot be undone" is not informed consent. Somebody deleting an
   * account is entitled to know it takes their resumes and career profile
   * with it, and every item named here is something the server really
   * deletes.
   */
  it('warns about what is actually destroyed', () => {
    const { message } = ACCOUNT_DELETION_CONFIRMATION;

    expect(message).toMatch(/resume/i);
    expect(message).toMatch(/career profile/i);
    expect(message).toMatch(/cannot be undone/i);
  });

  it('offers an explicit cancel', () => {
    expect(ACCOUNT_DELETION_CONFIRMATION.cancelLabel).toBe('Cancel');
    expect(ACCOUNT_DELETION_CONFIRMATION.confirmLabel).toMatch(/delete/i);
  });
});

describe('while the request is running', () => {
  const deleting = startDeletion();

  /*
   * The guard against a double submission, and against a second DELETE
   * being sent by a fast double-tap.
   */
  it('refuses a second start', () => {
    expect(canStartDeletion(deleting)).toBe(false);
  });

  it('shows progress', () => {
    expect(isDeleting(deleting)).toBe(true);
    expect(deletionButtonLabel(deleting)).toMatch(/deleting/i);
  });

  /* And crucially, the session is untouched while it is in flight. */
  it('does not clear the session', () => {
    expect(shouldClearSession(deleting)).toBe(false);
  });
});

describe('when the server confirms', () => {
  const done = completeDeletion({
    githubRevokedAtProvider: true,
    githubCleanupFailed: false,
  });

  it('permits the session to be cleared', () => {
    expect(done.status).toBe('deleted');
    expect(shouldClearSession(done)).toBe(true);
  });

  it('says nothing about GitHub when the grant was revoked', () => {
    expect(done.status === 'deleted' && done.githubWarning).toBeNull();
  });

  /*
   * The one fact the user cannot discover for themselves: the grant
   * survives at GitHub and they should remove it there.
   */
  it('warns when the grant could not be revoked', () => {
    const partial = completeDeletion({
      githubRevokedAtProvider: false,
      githubCleanupFailed: true,
    });

    expect(partial.status === 'deleted' && partial.githubWarning).toMatch(
      /github/i,
    );
  });

  /*
   * Not a warning. There may simply have been no connection to revoke, and
   * telling somebody to go and remove a connection they never made is
   * worse than silence.
   */
  it('does not warn when there was nothing to revoke', () => {
    const none = completeDeletion({
      githubRevokedAtProvider: false,
      githubCleanupFailed: false,
    });

    expect(none.status === 'deleted' && none.githubWarning).toBeNull();
  });
});

describe('when the server refuses', () => {
  const failed = failDeletion('Something went wrong. Please try again.', true);

  /*
   * THE test in this file. A failure must not clear the session - the
   * account may still exist, and the server is the only thing that knows.
   */
  it('never clears the session', () => {
    expect(shouldClearSession(failed)).toBe(false);
  });

  it('allows the user to try again', () => {
    expect(canStartDeletion(failed)).toBe(true);
    expect(deletionButtonLabel(failed)).toMatch(/try again/i);
  });

  it('keeps the message it was given', () => {
    expect(failed.status === 'failed' && failed.message).toMatch(
      /something went wrong/i,
    );
  });

  /*
   * An expired session during deletion is not retryable - the app is
   * signing the user out over it anyway.
   */
  it('records when a retry would be pointless', () => {
    const expired = failDeletion('Your session has expired.', false);

    expect(expired.status === 'failed' && expired.retryable).toBe(false);
  });
});

describe('the states that may clear a session', () => {
  /*
   * Exhaustive, because this is the single decision that separates "your
   * account is gone" from "you are looking at a sign-in screen for an
   * account that still exists".
   */
  it('is exactly one', () => {
    const states = [
      INITIAL_ACCOUNT_DELETION_STATE,
      startDeletion(),
      failDeletion('nope', true),
      completeDeletion({
        githubRevokedAtProvider: true,
        githubCleanupFailed: false,
      }),
    ];

    expect(states.filter(shouldClearSession)).toHaveLength(1);
    expect(states.filter(shouldClearSession)[0]?.status).toBe('deleted');
  });
});
