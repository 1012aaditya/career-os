/*
 * Whether a source may be walked at all, and why not when it may not.
 *
 * Phase 11. Pure - no clock, no network, no database, no configuration.
 * Everything it decides, it decides from values handed to it, which is
 * what lets the failure modes be tested without a source that has any of
 * them.
 *
 * WHAT THIS EXISTS TO FIX, stated plainly because it was live rather than
 * hypothetical. Phase 8 gated ingestion on one boolean, `MarketSource
 * .isEnabled`, written once by ensureSource's CREATE and never updated
 * (its UPDATE block is empty on purpose, so an operator's tuning survives
 * a deploy). Two descriptors later changed their minds and set
 * `isEnabled: false` - Greenhouse on licence grounds, NAV on ours - and
 * neither row changed, because rows are not created twice. So this
 * database held `greenhouse.isEnabled = true` while the code that is the
 * source of truth for that decision said false, and `sync greenhouse`
 * would have walked it.
 *
 * The fix is not a third boolean. It is to make the gate read BOTH the
 * declaration in code and the state in the row, and refuse when they
 * disagree - because a disagreement means one of them is lying and there
 * is no safe way to guess which.
 */

/**
 * What kind of relationship gives us a source's data.
 *
 * Mirrors the MarketSourceCategory enum. About the RELATIONSHIP and never
 * about the employer: a Google vacancy arriving through an ATS is an ATS
 * posting, and there is deliberately no value that could ever be one
 * company's name.
 */
export type SourceCategory =
  | 'PUBLIC_OPEN_DATA'
  | 'DIRECT_EMPLOYER'
  | 'ATS'
  | 'LICENSED_AGGREGATOR'
  | 'PARTNER_FEED';

/** Mirrors the MarketSourceAccessState enum, in lifecycle order. */
export type SourceAccessState =
  | 'DISCOVERED'
  | 'ACCESS_REQUESTED'
  | 'ACCESS_GRANTED'
  | 'CREDENTIALS_REQUIRED'
  | 'CREDENTIALS_CONFIGURED'
  | 'LEGAL_REVIEW'
  | 'BLOCKED_EXTERNAL_ACCESS'
  | 'ENABLED'
  | 'DISABLED'
  | 'REJECTED'
  | 'EXPIRED';

/**
 * The one state a source may be ingested from.
 *
 * A single-element set rather than a predicate, so "which states permit
 * ingestion" is a value a test can print rather than a branch a reader has
 * to simulate. Adding a second member is the kind of edit that should look
 * alarming in a diff.
 */
export const INGESTIBLE_ACCESS_STATES: readonly SourceAccessState[] = [
  'ENABLED',
];

/**
 * Whether a state is a settled position rather than a step on the way.
 *
 * Used only by the health report, to say "waiting" and "finished" as
 * different sentences. BLOCKED_EXTERNAL_ACCESS is terminal here and that
 * is the point of it: the adapter is done, the door is shut, and nothing
 * further will happen without somebody outside this repository acting.
 */
export const TERMINAL_ACCESS_STATES: readonly SourceAccessState[] = [
  'BLOCKED_EXTERNAL_ACCESS',
  'ENABLED',
  'DISABLED',
  'REJECTED',
  'EXPIRED',
];

/**
 * Whether the state itself says a credential is outstanding.
 *
 * Distinct from the RESOLVED credential state below, which is a fact about
 * the running process's configuration. One is a claim about the
 * relationship, the other about this machine, and conflating them is how
 * "we never asked for a key" becomes indistinguishable from "the key is
 * not deployed here".
 */
export function accessStateAwaitsCredentials(
  state: SourceAccessState,
): boolean {
  return state === 'CREDENTIALS_REQUIRED';
}

/**
 * What the running process can say about a source's credentials.
 *
 * Carries key NAMES and never values. `missingKeys` is deliberately part
 * of the type: a source that fails for want of a credential must be able
 * to say which one without anybody reading the environment by hand, and a
 * name is not a secret.
 */
export type CredentialState =
  /** This source needs none. Not the same as "we have none". */
  | { readonly kind: 'NOT_REQUIRED' }
  /** Every declared key resolved to a non-empty value. Says nothing at
   * all about whether the provider will accept them. */
  | { readonly kind: 'CONFIGURED' }
  | { readonly kind: 'MISSING'; readonly missingKeys: readonly string[] };

/**
 * A short, stable code. Never free text, never a caught error.
 *
 * These reach the ingestion run ledger, so they are chosen the way every
 * other stored reason code in this pipeline is: fixed vocabulary, safe to
 * put in a database, safe to put in a log line.
 */
