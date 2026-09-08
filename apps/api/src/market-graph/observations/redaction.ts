/*
 * Contact details removed before anything is stored.
 *
 * The rule this file implements is "sanitize before persistence", and it
 * replaces the weaker one the phase shipped with: store everything, serve
 * nothing. That weaker rule is not a privacy control, it is a promise
 * about read paths - and it was already only as strong as a string scan of
 * a single file.
 *
 * The measurements that forced this, taken on the stored corpus:
 *   2320 of 6671 JobTech descriptions carried an email address
 *   1777 distinct addresses, 1484 of firstname.lastname@ shape
 *   777 Swedish mobile numbers
 *   639 rows carried an address in application_details.email, a field the
 *   adapter's own strip list missed - and 380 of those appear NOWHERE
 *   else, so every audit run against the description body was blind to
 *   them.
 *
 * Pure and locale-independent, like everything else under observations/.
 * No Intl, no toLocale*, no clock, no randomness: a redaction that behaved
 * differently on two machines would make the content hash machine-local.
 *
 * WHAT IS NOT ATTEMPTED: personal names in free text. Name detection is
 * non-deterministic and locale-dependent, and a name recogniser let loose
 * on a job advert removes the employer, the product and half the
 * requirements. Names in bodies are a stated residual, not a solved
 * problem.
 */

/**
 * The version of these rules.
 *
 * Read the same way as RULESET_VERSION: this file IS the version, and
 * changing what it removes means bumping it. It is folded into the content
 * hash preimage, so a change lands as a labelled split - old rows keep
 * their old contentHashVersion - rather than as a phantom edit to every
 * posting ever ingested.
 */
export const REDACTION_VERSION = 1;

/** Fixed sentinels. Never the empty string. */
const EMAIL_SENTINEL = '[redacted:email]';
const PHONE_SENTINEL = '[redacted:phone]';

/*
 * An email address, deliberately narrower than RFC 5322.
 *
 * Anchored on a dot-separated TLD of at least two letters so that version
 * strings and namespaced identifiers ("react@18.2.0", "user@host") are not
 * mistaken for addresses and quietly deleted from a job description.
 */
const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const MAILTO = /mailto:[^\s"'<>)\]]+/gi;

/*
 * An international number: a leading + and 8 to 15 digits, separators
 * allowed between them.
 *
 * The + is required. A bare run of digits is not a phone number - it is a
 * postcode, a salary, a headcount or a year, and a generic digit pattern
 * over this corpus produced 1085 matches against 777 real numbers. A
 * national trunk form has to be declared by the adapter that knows the
 * market it is reading.
 */
const INTERNATIONAL_PHONE = /\+\d(?:[\d\s().-]{6,18}\d)/g;

/**
 * What one source needs removed, declared by its adapter.
 *
 * The shared patterns above are universal and the pipeline applies them
 * whatever the adapter says, so an adapter cannot forget them. This is
 * only the part that needs source knowledge.
 */
export type ContactRedaction = {
  /**
   * Dotted paths into the raw payload whose values are contact details,
   * removed entirely. JobTech's `application_details.email` was missing
   * from its adapter's list and accounts for 380 versions carrying an
   * address found in no other column.
   */
  readonly structuredFields: readonly string[];
  /**
   * National phone shapes for this source's market, if any. Source-shaped
   * knowledge, so it is declared where the rest of it lives.
   *
   * Must not be global: a /g regex carries lastIndex between calls, which
   * would make the redaction depend on how many times it had run.
   */
  readonly nationalPhone: RegExp | null;
};

function applyGlobal(text: string, pattern: RegExp, sentinel: string): string {
  /* A fresh regex each time, so no lastIndex survives a call. */
  return text.replace(new RegExp(pattern.source, pattern.flags), sentinel);
}

/**
 * Contact details out of a free-text body.
 *
 * mailto: first, so that the address inside it is not replaced separately
 * and left as `mailto:[redacted:email]` - which still says "write to
 * somebody" and reads like a bug.
 */
export function redactContactText(
  text: string | null,
  redaction: ContactRedaction,
): string | null {
  if (text === null) {
    return null;
  }

  let out = applyGlobal(text, MAILTO, EMAIL_SENTINEL);

  out = applyGlobal(out, EMAIL, EMAIL_SENTINEL);
  out = applyGlobal(out, INTERNATIONAL_PHONE, PHONE_SENTINEL);

  if (redaction.nationalPhone !== null) {
    out = out.replace(
      new RegExp(redaction.nationalPhone.source, 'g'),
      PHONE_SENTINEL,
    );
  }

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes one dotted path, if every segment before the last is an object. */
function deletePath(payload: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  const last = segments.pop();

  if (last === undefined) {
    return;
  }

  let cursor: Record<string, unknown> = payload;

  for (const segment of segments) {
    const next = cursor[segment];

    if (!isPlainObject(next)) {
      return;
    }

    /* Copied, so the adapter's input object is never mutated. */
    const copy = { ...next };

    cursor[segment] = copy;
    cursor = copy;
  }

  delete cursor[last];
}

/**
 * The declared contact fields removed, then the universal patterns applied
 * to every remaining string in the payload.
 *
 * The second half is what makes this a control rather than a checklist: a
 * source that moves a recruiter's address into a field nobody listed still
 * has it removed, and the only cost is that a legitimate address in an
 * unexpected field is removed too - which is the direction to err in.
 */
export function redactPayload(
  payload: Record<string, unknown>,
  redaction: ContactRedaction,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...payload };

  for (const path of redaction.structuredFields) {
    deletePath(copy, path);
  }

  return scrubStrings(copy, redaction) as Record<string, unknown>;
}

function scrubStrings(value: unknown, redaction: ContactRedaction): unknown {
  if (typeof value === 'string') {
    return redactContactText(value, redaction);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubStrings(entry, redaction));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};

    /*
     * Keys in their existing order. canonicalJson sorts keys before
     * hashing, so this cannot reach a hash - but preserving order keeps a
     * stored payload readable against the source's own response.
     */
    for (const [key, entry] of Object.entries(value)) {
      out[key] = scrubStrings(entry, redaction);
    }

    return out;
  }

  return value;
}

/**
 * One parsed record, with contact details removed from every field that
 * can carry them.
 *
 * Applied by the ingestion pipeline to every accepted record, whatever its
 * adapter did - so redaction is a property of the pipeline rather than a
 * habit each adapter has to remember. Idempotent: the sentinels contain no
 * address and no number, so redacting twice is redacting once, which is
 * what lets an adapter also apply it without the result depending on how
 * many times it ran.
 */
export function redactRecord<
  T extends {
    titleRaw: string;
    companyRaw: string | null;
    locationRaw: string | null;
    descriptionRaw: string | null;
    applyUrlRaw: string | null;
    payload: Record<string, unknown>;
  },
>(record: T, redaction: ContactRedaction): T {
  return {
    ...record,
    titleRaw: redactContactText(record.titleRaw, redaction) ?? record.titleRaw,
    companyRaw: redactContactText(record.companyRaw, redaction),
    locationRaw: redactContactText(record.locationRaw, redaction),
    descriptionRaw: redactContactText(record.descriptionRaw, redaction),
    /*
     * The apply URL is left alone. It is a link to a page, not a way to
     * reach a person - no address appears in either source's apply URLs -
     * and running an email pattern over a query string would mangle
     * legitimate parameters.
     */
    applyUrlRaw: record.applyUrlRaw,
    payload: redactPayload(record.payload, redaction),
  };
}
