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
 * UK Teaching Vacancies (Department for Education) -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified against the live API on 2026-09-08: 3649 vacancies across 37
 * pages, and the licence is declared in the API's own envelope -
 *   "license": { "name": "Open Government License",
 *                "url": ".../open-government-licence/version/3/" }
 * - which is the same kind of in-band evidence that made JobTech the first
 * source with an affirmative grant.
 *
 * What this source does that neither existing one does:
 *
 *   identity      NO id field at all         vs numeric / string ids
 *   pagination    page number + links.next   vs none / offset
 *   payload       schema.org JobPosting      vs bespoke envelopes
 *   published     date-only, no time         vs ISO+offset / epoch ms
 *   employer      a government URN           vs display string / org no.
 *   location      nested PostalAddress       vs { name } / address object
 */

const SOURCE_SLUG = 'teaching-vacancies';

const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/*
 * A calendar date, resolved to an instant by DECLARING midnight UTC.
 *
 * `datePosted` is "2026-09-08" - a date with no time and no zone. The
 * shared parser refuses that form, and rightly: ECMAScript reads a
 * zone-less date-time as local, so the same string would mean different
 * moments on different machines. Supplying the missing precision is the
 * adapter's job because only the adapter knows what the source meant.
 *
 * Midnight UTC is a declaration, not a measurement. The true publication
 * moment is somewhere inside that UK day, and nothing downstream may treat
 * this as better than day-resolution. It is used only for
 * sourcePublishedAt, which no signal window depends on - windows filter on
 * observedAt, which we measure ourselves.
 */
export function ukDateInstant(value: unknown): string | null {
  const text = optionalString(value);

  if (text === null || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  return optionalInstant(`${text}T00:00:00Z`);
}

function addressLabel(value: unknown): string | null {
  const address = asRecord(asRecord(value)?.address);

  if (address === null) {
    return null;
  }

  return (
    optionalString(address.addressLocality) ??
    optionalString(address.addressRegion) ??
    optionalString(address.addressCountry)
  );
}

/** Category labels, ordered by us so a reshuffle cannot change the hash. */
function categoryLabels(job: Record<string, unknown>): string[] {
  const labels = [
    optionalString(job.occupationalCategory),
    optionalString(job.industry),
    ...(Array.isArray(job.employmentType)
      ? job.employmentType.map((entry) => optionalString(entry))
      : []),
  ].filter((label): label is string => label !== null);

  return [...new Set(labels)].sort();
}

export class TeachingVacanciesAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * SOURCE_URL, and it is the first source to need it.
   *
   * The payload carries no id of any kind - `url` is the only field that
   * distinguishes one vacancy from another. That is a WEAKER identity than
   * a source-assigned id and the basis says so rather than letting a
   * URL-identified posting be stamped `sid:` and stored as SOURCE_ID,
   * which is exactly the misrepresentation MarketIdentityBasis exists to
   * prevent.
   *
   * The specific weakness: the URL is a slug built from the job title and
   * the school name, so an employer correcting a typo in either could move
   * a live vacancy to a new URL. We would read that as a new posting and
   * the old one as delisted. Recorded here rather than discovered later.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_URL';

  /*
   * No structured contact fields: schema.org JobPosting has no contact
   * property and this source populates none. The measured risk is in the
   * body - a live sample of 100 vacancies carried an email in 17 of them,
   * mostly role aliases like recruitment@school - which the universal
   * patterns remove.
   */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: [],
    /* UK numbers are written in too many shapes to match safely; the
     * international form is covered by the shared pattern. */
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

      /* The URL is the identity, so a missing one is an unusable record. */
      const externalKey = optionalString(job.url);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.title);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      const employer = asRecord(job.hiringOrganization);
      const descriptionRaw = optionalString(job.description);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        companyRaw: optionalString(employer?.name),
        locationRaw: addressLabel(job.jobLocation),
        descriptionRaw,
        descriptionCompleteness: descriptionRaw === null ? 'ABSENT' : 'FULL',
        sourcePublishedAt: ukDateInstant(job.datePosted),
        /*
         * Absent by design. schema.org JobPosting has no last-modified
         * property and this source publishes none, so a re-fetch cannot
         * tell an edited vacancy from an unedited one. The content hash
         * detects real edits regardless, which is why it is the hash and
         * not this field that decides what a version is.
         */
        sourceUpdatedAt: null,
        /* ISO 8601 WITH an offset, e.g. 2026-09-29T12:00:00+01:00. */
        sourceValidThrough: optionalInstant(job.validThrough),
        applyUrlRaw: externalKey,
        sourceCategoriesRaw: categoryLabels(job),
        occupationScheme: 'dfe-occupational-category',
        /*
         * The school's DfE Unique Reference Number - a real government
         * registration identifier, and the strongest employer identity of
         * any source here. It groups every vacancy at one school without
         * relying on the display name matching.
         */
        externalGroupKey: optionalString(employer?.identifier),
        payload: job,
      });
    });

    return { accepted, rejected };
  }
}
