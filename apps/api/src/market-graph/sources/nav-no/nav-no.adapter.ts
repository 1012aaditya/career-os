import type { ContactRedaction } from '../../observations/redaction.js';
import { optionalInstant, optionalString } from '../../observations/values.js';
import type {
  AdapterParseResult,
  IdentityBasis,
  RawPostingRecord,
  RejectedRecord,
  SourceAdapter,
} from '../source-adapter.js';

/*
 * NAV / Arbeidsplassen (Norway) -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified live on 2026-09-08. NAV's API terms name this use in words no
 * other source matched: consumers have the right to republish received job
 * ads "og/eller bruke dei til statistiske/analytiske formal" - and/or use
 * them for statistical or analytical purposes. Free, and open to anyone.
 *
 * A LICENCE TRAP WORTH RECORDING. NAV's OpenAPI document declares
 * "license": { "name": "MIT License" }. That is the licence of NAV's own
 * SOURCE CODE, not of the data. Reading a licence out of an API envelope
 * is exactly how JobTech's CC0 grant was found, so this is the shape of
 * evidence most likely to be trusted here - and here it would have been
 * wrong. The governing terms are the separate termsOfService URL.
 *
 * The slug is `nav-no`, not `nav`. Three letters is too short to be a
 * source slug here: the boundary scan that forbids naming a source inside
 * a canonical module matches substrings deliberately - so that
 * `greenhouseAdapter` is caught and not just `greenhouse` - and `nav` is
 * a substring of UNAVAILABLE, which freshness.ts uses. Relaxing the scan
 * to word boundaries would have made it miss the real violations it
 * exists to catch, so the slug changed instead.
 *
 * What it adds to the contract's coverage: the first source needing a
 * CREDENTIAL. Nothing had exercised that path, and it is the one the
 * security review named as the highest risk for a new source, because the
 * obvious place to put a key - the descriptor's queryParams - is stored
 * verbatim on every run and hashed into a fingerprint the API serves.
 */

const SOURCE_SLUG = 'nav-no';

const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export class NavAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /* A uuid assigned by the source and resolvable at its own detail URL. */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /*
   * The feed's list view carries no contact block - but the DETAIL
   * endpoint does, and it is populated with named individuals:
   * contactList[] holds name, email, phone and title. This adapter does
   * not read that endpoint, and if it ever does, contactList goes here.
   * Recorded now, while the reason is in front of whoever adds it.
   */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: ['contactList'],
    /* Norwegian mobile numbers: 8 digits starting 4 or 9. */
    nationalPhone: /\b[49]\d{2}[\s.]?\d{2}[\s.]?\d{3}\b/,
  };

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);

    if (envelope === null || !Array.isArray(envelope.items)) {
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.items.forEach((entry: unknown, index: number) => {
      const item = asRecord(entry);

      if (item === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const feedEntry = asRecord(item._feed_entry);

      /*
       * A delisted advert. NAV's terms require that ads be removed from a
       * consumer's results "straks" - immediately - once inactive, and the
       * contract has no way to express a delisting. So they are refused
       * and counted rather than stored as live postings. Recording the
       * delisting itself, which would give true posting lifespans, remains
       * unbuilt and is named in the phase's residuals.
       */
      if (
        feedEntry !== null &&
        optionalString(feedEntry.status) !== null &&
        feedEntry.status !== 'ACTIVE'
      ) {
        rejected.push({ index, reason: 'removed_posting' });
        return;
      }

      const externalKey =
        optionalString(feedEntry?.uuid) ?? optionalString(item.id);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw =
        optionalString(item.title) ?? optionalString(feedEntry?.title);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        companyRaw: optionalString(feedEntry?.businessName),
        locationRaw: optionalString(feedEntry?.municipal),
        /*
         * ABSENT, and deliberately so.
         *
         * The feed's `content_text` is not a description: on every record
         * sampled it is the literal string "Stillingsannonse" - Norwegian
         * for "job advertisement" - a 16-character placeholder. Storing it
         * as a body would give the pipeline something to extract skills
         * from that says nothing, and would report descriptionCompleteness
         * FULL for a posting whose requirements we have never seen.
         *
         * The real advert text, and the ESCO occupation URIs that would
         * make Norwegian titles resolvable without a Norwegian vocabulary,
         * live behind a per-posting detail endpoint. Fetching it would be
         * one request per posting against a public service, which is not a
         * cost this pipeline should impose. Recorded as a coverage
         * limitation: this source contributes to volume and to no
         * prevalence denominator.
         */
        descriptionRaw: null,
        descriptionCompleteness: 'ABSENT',
        /* ISO 8601 with an offset and microsecond precision. */
        sourcePublishedAt: optionalInstant(item.date_modified),
        sourceUpdatedAt: optionalInstant(feedEntry?.sistEndret),
        /*
         * The list view publishes no expiry. The detail endpoint has one;
         * see the note above about why it is not read.
         */
        sourceValidThrough: null,
        applyUrlRaw: null,
        sourceCategoriesRaw: [],
        occupationScheme: null,
        externalGroupKey: null,
        payload: item,
      });
    });

    return { accepted, rejected };
  }
}
