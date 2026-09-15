import { describe, expect, it } from 'vitest';

import {
  EMPTY_DRAFT,
  draftProblems,
  isSubmittable,
  visibleProblems,
  type ManualEvidenceDraft,
} from './manual-evidence';

/*
 * When a problem is shown, as distinct from when it exists.
 *
 * The screen rendered every problem on every render, so opening Add
 * Evidence put "Choose what kind of evidence this is." and "Give this a
 * title." on screen in red before the person had typed anything. Caught
 * on the simulator, not by a test - there was no test file for this
 * module at all.
 */

const nothing: ReadonlySet<keyof ManualEvidenceDraft> = new Set();

const touching = (
  ...fields: (keyof ManualEvidenceDraft)[]
): ReadonlySet<keyof ManualEvidenceDraft> => new Set(fields);

describe('an untouched form', () => {
  it('shows nothing, though problems exist', () => {
    expect(draftProblems(EMPTY_DRAFT).length).toBeGreaterThan(0);
    expect(visibleProblems(EMPTY_DRAFT, nothing)).toEqual([]);
  });

  /*
   * The point of keeping visibleProblems separate. If hiding the message
   * also hid the problem, the form would look ready to submit while empty
   * - a worse defect than the one being fixed.
   */
  it('is still not submittable', () => {
    expect(isSubmittable(EMPTY_DRAFT)).toBe(false);
  });
});

describe('once a field is touched', () => {
  it('shows that field and no other', () => {
    const shown = visibleProblems(EMPTY_DRAFT, touching('title'));

    expect(shown.map((problem) => problem.field)).toEqual(['title']);
    expect(shown[0]!.message).toBe('Give this a title.');
  });

  it('shows every touched field that is wrong', () => {
    const shown = visibleProblems(EMPTY_DRAFT, touching('kind', 'title'));

    expect(shown.map((problem) => problem.field).sort()).toEqual([
      'kind',
      'title',
    ]);
  });

  it('stops showing it once it is fixed', () => {
    const draft = { ...EMPTY_DRAFT, title: 'Hackathon scheduler' };

    expect(visibleProblems(draft, touching('title'))).toEqual([]);
  });

  it('reports a bad date only after the date is touched', () => {
    const draft = {
      ...EMPTY_DRAFT,
      kind: 'PROJECT' as const,
      title: 'Hackathon scheduler',
      date: 'Summer 2023',
    };

    expect(visibleProblems(draft, touching('title'))).toEqual([]);
    expect(visibleProblems(draft, touching('date'))).toEqual([
      { field: 'date', message: 'Use YYYY-MM or YYYY-MM-DD, or leave it blank.' },
    ]);
  });
});

describe('what is shown is a subset of what is wrong', () => {
  /*
   * Gating must only ever remove. A field that is touched and valid must
   * not acquire a message, and no message may appear that draftProblems
   * did not produce.
   */
  it('never invents a problem', () => {
    const draft: ManualEvidenceDraft = {
      kind: 'CASE_STUDY',
      title: 'Migrating the billing flow',
      description: 'Rewrote checkout.',
      date: '2025-03',
      role: 'Engineer',
      outcome: 'Fewer failed payments.',
      url: 'https://example.com/write-up',
    };

    const every = touching(
      'kind',
      'title',
      'description',
      'date',
      'role',
      'outcome',
      'url',
    );

    expect(draftProblems(draft)).toEqual([]);
    expect(visibleProblems(draft, every)).toEqual([]);
  });

  it('shows everything when everything has been touched', () => {
    const every = touching('kind', 'title', 'date', 'url');

    expect(visibleProblems(EMPTY_DRAFT, every)).toEqual(
      draftProblems(EMPTY_DRAFT),
    );
  });
});
