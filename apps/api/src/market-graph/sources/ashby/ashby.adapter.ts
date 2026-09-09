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
 * Ashby job board API -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * The payload shape below was read off a live response on 2026-09-09 (70
 * postings, apiVersion 1), not off documentation. Everything asserted here
 * about the envelope, the key set and the timestamp format came from that
 * response.
 *
 * THIS ADAPTER IS COMPLETE AND ITS SOURCE IS NOT ENABLED. That is not a
 * contradiction and it is the whole point of Phase 11: reading a response
 * to learn its shape is not the same act as ingesting a corpus, and the
 * right to do the second has not been established. See the registry entry
 * for the access position; the short version is that the ATS vendor does
 * not own the posting text, so an open endpoint is not a grant, and the
 * route that would be one - a consent-gated partner feed where the
 * EMPLOYER agrees to syndication - is a business-development door that is
 * currently shut.
 *
 * Three properties of the real payload shape this file:
 *
 *   THERE IS NO EMPLOYER FIELD. Not one of the eighteen keys names the
 *   company. The board token is the employer's own identifier and the only
 *   employer statement the source makes, so it is what companyRaw carries.
 *
 *   `descriptionHtml` is real HTML, not entity-escaped like Greenhouse's.
 *   Stored verbatim; cleaning belongs to normalization, which is versioned.
 *
 *   `publishedAt` carries an offset ("...+00:00"), so it needs no
 *   adapter-supplied zone - unlike JobTech's naive local timestamps.
 */

const SOURCE_SLUG = 'ashby';

/** Bumped when this adapter would parse the same payload differently. */
const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/*
 * The source's own grouping labels, ordered by us.
 *
 * `department` and `team` are two scalar fields rather than an array, so
 * there is no provider ordering to inherit - but they are still sorted and
 * de-duplicated here, because a board that sets team equal to department
 * would otherwise contribute the same label twice and change the content
 * hash relative to a board that leaves team unset.
 *
 * NOT roles. "Engineering" is far coarser than a canonical role and
 * mapping it would collapse every discipline into one denominator.
 * Retained unmapped, exactly as the other ATS adapter retains its
 * department names.
 */
function categoryLabels(job: Record<string, unknown>): string[] {
  const labels = new Set<string>();

  for (const key of ['department', 'team'] as const) {
    const label = optionalString(job[key]);

    if (label !== null) {
      labels.add(label);
    }
  }

  return [...labels].sort();
}

export class AshbyAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * Ashby supplies a uuid per posting, stable for the life of the posting
   * and unique within a board. A string key rather than the numeric one
   * the first ATS adapter validates, which is why `numericKey` is not used
   * here: rejecting a uuid as "unusable" would reject every record.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /*
   * No structured contact fields: eighteen keys, none of them a contact.
   * The application channel is the ATS itself, so there is no reason for a
   * board to publish a direct line.
   *
   * The BODY is a different matter and the reason this profile is not just
   * a copy of the other ATS one. Ashby boards are written in a rich-text
   * editor by hiring managers rather than generated from a template, and
   * the live sample opens with a named hiring manager and a personal
   * LinkedIn URL in the first sentence. The universal email and
   * international-phone patterns run over every string here, as they do
   * for every source; personal names in prose remain the stated residual
   * they are everywhere else in this pipeline.
   *
   * nationalPhone is null because this source has no single market: one
   * board is Californian, the next Estonian, and a national trunk pattern
   * asserted over all of them would be wrong for almost all of them.
   */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: [],
    nationalPhone: null,
  };

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);

    if (envelope === null || !Array.isArray(envelope.jobs)) {
      /*
       * The whole response is unreadable. One rejection at index -1 rather
       * than a throw, so a broken board fails alone inside a run that can
       * still succeed for its other boards.
       */
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.jobs.forEach((entry: unknown, index: number) => {
      const job = asRecord(entry);

      if (job === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const externalKey = optionalString(job.id);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.title);

      if (titleRaw === null) {
        /*
         * A posting with no title resolves to no role and can contribute
         * to no signal. Quarantined with its index rather than stored as
         * an untitled row every later query has to remember to exclude.
         */
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      /*
       * `isListed: false` is the employer taking the posting off its own
       * board while the API still returns the record. Storing it would be
       * storing something the publisher has withdrawn, which is the same
       * refusal the Norwegian adapter makes for its INACTIVE entries -
       * counted, never silently dropped.
       *
       * Absent is treated as listed: every record in the live sample
       * carried the field as true, and inventing a delisting from a
       * missing field would delete real postings.
       */
      if (job.isListed === false) {
        rejected.push({ index, reason: 'unlisted_posting' });
        return;
      }

      const descriptionRaw = optionalString(job.descriptionHtml);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        /*
         * The board token, which is the employer's own identifier on this
         * source and the ONLY employer statement it makes - there is no
         * company field in the response at all.
         *
         * A token rather than a display name, and that limitation is real:
         * "acme-corp" is what a reader sees where another source would say
         * "Acme Corporation". Normalization slugs company names anyway, so
         * the canonical value is unaffected; only the displayed string is
         * coarser. The alternative was null, which would put every Ashby
         * posting below the distinct-employer floor and show a job with no
         * employer at all - a worse answer to a question the source does
         * in fact answer.
         */
        companyRaw: sourceScope,
        locationRaw: optionalString(job.location),
        descriptionRaw,
        /*
         * Ashby serves the whole body or nothing; there is no preview
         * mode, so TRUNCATED is unreachable from this adapter.
         */
        descriptionCompleteness: descriptionRaw === null ? 'ABSENT' : 'FULL',
        sourcePublishedAt: optionalInstant(job.publishedAt),
        /*
         * The source publishes no update timestamp and no expiry. Null
         * rather than a substitute: `publishedAt` copied into
         * sourceUpdatedAt would assert that nothing has ever been edited,
         * and a retrieval time copied into either would make imported data
         * look newly published - which is the one thing freshness must
         * never be told.
         */
        sourceUpdatedAt: null,
        sourceValidThrough: null,
        /*
         * `applyUrl` is the application form; `jobUrl` is the posting page.
         * The form is where an application actually goes, and the page is
         * the fallback for a board that omits the form link.
         */
        applyUrlRaw:
          optionalString(job.applyUrl) ?? optionalString(job.jobUrl),
        sourceCategoriesRaw: categoryLabels(job),
        /*
         * Ashby publishes no occupational classification - no SOC, no NOC,
         * no ISCO. Its categories are a company's own org chart, which is
         * not a taxonomy, so declaring a scheme for them would let the
         * canonical layer treat "Engineering" as a code.
         */
        occupationScheme: null,
        /*
         * No requisition id in this API. A multi-location opening is
         * published as ONE record carrying `secondaryLocations` rather
         * than fanned out into one posting per city, so this source does
         * not produce the sibling postings a group key exists to collapse.
         */
        externalGroupKey: null,
        payload: job,
      });
    });

    return { accepted, rejected };
  }
}
