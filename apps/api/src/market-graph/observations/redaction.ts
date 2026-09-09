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
 *
 * Bumped to 2 by Phase 11, together with CONTENT_HASH_VERSION, when
 * credential-shaped URL parameters were added to what is removed. No
 * source in the corpus emits one, so the rule changes no existing byte -
 * but the hash commits to the RULE and not to its effect, so the bump is
 * what keeps that commitment true. The cost is stated rather than
 * discovered: the next walk of each source mints one new version per
 * posting at contentHashVersion 3, which is a labelled split and not a
 * phantom edit, and every version already stored keeps saying exactly what
 * it said.
 */
export const REDACTION_VERSION = 2;

/** Fixed sentinels. Never the empty string. */
const EMAIL_SENTINEL = '[redacted:email]';
const PHONE_SENTINEL = '[redacted:phone]';
/*
 * Substituted for a credential-shaped parameter's VALUE, leaving the
 * parameter itself in place. A removed parameter would make the URL look
 * like one that never carried a token; a blanked one says a token was
 * there and is gone, which is the difference between a redaction and a
 * quiet rewrite.
 */
const CREDENTIAL_SENTINEL = 'redacted';

/*
 * Query parameters whose VALUE is a credential.
 *
 * The same vocabulary the source registry already refuses in queryParams,
 * kept deliberately in step with it: those two lists disagreeing would
 * mean a key banned from one storage path was accepted on another.
 *
 * Matched on the whole parameter NAME, case-insensitively, with word
 * boundaries so `sig` does not swallow `design` and `key` does not swallow
 * `keyword` or `monkeypox`. Anchored rather than substring-matched because
 * a false positive here silently breaks a working apply link.
 */
const CREDENTIAL_PARAMETER =
  /^(?:[a-z0-9]+[_-])?(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|bearer|credential|signature|sig|sso|session|jwt)(?:[_-][a-z0-9]+)?$/i;

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

/**
 * A URL with the values of credential-shaped query parameters blanked.
 *
 * Phase 11. Nothing in the corpus needs it yet, and that is the point of
 * adding it before the source that will: a partner feed commonly hands out
 * per-employer apply links carrying a signed token, and the apply URL is
 * the one string this pipeline had DELIBERATELY exempted from redaction -
 * on the reasoning that a link to a page is not a way to reach a person.
 * That reasoning is still right about people and was never about secrets.
 *
 * Pure and total. Anything that is not a parseable absolute URL is
 * returned unchanged rather than mangled: a value that is not a URL cannot
 * have a query string, and guessing at one with a regex is how a
 * legitimate description gets shredded.
 *
 * Fragments are handled too, because an OAuth-style implicit token lives
 * after the `#` where a query parser will never look.
 */
export function redactUrlCredentials(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    /*
     * Not a URL. Deliberately returned untouched: this function's only job
     * is query parameters, and a relative path, a sentence or a fragment
     * of HTML has none.
     */
    return value;
  }

  let changed = false;

  /*
   * A snapshot of the keys, and the spread is load-bearing: the loop
   * MUTATES the same URLSearchParams it is walking, and a live iterator
   * over a collection being written to is undefined behaviour waiting to
   * be discovered by a URL with two credential parameters in it. The
   * linter reads this as a redundant copy; it is not.
   */
  const queryKeys = [...url.searchParams.keys()];

  for (const key of queryKeys) {
    if (CREDENTIAL_PARAMETER.test(key)) {
      url.searchParams.set(key, CREDENTIAL_SENTINEL);
      changed = true;
    }
  }

  if (url.hash.length > 1) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    let fragmentChanged = false;

    /* A snapshot, for the same reason as above: this loop writes. */
    const fragmentKeys = [...fragment.keys()];

    for (const key of fragmentKeys) {
      if (CREDENTIAL_PARAMETER.test(key)) {
        fragment.set(key, CREDENTIAL_SENTINEL);
        fragmentChanged = true;
      }
    }

    if (fragmentChanged) {
      url.hash = `#${fragment.toString()}`;
      changed = true;
    }
  }

  /*
   * The original string when nothing matched, not `url.toString()`.
   * Round-tripping through URL normalises percent-encoding, the default
   * port and a missing trailing slash - which would silently rewrite every
   * apply URL in the corpus and change every content hash for a reason
   * that has nothing to do with redaction.
   */
  return changed ? url.toString() : value;
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
    /*
     * Both, and in this order. A signed apply link can carry a recruiter's
     * address in one parameter and a token in another, and each pass is a
     * no-op on what the other removes.
     */
    return redactUrlCredentials(
      redactContactText(value, redaction) ?? value,
    );
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
     * The apply URL keeps its contact-pattern exemption and loses its
     * exemption from CREDENTIALS.
     *
     * The original reasoning still holds for people: it is a link to a
     * page, no address appears in any source's apply URLs, and running an
     * email pattern over a query string would mangle legitimate
     * parameters. It never held for secrets. A partner feed that hands out
     * per-employer apply links with a signed token in the query string
     * would otherwise write that token into a version row, a search
     * document and an API response - which is exactly the leak the
     * credential rules exist to prevent, arriving through the one field
     * nobody was scanning.
     */
    applyUrlRaw:
      record.applyUrlRaw === null
        ? null
        : redactUrlCredentials(record.applyUrlRaw),
    payload: redactPayload(record.payload, redaction),
  };
}
