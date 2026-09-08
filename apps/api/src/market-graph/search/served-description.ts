import {
  redactContactText,
  type ContactRedaction,
} from '../observations/redaction.js';

/*
 * The ONE place a posting body may leave the Market Graph.
 *
 * Phase 8 shipped the rule "serve no description text at all", enforced by
 * a string scan over the read service. That rule was right for Phase 8 -
 * nothing needed a body - and Phase 10 needs one, because a job the reader
 * cannot read is not a search result.
 *
 * So the rule is narrowed rather than deleted: a body may be served, only
 * from here, and only after redaction. The boundary test still forbids
 * every other file in the module from naming these columns, and adds a
 * second check that this file redacts everything it returns.
 *
 * WHY A SECOND REDACTION, when ingestion already redacts. Because the
 * first one demonstrably leaks, and Phase 10 found the leak rather than
 * assuming it away. Measured on the stored corpus:
 *
 *   MarketPostingVersion.descriptionRaw     0 email addresses, 0 phones
 *   MarketPostingNormalization.descriptionText (ruleset 4, 5 and 6)
 *                                           7 rows, 8 real mobile numbers
 *                                           belonging to named recruiters
 *
 * The cause is an ORDERING defect, and it is worth naming precisely
 * because it will recur. Redaction runs on the raw HTML, before entities
 * are decoded. A body containing
 *
 *     070&nbsp;290 51 16
 *
 * does not match the Swedish mobile pattern, whose separator class is
 * [-\s] and cannot see an entity. The raw column is therefore clean and
 * stays clean. The normalizer then decodes the entity to a space, and the
 * number reassembles in descriptionText - a column redaction had already
 * been run over, in a form redaction had never seen. Ruleset versions 1
 * to 3 are clean because the retrospective sanitizer ran after them; 4 to
 * 6 are Phase 9's re-normalization, which regenerated the text afterwards.
 *
 * That is fixed at the source - the CLI now sanitizes after normalizing,
 * so the window closes - but a read path that depends on an upstream job
 * having been run is a read path that leaks the day it was not. This is
 * the belt to that fix's braces, and it is cheap: a regex over a body that
 * is already being serialised into a response.
 *
 * WHAT IS STILL NOT ATTEMPTED: personal names in free text. "David Nyrén"
 * survives; his number does not. Name detection is non-deterministic and
 * locale-dependent, and a recogniser let loose on a job advert deletes the
 * employer and half the requirements. Stated as a residual, not solved.
 */

/**
 * The read-side profile.
 *
 * Both national forms, because a stored row no longer knows which
 * adapter shaped it. Over-removal is the direction to err in here: a
 * Swedish-shaped number in a Canadian posting costs a reader nothing,
 * and the reverse costs somebody their phone number.
 */
const SERVED_REDACTION: ContactRedaction = {
  /* Structured payload fields are irrelevant here; only bodies are served. */
  structuredFields: [],
  nationalPhone: /\b07[02369][-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b/,
};

/**
 * A description, safe to put in a response.
 *
 * Takes the stored text and returns the redacted form. There is
 * deliberately no way to call this and get the original back: the
 * function has one output, so a caller cannot accidentally serve the
 * wrong one of a pair.
 */
export function servedDescription(stored: string | null): string | null {
  const redacted = redactContactText(stored, SERVED_REDACTION);

  return redacted === null || redacted.trim() === '' ? null : redacted;
}
