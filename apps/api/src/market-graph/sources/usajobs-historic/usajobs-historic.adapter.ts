import type { ContactRedaction } from '../../observations/redaction.js';
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
 * USAJOBS Historic Job Opportunity Announcements -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified live on 2026-09-08 with no credential of any kind: 125,717
 * announcements for occupational series 2210 alone.
 *
 * WHY THE HISTORIC ENDPOINT AND NOT THE SEARCH API. They are different
 * legal objects. The Search API is reached by registering for a key, and
 * registration binds you to terms whose section 2 says "You may not rent,
 * lease, loan, sell, trade or create derivative works of USAJOBS API
 * services and data, in whole or in part" - and a vacancy statistic is a
 * derivative work. This endpoint requires no registration, and USAJOBS
 * states on its own live documentation page that it "does not require
 * authorization or authentication. The data returned by this endpoint is
 * publicly consumable." Combined with 17 U.S.C. 105, which denies
 * copyright to US Government works, that is the strongest position
 * available here - and it is available only by NOT registering.
 *
 * The federal-work public-domain intuition is right about copyright and
 * irrelevant to the Search API, because the restriction there is
 * contractual rather than a copyright claim. That distinction is the whole
 * reason this adapter exists and the Search one does not.
 *
 * What it adds to the contract's coverage, and this is the valuable part:
 *
 *   description   NONE AT ALL     -> the first source to produce ABSENT
 *   pagination    opaque continuation token, not an offset or a page
 *   dates         date-only, and a null expiry on most records
 *   taxonomy      OPM occupational series, a real government code
 */

const SOURCE_SLUG = 'usajobs-historic';

const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/*
 * A calendar date, resolved by DECLARING midnight UTC.
 *
 * positionOpenDate is "2020-02-14" - no time, no zone. The shared parser
 * refuses that form because ECMAScript reads a zone-less date-time as
 * local, so the same string would mean different moments on different
 * machines. Midnight UTC is a declaration and nothing may treat it as
 * better than day resolution.
 */
export function usDateInstant(value: unknown): string | null {
  const text = optionalString(value);

  if (text === null || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  return optionalInstant(`${text}T00:00:00Z`);
}

/** Occupational series codes, ordered by us so a reshuffle cannot rehash. */
function seriesLabels(job: Record<string, unknown>): string[] {
  const categories = Array.isArray(job.jobcategories) ? job.jobcategories : [];

  const codes = categories
    .map((entry) => optionalString(asRecord(entry)?.series))
    .filter((code): code is string => code !== null);

  return [...new Set(codes)].sort();
}

function locationLabel(job: Record<string, unknown>): string | null {
  const locations = Array.isArray(job.positionlocations)
    ? job.positionlocations
    : [];

  const first = asRecord(locations[0]);

  if (first === null) {
    return null;
  }

  return (
    optionalString(first.positionLocationCity) ??
    optionalString(first.positionLocationState) ??
    optionalString(first.positionLocationCountry)
  );
}

export class UsaJobsHistoricAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /* usajobsControlNumber, a JSON integer assigned by the source. */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /*
   * No structured contact fields, and unusually this is VERIFIED rather
   * than assumed: I enumerated all 40 fields of a real record and none is
   * a contact, email, phone or person name.
   *
   * That is specific to THIS endpoint. Federal announcements do carry a
   * named HR specialist with an email and a phone - USAJOBS' own API terms
   * concede the data "contains no Personally-Identifiable Information of
   * USAJOBS system users other than publicly disclosed contact information
   * within the JOA" - but that lands in the Search API and in the separate
   * AnnouncementText endpoint, neither of which this adapter reads. The
   * universal patterns still run over everything stored.
   */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: [],
    nationalPhone: null,
  };

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);

    if (envelope === null || !Array.isArray(envelope.data)) {
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.data.forEach((entry: unknown, index: number) => {
      const job = asRecord(entry);

      if (job === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const externalKey = numericKey(job.usajobsControlNumber);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.positionTitle);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        /*
         * The hiring agency, not the department. "U.S. Mint" is the
         * employer a candidate would work for; "Department of the
         * Treasury" is its parent, and counting parents as employers
         * would make a handful of departments look like the whole federal
         * labour market.
         */
        companyRaw: optionalString(job.hiringAgencyName),
        locationRaw: locationLabel(job),
        /*
         * ABSENT, and this is the first source in the pipeline for which
         * that is true. The historic feed carries no body of any kind - 40
         * fields and not one of them a description.
         *
         * The consequence is deliberate and must not be papered over: with
         * no text, skill extraction has nothing to read, so every posting
         * from this source is excluded from every ROLE_SKILL_PREVALENCE
         * denominator and contributes only to ROLE_POSTING_VOLUME. That is
         * the completeness contract working - a posting we cannot read the
         * requirements of must not silently dilute a statistic about
         * requirements.
         */
        descriptionRaw: null,
        descriptionCompleteness: 'ABSENT',
        sourcePublishedAt: usDateInstant(job.positionOpenDate),
        sourceUpdatedAt: null,
        /*
         * positionCloseDate rather than positionExpireDate: the expire
         * field is null on most records while the close date is populated,
         * and the close date is the one that states when applications
         * stopped being accepted.
         */
        sourceValidThrough: usDateInstant(job.positionCloseDate),
        /*
         * No apply URL. These are closed historic announcements; the
         * original posting is gone, and inventing a URL that 404s would
         * be worse than saying nothing.
         */
        applyUrlRaw: null,
        sourceCategoriesRaw: seriesLabels(job),
        /*
         * The announcement number, which groups the several postings a
         * single announcement can produce. Stated by the source, so it is
         * stored as the source's own grouping rather than inferred.
         */
        externalGroupKey: optionalString(job.announcementNumber),
        payload: job,
      });
    });

    return { accepted, rejected };
  }
}
