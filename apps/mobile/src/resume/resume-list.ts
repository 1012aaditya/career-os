/*
 * The list of a user's imported resumes, and deleting one from it.
 *
 * Pure, for the same reason `career/` and `market/` are: what is worth
 * testing here is not layout but which of four states the screen is in,
 * whether a second delete press is allowed, and what a row is allowed to
 * say. A screen that decides those inline can only be checked by rendering
 * it, and this app deliberately does not render React in tests.
 *
 * THE STATE DISTINCTION THAT MATTERS. Loading, error, empty and loaded are
 * four different things, and the failure PR-1 called out is showing an
 * EMPTY state when the request actually FAILED - which tells a user they
 * have no resumes when in fact we could not find out. `listState` refuses
 * to conflate them.
 */

import type {
  ResumeImport,
  ResumeImportStatus,
} from '../api/resume-import';

export type ResumeListState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'empty' }
  | { status: 'loaded'; imports: ResumeImport[] };

/**
 * Which state a screen is in, from the three things it knows.
 *
 * The order is the whole point. An error is reported even when `imports`
 * happens to be an empty array, because "we asked and there are none" and
 * "we could not ask" are different sentences and only one of them should
 * invite the user to import their first resume.
 */
export function listState(input: {
  loading: boolean;
  error: { message: string; retryable: boolean } | null;
  imports: ResumeImport[] | null;
}): ResumeListState {
  if (input.error !== null) {
    return {
      status: 'error',
      message: input.error.message,
      retryable: input.error.retryable,
    };
  }

  if (input.loading || input.imports === null) {
    return { status: 'loading' };
  }

  if (input.imports.length === 0) {
    return { status: 'empty' };
  }

  return { status: 'loaded', imports: input.imports };
}

/**
 * Newest first, and deterministically.
 *
 * `createdAt` alone is not a total order - two imports created in the same
 * millisecond would sort arbitrarily and the list could reorder itself
 * between renders. The id breaks the tie, which is the same rule the
 * Career Graph projections already follow.
 */
export function sortImports(imports: readonly ResumeImport[]): ResumeImport[] {
  return [...imports].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** What a status means to a person, rather than to the database. */
export function statusLabel(status: ResumeImportStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Waiting to be processed';
    case 'PROCESSING':
      return 'Being read';
    case 'NEEDS_REVIEW':
      return 'Ready for review';
    case 'CONFIRMED':
      return 'Added to your profile';
    case 'FAILED':
      return 'Could not be processed';
    default:
      return 'Unknown';
  }
}

/**
 * The confirmation shown before one resume is deleted.
 *
 * The second sentence is the honest one and it is the reason this copy is
 * defined here rather than typed into a screen. The server deletes the
 * import, its file and the evidence derived from it - and it KEEPS
 * experiences, projects, education and skills, because nothing attributes
 * those to a particular resume. Telling a user their career profile is
 * about to be deleted would be describing behaviour the API does not have.
 */
export function deleteConfirmation(fileName: string) {
  return {
    title: 'Delete this resume?',
    message: `"${fileName}" and the evidence derived from it will be deleted. The experience, projects, education and skills already in your profile are kept - they cannot be traced back to a single resume, and you may have edited them since.`,
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
  };
}

/**
 * Whether a delete press should be acted on.
 *
 * False while ANY deletion is running, not merely this one. Two deletions
 * at once is not a state the screen needs, and allowing it would mean a
 * row could disappear from under a confirmation dialog for a different row.
 */
export function canDelete(deletingId: string | null): boolean {
  return deletingId === null;
}

/**
 * The list with one import removed.
 *
 * Removed locally rather than by refetching, so a deleted row disappears
 * immediately and cannot be left on screen as a stale item that still
 * looks real. A refetch may follow; this is what makes the interim state
 * correct rather than optimistic.
 */
export function removeImport(
  imports: readonly ResumeImport[],
  id: string,
): ResumeImport[] {
  return imports.filter((entry) => entry.id !== id);
}
