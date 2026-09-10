import type { EvidenceRecord, TrustClass } from './contract.js';
import { classifyRecord, classify, corroborationOf } from './trust.js';

/*
 * Turning evidence into statements, and refusing to turn it into verdicts.
 *
 * This is the transition the whole Evidence layer exists to police:
 *
 *   NORMALIZED EVIDENCE  ->  CAREER SIGNAL  ->  CLAIM
 *
 * The first arrow is this file. The second is not, and must not become
 * this file: a signal says what was observed and what that observation
 * cannot reach, and stops. Nothing here decides what a person IS.
 *
 * HOW THE FORBIDDEN INFERENCES ARE MADE UNREACHABLE, rather than merely
 * avoided. Three structural properties, in order of how much they carry:
 *
 *   1. The vocabulary is a CLOSED UNION. There is no free-text path out
 *      of this module - a signal kind that does not exist cannot be
 *      returned, and adding one requires editing the union here, where it
 *      is reviewed.
 *
 *   2. Every sentence comes from a FROZEN TABLE, looked up by kind. None
 *      is assembled by concatenation or interpolation, so no input can
 *      influence the words. A test enumerates the entire table and
 *      asserts that no `supports` line contains the vocabulary of
 *      seniority, expertise or leadership - which is exhaustive precisely
 *      because the table is the only source of those strings.
 *
 *   3. `doesNotEstablish` is part of the type and every entry in the
 *      table is non-empty, so a signal without stated limits does not
 *      typecheck and does not exist.
 *
 * WHAT IS DELIBERATELY NOT HERE. No model, no interpretation layer, no
 * scoring. A generic LLM step at this seam would defeat all three
 * properties above at once, because its output is by construction not
 * drawn from a closed vocabulary.
 */

/**
 * Everything this module is allowed to say.
 *
 * Small on purpose. Each kind is a statement about what was OBSERVED or
 * about the state of our own records - never about the person.
 */
export type SignalKind =
  /*
   * The negative-evidence guard, and the most important member.
   *
   * Emitted when there is nothing admissible to reason from. It is a
   * statement about OUR records, and it exists so that the absence of
   * evidence has somewhere to go that is not a claim about the person.
   * Without it, "no signals" would be rendered by some consumer as a gap
   * in a career rather than a gap in our coverage.
   */
  | 'INSUFFICIENT_EVIDENCE'
  /* A source the user authenticated with attributed activity to them. */
  | 'OBSERVED_VIA_AUTHENTICATED_ACCOUNT'
  /* Something identifiable exists and can be looked at by someone else. */
  | 'ARTIFACT_EXISTS'
  /* The user said so. Recorded as what it is, neither hidden nor promoted. */
  | 'SELF_REPORTED_CLAIM'
  /* More than one independent source, counted by key and never by row. */
  | 'INDEPENDENTLY_CORROBORATED';

export type Signal = {
  kind: SignalKind;
  /** One bounded sentence. Drawn from the frozen table, never built. */
  supports: string;
  /** Always non-empty, and specific to this inference rather than boilerplate. */
  doesNotEstablish: string[];
  /**
   * The observable facts the signal rests on, so a reader can check it.
   *
   * `trustClass` is carried through from trust.ts and is NEVER re-read as
   * ability. VERY_STRONG means the evidence is reliable; it does not mean
   * the person is good. That shortcut - reliability standing in for
   * competence - is the single most tempting error available here.
   */
  basis: {
    trustClass: TrustClass;
    independentSources: number;
    admissibleRecords: number;
    sourceTypes: string[];
  };
};

/*
 * The complete vocabulary. Every string this module can emit is below.
 *
 * The limitations are written per-kind rather than shared, because
 * boilerplate limitations are how a disclaimer stops being read: what a
 * repository observation cannot establish is not what a self-reported
 * claim cannot establish, and saying so precisely is the only version
 * that helps anybody.
 */
const VOCABULARY: Record<
  SignalKind,
  { supports: string; doesNotEstablish: readonly string[] }
