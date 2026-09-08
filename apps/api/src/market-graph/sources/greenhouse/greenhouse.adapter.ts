import {
  numericKey,
  optionalInstant,
  optionalString,
} from '../../observations/values.js';
import type {
  AdapterParseResult,
  IdentityBasis,
  RawPostingRecord,
  RejectedRecord,
  SourceAdapter,
} from '../source-adapter.js';

/*
 * Greenhouse Job Board API -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified against the live API on 2026-09-08 for the boards `vercel`,
 * `stripe` and `figma` (864 postings). Everything asserted below about the
 * payload was read off those responses rather than off documentation.
 *
 * Two properties of the real payload shape this file:
 *
 *   The key set DIFFERS BETWEEN BOARDS. `stripe` and `figma` return
 *   `education`; `vercel` does not. So nothing here may assume a fixed
 *   shape, and every field is read defensively even when it was present in
 *   every posting sampled.
 *
 *   `content` is entity-escaped HTML - it arrives literally as
 *   `&lt;div class=&quot;...`. It is stored VERBATIM here and unescaped in
 *   normalization, which is versioned. Cleaning it at this layer would
 *   bake one cleaning strategy into the permanent record.
 */

const SOURCE_SLUG = 'greenhouse';

/** Bumped when this adapter would parse the same payload differently. */
const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/*
 * Department names, ordered by Greenhouse's department id.
 *
 * The array order Greenhouse returns is not promised, so it is replaced
 * with an order of our own - otherwise a reshuffled response would change
 * this list, change the content hash, and mint a new version for every
 * affected posting without any posting having changed.
 *
 * Kept as a list rather than flattened to one label, because the source
 * genuinely has several. These are NOT roles: "Engineering" is far coarser
 * than a canonical role, and mapping it would collapse every discipline
 * into one denominator. Retained unmapped so a later phase can use it as a
 * disambiguation hint.
 */
function departmentLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const named = value
    .map((entry) => {
      const record = asRecord(entry);

      if (record === null) {
        return null;
      }

      const name = optionalString(record.name);

      if (name === null) {
        return null;
      }

      return { id: numericKey(record.id) ?? '', name };
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);

  named.sort((a, b) => {
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }

    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return named.map((entry) => entry.name);
}

function locationName(value: unknown): string | null {
  const record = asRecord(value);

  return record === null ? null : optionalString(record.name);
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * Greenhouse supplies a numeric posting id that is stable for the life
   * of the posting, so identity never has to fall back to a URL or a
   * content fingerprint - and therefore never carries their collision
   * risk. This is the main reason this source was chosen first.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);

    if (envelope === null || !Array.isArray(envelope.jobs)) {
      /*
       * The whole response is unreadable. Reported as one rejection at
       * index -1 rather than thrown, so the caller records a failed BOARD
       * within a run that can still succeed for its other boards. A throw
       * here would let one bad board fail forty good ones.
       */
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.jobs.forEach((entry: unknown, index: number) => {
      const job = asRecord(entry);

      if (job === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const externalKey = numericKey(job.id);

      if (externalKey === null) {
        /*
         * Covers a missing id, a string id, a negative one, and one past
         * 2^53 that the JSON parser has already rounded. A rounded id
         * could collide with a different posting, which would silently
         * merge two jobs - so it is refused rather than stored.
         */
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.title);

      if (titleRaw === null) {
        /*
         * A posting with no title cannot be resolved to a role, so it can
         * contribute to no signal. It is quarantined with its index rather
         * than stored as an untitled row that every later query has to
         * remember to exclude.
         */
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      const descriptionRaw = optionalString(job.content);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        companyRaw: optionalString(job.company_name),
        locationRaw: locationName(job.location),
        descriptionRaw,
        /*
         * Greenhouse returns the whole body or nothing; it has no preview
         * mode. TRUNCATED is therefore unreachable from THIS adapter - it
         * exists for the aggregators that only return a snippet, and it is
         * exercised by the second adapter in the contract tests rather
         * than left as a branch nobody ever runs.
         */
        descriptionCompleteness: descriptionRaw === null ? 'ABSENT' : 'FULL',
        sourcePublishedAt: optionalInstant(job.first_published),
        sourceUpdatedAt: optionalInstant(job.updated_at),
        /*
         * Present in the payload and null on all 864 postings sampled.
         * Parsed anyway, because it costs nothing and it is the field that
         * would replace our guessed posting lifetime with the employer's
         * own stated expiry the day a board starts setting it. Nothing
         * downstream may depend on it being present.
         */
        sourceValidThrough: optionalInstant(job.application_deadline),
        applyUrlRaw: optionalString(job.absolute_url),
        sourceCategoriesRaw: departmentLabels(job.departments),
        /*
         * The requisition behind the post. Greenhouse returns both, and
         * one requisition advertised in three cities is three posts
         * sharing this key - so volume counts posts and overcounts
         * openings. Stored because the source asserts it for free and
         * because it cannot be recovered later: Greenhouse deletes closed
         * postings, so a re-fetch to add this column would come back
         * empty.
         */
        externalGroupKey: numericKey(job.internal_job_id),
        payload: job,
      });
    });

    return { accepted, rejected };
  }
}
