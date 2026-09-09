/*
 * The account-deletion flow, as a value rather than as a screen.
 *
 * Pure: no React, no navigation, no Supabase. The screen renders what this
 * returns and calls back into it; every decision that could be wrong -
 * whether a second press is allowed, whether the session may be cleared,
 * what the user is told - is a function that can be asserted directly.
 *
 * This follows the pattern the rest of the app already uses: `career/` and
 * `market/` keep their decisions in pure modules and their screens thin,
 * which is why those are the only parts of the mobile app under test.
 *
 * THE PROPERTY THAT MATTERS MOST. The server deletes the auth identity
 * LAST and returns an error if that step fails, so a failure can mean the
 * data is gone and the login is not. The client must therefore never
 * decide on its own that the account is deleted: `shouldClearSession` is
 * true in exactly one state, and that state is only reachable from a
 * resolved server response.
 */

export type AccountDeletionState =
  /** Nothing is happening. The button is live. */
  | { status: 'idle' }
  /** The request is in flight. Every further press must be ignored. */
  | { status: 'deleting' }
  /**
   * The server confirmed the deletion. The session may now be cleared -
   * and doing so is what returns the app to sign-in, because
   * AuthProvider observes it and RootNavigator swaps declaratively.
   */
  | {
      status: 'deleted';
      /** Shown before sign-out when the grant survives at GitHub. */
      githubWarning: string | null;
    }
  /** The server refused or could not be reached. The session is intact. */
  | { status: 'failed'; message: string; retryable: boolean };

export const INITIAL_ACCOUNT_DELETION_STATE: AccountDeletionState = {
  status: 'idle',
};

/**
 * The copy shown before anything is destroyed.
 *
 * It enumerates what actually goes, because "this cannot be undone" is not
 * informed consent - a person deleting an account is entitled to know that
 * it takes their imported resumes and their career profile with it. Every
 * item listed here corresponds to something the server really deletes.
 */
export const ACCOUNT_DELETION_CONFIRMATION = {
  title: 'Delete your account?',
  message:
    'This permanently deletes your career profile, your imported resumes and the files behind them, and any connected accounts. It cannot be undone.',
  confirmLabel: 'Delete account',
  cancelLabel: 'Cancel',
} as const;

/**
 * Whether a press should start a deletion.
 *
 * The guard against double submission, and it is a function rather than a
 * disabled prop because a disabled button is a rendering detail that a
 * fast double-tap can beat. Both exist; this is the one that decides.
 */
export function canStartDeletion(state: AccountDeletionState): boolean {
  return state.status === 'idle' || state.status === 'failed';
}

/** Whether the screen should be showing progress. */
export function isDeleting(state: AccountDeletionState): boolean {
  return state.status === 'deleting';
}

/**
 * Whether the local session may be cleared.
 *
 * True in exactly one state. This is the function that would have to be
 * broken for the app to claim success over a failed deletion, which is why
 * it exists separately from the status itself.
 */
export function shouldClearSession(
  state: AccountDeletionState,
): state is Extract<AccountDeletionState, { status: 'deleted' }> {
  return state.status === 'deleted';
}

/** The transition taken when the button is pressed and accepted. */
export function startDeletion(): AccountDeletionState {
  return { status: 'deleting' };
}

/**
 * The transition taken when the server confirms.
 *
 * The GitHub warning is surfaced only when the grant was NOT revoked at
 * the provider AND there was a cleanup failure - the pair distinguishes
 * "GitHub was unreachable" from "there was no connection to revoke", and
 * only the first is something the user needs to act on.
 */
export function completeDeletion(result: {
  githubRevokedAtProvider: boolean;
  githubCleanupFailed: boolean;
}): AccountDeletionState {
  const githubWarning =
    result.githubCleanupFailed && !result.githubRevokedAtProvider
      ? 'Your GitHub connection could not be revoked automatically. You can remove it from your GitHub account settings.'
      : null;

  return { status: 'deleted', githubWarning };
}

/** The transition taken when the server refuses or cannot be reached. */
export function failDeletion(
  message: string,
  retryable: boolean,
): AccountDeletionState {
  return { status: 'failed', message, retryable };
}

/**
 * What the button says.
 *
 * Derived rather than stored, so the label can never disagree with the
 * state it is describing.
 */
export function deletionButtonLabel(state: AccountDeletionState): string {
  switch (state.status) {
    case 'deleting':
      return 'Deleting account...';
    case 'failed':
      return 'Try again';
    default:
      return 'Delete account';
  }
}