> = {
  INSUFFICIENT_EVIDENCE: {
    supports:
      'Career OS holds no admissible evidence for this from the sources it has observed.',
    doesNotEstablish: [
      'that the person lacks this skill or experience',
      'that no such work exists',
      'that a source we have not connected would show nothing',
      'that a source we could not fully read contains nothing',
    ],
  },
  OBSERVED_VIA_AUTHENTICATED_ACCOUNT: {
    supports:
      'A source the person authenticated with attributed this activity to their account.',
    doesNotEstablish: [
      'seniority or career level',
      'expertise or level of skill',
      'leadership or ownership of the work',
      'how much of the work was theirs rather than a collaborator’s',
      'the quality or impact of the work',
    ],
  },
  ARTIFACT_EXISTS: {
    supports:
      'An identifiable artifact exists at the source and can be inspected independently.',
    doesNotEstablish: [
      'authorship of everything the artifact contains',
      'expertise in what the artifact uses',
      'that the artifact was used in production or by anyone else',
      'the effort or time the artifact represents',
    ],
  },
  SELF_REPORTED_CLAIM: {
    supports: 'The person stated this themselves.',
    doesNotEstablish: [
      'independent verification of the statement',
      'corroboration by any external source',
      'that the activity is current rather than historical',
      'anything beyond the fact that the statement was made',
    ],
  },
  INDEPENDENTLY_CORROBORATED: {
    supports:
      'More than one independent source describes this.',
    doesNotEstablish: [
      'expertise, seniority or leadership',
      'that the sources are exhaustive or representative',
      'that the sources agree on details beyond the fact observed',
      'that further sources would agree',
    ],
  },
};

/**
 * Fixed emission order, so output does not depend on input order.
 *
 * INSUFFICIENT_EVIDENCE is first because when it appears it is alone.
 */
const ORDER: readonly SignalKind[] = [
  'INSUFFICIENT_EVIDENCE',
  'OBSERVED_VIA_AUTHENTICATED_ACCOUNT',
  'ARTIFACT_EXISTS',
  'SELF_REPORTED_CLAIM',
  'INDEPENDENTLY_CORROBORATED',
];

function signalOf(
  kind: SignalKind,
  basis: Signal['basis'],
): Signal {
  const entry = VOCABULARY[kind];

  return {
    kind,
    supports: entry.supports,
    /* Copied, so a caller cannot edit the shared table through a signal. */
    doesNotEstablish: [...entry.doesNotEstablish],
    basis,
  };
}

/**
 * The bounded signals a set of evidence supports.
 *
 * Pure. Reads its arguments, writes nothing, touches no database, no
 * Career Graph row and no UserSkill. It does not mutate the records it is
 * given.
 *
 * `now` is a parameter for the same reason it is in trust.ts: staleness
 * decides admissibility, and a boundary that reads a hidden clock cannot
 * be tested at the boundary.
 */
export function deriveSignals(
  records: readonly EvidenceRecord[],
  now: Date | number,
): Signal[] {
  /*
   * Admissible means "survived the trust gates" - not "is strong".
   * A weak self-reported claim is admissible; a name-similarity match and
   * a repository we never scanned are not, and neither may contribute a
   * signal or a corroborating source.
   */
  const admissible = records.filter(
    (record) => classifyRecord(record, now) !== 'UNVERIFIED',
  );

  const corroboration = corroborationOf(records, now);

  const basis: Signal['basis'] = {
    trustClass: classify(records, now),
    independentSources: corroboration.independentSources,
    admissibleRecords: admissible.length,
    sourceTypes: [
      ...new Set(admissible.map((record) => record.sourceType)),
    ].sort(),
  };

  /*
   * Nothing admissible. Exactly one signal, and it is a statement about
   * our own coverage.
   *
   * This is where "no evidence is not evidence of absence" is enforced
   * rather than asserted: there is no branch here that can produce a
   * signal about the person, so absence cannot be rendered as a negative
   * capability claim by any consumer that reads what we return.
   */
  if (admissible.length === 0) {
    return [signalOf('INSUFFICIENT_EVIDENCE', basis)];
  }

  const present = new Set<SignalKind>();

  for (const record of admissible) {
    if (
      record.authenticity === 'DIRECT_API_OBSERVATION' &&
      record.attribution === 'AUTHENTICATED_ACCOUNT'
    ) {
      present.add('OBSERVED_VIA_AUTHENTICATED_ACCOUNT');
    }

    const identifiable =
      (record.externalId !== null && record.externalId !== '') ||
      (record.sourceUrl !== null && record.sourceUrl !== '');

    if (identifiable) {
      present.add('ARTIFACT_EXISTS');
    }

    if (
      record.authenticity === 'USER_CLAIM' ||
      record.attribution === 'USER_ASSERTED'
    ) {
      present.add('SELF_REPORTED_CLAIM');
    }
  }

  /*
   * Independence is counted by DISTINCT KEY, in trust.ts, and never by
   * row. Fourteen repositories from one account are one source: without
   * this the most common shape in the system - a single busy GitHub
   * account - would announce itself as fourteen agreeing witnesses.
   */
  if (corroboration.independentSources >= 2) {
    present.add('INDEPENDENTLY_CORROBORATED');
  }

  return ORDER.filter((kind) => present.has(kind)).map((kind) =>
    signalOf(kind, basis),
  );
}

/** The complete vocabulary, exported so a test can enumerate all of it. */
export const SIGNAL_VOCABULARY = VOCABULARY;
