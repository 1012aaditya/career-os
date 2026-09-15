/*
 * Evidence a person adds themselves.
 *
 * WHY THIS EXISTS AT ALL. Career OS is not for engineers with busy GitHub
 * accounts. A fresher has a college project and a hackathon; a designer
 * has a case study and a prototype; a founder has a deck and a launch.
 * None of that lives behind an API, and a product whose evidence layer
 * only understands APIs is a product that tells most people they have no
 * career.
 *
 * WHAT IT DOES NOT DO. There is no endpoint for this. `POST /v1/evidence`
 * does not exist, and inventing a path for it would produce a form that
 * appears to save and does not - the single worst outcome for a screen
 * whose subject is trust. So this module models the form and its
 * validation, and `submissionState()` reports plainly that the path is not
 * connected. The UI must show that BEFORE the user types, not after.
 */

export type ManualEvidenceKind =
  | 'PROJECT'
  | 'ACHIEVEMENT'
  | 'WORK_ARTIFACT'
  | 'CERTIFICATION'
  | 'PUBLICATION'
  | 'CASE_STUDY'
  | 'OTHER';

export const MANUAL_EVIDENCE_KINDS: {
  value: ManualEvidenceKind;
  label: string;
  hint: string;
}[] = [
  {
    value: 'PROJECT',
    label: 'Project',
    hint: 'Something you built, alone or with others.',
  },
  {
    value: 'ACHIEVEMENT',
    label: 'Achievement',
    hint: 'A result, award or milestone.',
  },
  {
    value: 'WORK_ARTIFACT',
    label: 'Work artifact',
    hint: 'A document, deck, design or report you produced.',
  },
  {
    value: 'CERTIFICATION',
    label: 'Certification',
    hint: 'A course or credential you completed.',
  },
  {
    value: 'PUBLICATION',
    label: 'Publication',
    hint: 'Something you wrote and published.',
  },
  {
    value: 'CASE_STUDY',
    label: 'Case study',
    hint: 'A worked account of a problem you solved.',
  },
  {
    value: 'OTHER',
    label: 'Other',
    hint: 'Anything else that shows your work.',
  },
];

export type ManualEvidenceDraft = {
  kind: ManualEvidenceKind | null;
  title: string;
  description: string;
  date: string;
  role: string;
  outcome: string;
  url: string;
};

export const EMPTY_DRAFT: ManualEvidenceDraft = {
  kind: null,
  title: '',
  description: '',
  date: '',
  role: '',
  outcome: '',
  url: '',
};

export type DraftProblem = {
  field: keyof ManualEvidenceDraft;
  message: string;
};

/** YYYY-MM or YYYY-MM-DD. Deliberately narrow - see below. */
const DATE_SHAPE = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * What is wrong with the draft, if anything.
 *
 * The date rule is the interesting one. Free text is refused rather than
 * parsed, because the API layer already learned this lesson: `new Date()`
 * turns "Summer 2023" into 1 January 2023, and the graph then shows a date
 * the person never wrote. Refusing is honest; guessing is a fabrication
 * with a plausible face.
 */
export function draftProblems(
  draft: ManualEvidenceDraft,
): DraftProblem[] {
  const problems: DraftProblem[] = [];

  if (draft.kind === null) {
    problems.push({
      field: 'kind',
      message: 'Choose what kind of evidence this is.',
    });
  }

  if (draft.title.trim() === '') {
    problems.push({
      field: 'title',
      message: 'Give this a title.',
    });
  }

  if (draft.date.trim() !== '' && !DATE_SHAPE.test(draft.date.trim())) {
    problems.push({
      field: 'date',
      message: 'Use YYYY-MM or YYYY-MM-DD, or leave it blank.',
    });
  }

  const url = draft.url.trim();

  if (url !== '' && !/^https?:\/\/\S+$/i.test(url)) {
    problems.push({
      field: 'url',
      message: 'Links must start with http:// or https://.',
    });
  }

  return problems;
}

export function isSubmittable(draft: ManualEvidenceDraft): boolean {
  return draftProblems(draft).length === 0;
}

/**
 * The problems worth SHOWING, as opposed to the problems that exist.
 *
 * An untouched draft is empty, so `draftProblems` rightly reports a
 * missing kind and a missing title - and the screen rendered both in red
 * the instant it opened, telling a person they had done something wrong
 * before they had done anything at all. On a screen about trust that
 * reads as an accusation.
 *
 * Deliberately separate from `draftProblems` rather than folded into it:
 * `isSubmittable` must keep seeing every problem, so the save control
 * stays disabled on a pristine form. Hiding a message must never make the
 * form look submittable.
 */
export function visibleProblems(
  draft: ManualEvidenceDraft,
  touched: ReadonlySet<keyof ManualEvidenceDraft>,
): DraftProblem[] {
  return draftProblems(draft).filter((problem) => touched.has(problem.field));
}

export type SubmissionState = {
  available: boolean;
  /** Shown before the user invests effort, not after. */
  notice: string;
};

/**
 * Whether this can be saved. It cannot.
 *
 * A single source of truth for the whole screen, so the disabled button,
 * the banner and any future enabling all move together - rather than a
 * banner somebody forgets to delete on the day the endpoint ships.
 */
export function submissionState(): SubmissionState {
  return {
    available: false,
    notice:
      'Saving your own evidence is not available yet. You can see what it will capture, but nothing on this screen is stored.',
  };
}

/**
 * How manual evidence would be classified, once it can be saved.
 *
 * Shown on the form so the trade-off is visible while the user decides
 * whether to bother: evidence you provide yourself is real, and it is not
 * the same as evidence a source confirmed. Values match what the API's
 * contract would give it - a user-provided artifact, asserted by the user.
 */
export const MANUAL_EVIDENCE_DISCLOSURE = {
  provenance: 'Provided by you',
  detail:
    'Evidence you add is recorded as your own account of your work. It is not independently checked, and it is shown differently from evidence a source confirmed.',
};