export type IngestRefusalReason =
  /** The declaration in code does not permit ingestion. */
  | 'access_not_enabled'
  /** The stored row does not permit ingestion. */
  | 'source_disabled'
  /**
   * Code and row disagree about the access state.
   *
   * Refused rather than resolved in either direction. Taking the row would
   * let a hand-edit override a reviewed decision; taking the code would
   * silently overwrite an operator's deliberate switch-off. Neither is a
   * thing to do quietly.
   */
  | 'access_state_disagreement'
  /**
   * A declared credential is absent from configuration.
   *
   * Its own code, because "we could not authenticate" and "the provider is
   * down" are different operational facts and a single failure bucket
   * would send somebody to check the wrong thing.
   */
  | 'credentials_missing';

export type IngestGateVerdict =
  | { readonly permitted: true }
  | {
      readonly permitted: false;
      readonly reason: IngestRefusalReason;
      /** Safe to store and to log: names and enum values only. */
      readonly detail: string;
    };

/**
 * May this source be walked?
 *
 * FAILS CLOSED at every branch. There is no path through this function
 * that permits ingestion by default, by omission, or because a value was
 * unrecognised: `permitted: true` is returned from exactly one place, at
 * the end, once every check has been passed.
 */
export function evaluateIngestGate(input: {
  /** The state the registry declares, in code, under review. */
  readonly declared: SourceAccessState;
  /** The state stored on the row. */
  readonly stored: SourceAccessState;
  readonly storedIsEnabled: boolean;
  readonly credentials: CredentialState;
}): IngestGateVerdict {
  if (!INGESTIBLE_ACCESS_STATES.includes(input.declared)) {
    return {
      permitted: false,
      reason: 'access_not_enabled',
      detail: `declared access state is ${input.declared}`,
    };
  }

  if (input.declared !== input.stored) {
    return {
      permitted: false,
      reason: 'access_state_disagreement',
      detail: `code declares ${input.declared}, row records ${input.stored}`,
    };
  }

  if (!input.storedIsEnabled) {
    return {
      permitted: false,
      reason: 'source_disabled',
      detail: 'the source row is not enabled',
    };
  }

  if (input.credentials.kind === 'MISSING') {
    return {
      permitted: false,
      reason: 'credentials_missing',
      /*
       * Key NAMES, sorted. The values are never read here and the type
       * does not carry them, so there is nothing in this string to leak.
       */
      detail: `missing configuration: ${[...input.credentials.missingKeys].sort().join(', ')}`,
    };
  }

  return { permitted: true };
}

/**
 * Is this declaration internally consistent?
 *
 * Separate from the gate because it is a check on the REGISTRY rather than
 * on a run: it answers "could this source ever be ingested as declared",
 * and the answer is asserted by a test at build time rather than
 * discovered at 3am by an operator. The rules are the ones Phase 8
 * established and Phase 11 extends:
 *
 *   ENABLED requires an affirmative licence. An unresolved licence that
 *   ingests anyway is an unresolved licence being ignored.
 *
 *   isEnabled and ENABLED are the same claim, so they move together.
 *
 *   Redistribution requires an affirmative licence, which was already
 *   true and is restated here so one function answers the whole question.
 */
export function declarationProblems(source: {
  readonly slug: string;
  readonly accessState: SourceAccessState;
  readonly isEnabled: boolean;
  readonly mayRedistributeDerived: boolean;
  readonly licenceBasis: 'UNADDRESSED_PUBLIC_ENDPOINT' | 'EXPLICIT_GRANT' | 'CONTRACTED';
  readonly attribution: string | null;
}): string[] {
  const problems: string[] = [];
  const enabled = source.accessState === 'ENABLED';

  if (enabled !== source.isEnabled) {
    problems.push(
      `${source.slug}: accessState ${source.accessState} and isEnabled ${source.isEnabled} disagree`,
    );
  }

  if (enabled && source.licenceBasis === 'UNADDRESSED_PUBLIC_ENDPOINT') {
    problems.push(
      `${source.slug}: ENABLED with an unresolved licence position`,
    );
  }

  if (
    source.mayRedistributeDerived &&
    source.licenceBasis === 'UNADDRESSED_PUBLIC_ENDPOINT'
  ) {
    problems.push(
      `${source.slug}: redistributes derived data with an unresolved licence position`,
    );
  }

  /*
   * An empty attribution string is worse than none: it reads as "no credit
   * required" everywhere it is checked for truthiness, while looking
   * present to anything checking for null.
   */
  if (source.attribution !== null && source.attribution.trim() === '') {
    problems.push(`${source.slug}: attribution is an empty string`);
  }

  return problems;
}
