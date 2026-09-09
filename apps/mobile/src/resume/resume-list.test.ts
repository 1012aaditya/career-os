import { describe, expect, it } from 'vitest';

import type { ResumeImport } from '../api/resume-import';
import {
  canDelete,
  deleteConfirmation,
  listState,
  removeImport,
  sortImports,
  statusLabel,
} from './resume-list';

/*
 * The resume list, and deleting from it.
 *
 * Two things are defended here. First, that an error is never rendered as
 * an empty state - "you have no resumes" and "we could not find out" are
 * different sentences, and only one should invite somebody to import their
 * first one. Second, that the confirmation copy matches what the server
 * actually does, which is narrower than "delete my resume" sounds.
 */

function anImport(over: Partial<ResumeImport> = {}): ResumeImport {
  return {
    id: 'import-1',
    fileName: 'resume.pdf',
    storagePath: 'user-1/import-1/resume.pdf',
    status: 'CONFIRMED',
    extractionResult: null,
    errorMessage: null,
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
    ...over,
  };
}

describe('which state the screen is in', () => {
  it('is loading before anything has arrived', () => {
    expect(
      listState({ loading: true, error: null, imports: null }).status,
    ).toBe('loading');
  });

  it('is loading when nothing has been fetched yet, even if not loading', () => {
    expect(
      listState({ loading: false, error: null, imports: null }).status,
    ).toBe('loading');
  });

  it('is empty when the server said there are none', () => {
    expect(listState({ loading: false, error: null, imports: [] }).status).toBe(
      'empty',
    );
  });

  it('is loaded when there are imports', () => {
    const state = listState({
      loading: false,
      error: null,
      imports: [anImport()],
    });

    expect(state.status).toBe('loaded');
    expect(state.status === 'loaded' && state.imports).toHaveLength(1);
  });

  /*
   * THE distinction. An empty array plus an error is a FAILED request, not
   * a user with no resumes, and showing "No resumes yet" there tells them
   * something false about their own data.
   */
  it('is an error even when the list happens to be empty', () => {
    const state = listState({
      loading: false,
      error: { message: 'Cannot reach Career OS.', retryable: true },
      imports: [],
    });

    expect(state.status).toBe('error');
  });

  it('reports an error over stale results rather than showing them as fresh', () => {
    const state = listState({
      loading: false,
      error: { message: 'Cannot reach Career OS.', retryable: true },
      imports: [anImport()],
    });

    expect(state.status).toBe('error');
  });

  it('carries whether a retry is worth offering', () => {
    const expired = listState({
      loading: false,
      error: { message: 'Your session has expired.', retryable: false },
      imports: null,
    });

    expect(expired.status === 'error' && expired.retryable).toBe(false);
  });
});

describe('the order of the list', () => {
  it('puts the newest first', () => {
    const older = anImport({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = anImport({ id: 'b', createdAt: '2026-06-01T00:00:00.000Z' });

    expect(sortImports([older, newer]).map((i) => i.id)).toEqual(['b', 'a']);
  });

  /*
   * createdAt alone is not a total order. Two imports created in the same
   * millisecond would sort arbitrarily and the list could reorder itself
   * between renders - the same rule the Career Graph projections follow.
   */
  it('breaks a tie deterministically', () => {
    const one = anImport({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' });
    const two = anImport({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });

    expect(sortImports([one, two]).map((i) => i.id)).toEqual(['a', 'b']);
    expect(sortImports([two, one]).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not mutate what it was given', () => {
    const input = [
      anImport({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      anImport({ id: 'b', createdAt: '2026-06-01T00:00:00.000Z' }),
    ];

    sortImports(input);

    expect(input.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('what a status means to a person', () => {
  it.each([
    ['PENDING', /waiting/i],
    ['PROCESSING', /read/i],
    ['NEEDS_REVIEW', /review/i],
    ['CONFIRMED', /profile/i],
    ['FAILED', /could not/i],
  ] as const)('describes %s in plain words', (status, pattern) => {
    expect(statusLabel(status)).toMatch(pattern);
  });

  it('never shows the raw enum', () => {
    for (const status of [
      'PENDING',
      'PROCESSING',
      'NEEDS_REVIEW',
      'CONFIRMED',
      'FAILED',
    ] as const) {
      expect(statusLabel(status)).not.toContain('_');
      expect(statusLabel(status)).not.toBe(status);
    }
  });
});

describe('the deletion confirmation', () => {
  const confirmation = deleteConfirmation('Jane Doe Resume.pdf');

  it('names the file being deleted', () => {
    expect(confirmation.message).toContain('Jane Doe Resume.pdf');
  });

  /*
   * THE honesty test. The server deletes the import, its file and the
   * evidence derived from it, and KEEPS experiences, projects, education
   * and skills - nothing attributes those to a particular resume. Copy
   * claiming the career profile is deleted would describe behaviour the
   * API does not have.
   */
  it('says the career profile is kept, because it is', () => {
    expect(confirmation.message).toMatch(/evidence/i);
    expect(confirmation.message).toMatch(/kept/i);
    expect(confirmation.message).toMatch(/experience/i);
    expect(confirmation.message).toMatch(/skills/i);
  });

  it('does not claim the career profile is deleted', () => {
    expect(confirmation.message).not.toMatch(
      /delete[sd]? (your )?(entire )?(career profile|career graph)/i,
    );
    expect(confirmation.message).not.toMatch(/everything/i);
  });

  it('offers an explicit cancel', () => {
    expect(confirmation.cancelLabel).toBe('Cancel');
    expect(confirmation.confirmLabel).toMatch(/delete/i);
  });
});

describe('guarding a delete press', () => {
  it('allows one when nothing is being deleted', () => {
    expect(canDelete(null)).toBe(true);
  });

  /*
   * False while ANY deletion runs, not merely this one: allowing two would
   * let a row disappear from under a confirmation dialog for another row.
   */
  it('refuses while another deletion is in flight', () => {
    expect(canDelete('import-1')).toBe(false);
    expect(canDelete('import-2')).toBe(false);
  });
});

describe('removing a deleted import from the list', () => {
  /*
   * Removed locally rather than waiting for a refetch, so a deleted row
   * cannot sit on screen looking like it still exists.
   */
  it('drops exactly the one deleted', () => {
    const list = [anImport({ id: 'a' }), anImport({ id: 'b' })];

    expect(removeImport(list, 'a').map((i) => i.id)).toEqual(['b']);
  });

  it('is a no-op for an id that is not there', () => {
    const list = [anImport({ id: 'a' })];

    expect(removeImport(list, 'zzz')).toHaveLength(1);
  });

  it('does not mutate the list it was given', () => {
    const list = [anImport({ id: 'a' }), anImport({ id: 'b' })];

    removeImport(list, 'a');

    expect(list).toHaveLength(2);
  });
});
