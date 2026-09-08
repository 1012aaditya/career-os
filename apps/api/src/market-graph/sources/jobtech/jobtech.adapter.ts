import { optionalString } from '../../observations/values.js';
import type {
  AdapterParseResult,
  IdentityBasis,
  RawPostingRecord,
  RejectedRecord,
  SourceAdapter,
} from '../source-adapter.js';

/*
 * JobTech (Arbetsförmedlingen Platsbanken) -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified against the live API on 2026-09-08. Everything asserted below
 * was read off real responses rather than off documentation.
 *
 * This adapter exists to prove the contract, so it is worth naming what it
 * does differently from the first one - every line of it is a path the
 * pipeline had never run:
 *
 *   envelope      { hits: [...], total: { value } }   vs a flat { jobs }
 *   ids           strings                             vs JSON numbers
 *   published     naive ISO with NO OFFSET            vs ISO with -04:00
 *   updated       epoch MILLISECONDS                  vs ISO
 *   expiry        populated on every ad               vs null on all 864
 *   location      a nested address object             vs { name }
 *   taxonomy      coded concept ids + SSYK            vs free-text names
 *   employer id   an organisation number              vs a display string
 *   pagination    real, with a hard server-side cap   vs none at all
 *
 * The contract needed no new field for any of it.
 */

const SOURCE_SLUG = 'jobtech';

const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/*
 * The last Sunday of a month, at a given UTC hour, as an epoch instant.
 * Used only by the zone rule below.
 */
function lastSundayUtc(year: number, monthIndex: number, hour: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));

  lastDay.setUTCDate(lastDay.getUTCDate() - lastDay.getUTCDay());
  lastDay.setUTCHours(hour, 0, 0, 0);

  return lastDay.getTime();
}

/*
 * A naive local timestamp, resolved to a UTC instant in Europe/Stockholm.
 *
 * This function is the price of the source's format, and it belongs here
 * rather than anywhere shared. JobTech emits `publication_date` and
 * `application_deadline` with NO offset - "2026-09-08T07:59:47" - and the
 * shared instant parser deliberately REFUSES that form, because
 * ECMAScript reads a zone-less date-time as local and the same string
 * would then mean two different moments on two machines. Refusing is the
 * right default; supplying the missing zone is the adapter's job, because
 * only the adapter knows which zone the source meant.
 *
 * The EU rule is implemented rather than delegated to Intl, which is
 * banned across this module: its tables are ICU-version dependent, so a
 * container upgrade could silently move a timestamp. Central European
 * Summer Time runs from 01:00 UTC on the last Sunday in March to 01:00 UTC
 * on the last Sunday in October.
 *
 * The one hour that repeats each October is genuinely ambiguous in the
 * source data; it resolves to the earlier (summer-time) instant. An hour of
 * ambiguity once a year is a real limitation and is preferable to reading
 * every Swedish timestamp an hour or two wrong all year.
 */
const NAIVE_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

export function stockholmInstant(value: unknown): string | null {
  const text = optionalString(value);

  if (text === null) {
    return null;
  }

  const match = NAIVE_LOCAL.exec(text);

  if (match === null) {
    return null;
  }

  const [, y, mo, d, h, mi, s] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const summerStart = lastSundayUtc(y, 2, 1);
  const summerEnd = lastSundayUtc(y, 9, 1);

  const asSummer = Date.UTC(y, mo - 1, d, h - 2, mi, s);
  const offsetHours = asSummer >= summerStart && asSummer < summerEnd ? 2 : 1;

  const instant = Date.UTC(y, mo - 1, d, h - offsetHours, mi, s);

  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

/**
 * Epoch milliseconds to an ISO instant.
 *
 * The unit is DECLARED by the adapter, never inferred from the magnitude
 * of the number. Guessing seconds from milliseconds by size is how a
 * timestamp lands in 1970 or in the year 55000, and the source knows which
 * it emits even when the value does not.
 */
export function epochMillisInstant(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

/*
 * Fields removed from the payload before it is stored.
 *
 * This is the one place in either adapter where something is deliberately
 * dropped rather than preserved, and it overrides the rule that raw
 * observations are kept verbatim.
 *
 * CC0 waives copyright. It explicitly does NOT waive privacy or publicity
 * rights, and Swedish ads carry named individuals: measured on a live
 * sample of 25 postings, 9 carried `application_contacts` holding 13
 * personal email addresses and 13 mobile numbers of named recruiters.
 * Storing those durably, permanently, with no deletion path, is a
 * data-protection decision - a different and harder question than the
 * licensing one, and not a question this phase has answered.
 *
 * So the contact block never reaches the database. What is lost is the
 * ability to say who to contact, which nothing in a market graph needs.
 * The employer, the role and the requirements all survive intact.
 */
const CONTACT_FIELDS = ['application_contacts'] as const;

const EMPLOYER_CONTACT_FIELDS = ['email', 'phone_number'] as const;

function withoutContactDetails(
  job: Record<string, unknown>,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...job };

  for (const field of CONTACT_FIELDS) {
    delete stripped[field];
  }

  const employer = asRecord(stripped.employer);

  if (employer !== null) {
    const cleanEmployer: Record<string, unknown> = { ...employer };

    for (const field of EMPLOYER_CONTACT_FIELDS) {
      delete cleanEmployer[field];
    }

    stripped.employer = cleanEmployer;
  }

  return stripped;
}

/** Concept labels, ordered by us so a reshuffle cannot change the hash. */
function taxonomyLabels(job: Record<string, unknown>): string[] {
  const labels = ['occupation', 'occupation_group', 'occupation_field']
    .map((key) => optionalString(asRecord(job[key])?.label))
    .filter((label): label is string => label !== null);

  return [...new Set(labels)].sort();
}

function addressLabel(value: unknown): string | null {
  const address = asRecord(value);

  if (address === null) {
    return null;
  }

  return (
    optionalString(address.municipality) ??
    optionalString(address.region) ??
    optionalString(address.country)
  );
}

export class JobTechAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * The ad id is a stable string the API will resolve at /ad/{id}. It is
   * documented nowhere as permanent or non-reused, so this is an observed
   * property rather than a promised one - which is exactly what
   * MarketIdentityBasis records, and why the basis is stored beside every
   * posting rather than assumed.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);

    if (envelope === null || !Array.isArray(envelope.hits)) {
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.hits.forEach((entry: unknown, index: number) => {
      const job = asRecord(entry);

      if (job === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      /*
       * A tombstone. The stream form of this source emits removals as a
       * stub carrying a removal date and no title, employer or body - in
       * one sampled window, 67 of 154 records. The contract has no way to
       * express a delisting, so they are refused and counted rather than
       * stored as a posting with no title. Recording the delisting itself
       * is unbuilt work, named in the phase's residuals.
       */
      if (job.removed === true) {
        rejected.push({ index, reason: 'removed_posting' });
        return;
      }

      const externalKey = optionalString(job.id);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.headline);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      const description = asRecord(job.description);

      /*
       * The HTML form, not the plain one. The shared text pipeline decodes
       * entities and strips tags, which is correct for HTML and would
       * mangle a plain body containing a literal "<" or "&".
       */
      const descriptionRaw =
        optionalString(description?.text_formatted) ??
        optionalString(description?.text);

      const employer = asRecord(job.employer);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        companyRaw: optionalString(employer?.name),
        locationRaw: addressLabel(job.workplace_address),
        descriptionRaw,
        descriptionCompleteness: descriptionRaw === null ? 'ABSENT' : 'FULL',
        sourcePublishedAt: stockholmInstant(job.publication_date),
        sourceUpdatedAt: epochMillisInstant(job.timestamp),
        /*
         * Populated on effectively every ad, unlike the first source where
         * the equivalent field was null on all 864 postings sampled. This
         * is the source that makes a source-stated posting lifetime real
         * rather than a configured guess.
         */
        sourceValidThrough: stockholmInstant(job.application_deadline),
        applyUrlRaw:
          optionalString(asRecord(job.application_details)?.url) ??
          optionalString(job.webpage_url),
        sourceCategoriesRaw: taxonomyLabels(job),
        /*
         * The employer's organisation number - a real legal-entity
         * identifier, which is strictly stronger than the first source's
         * display string. It is the grouping the SOURCE asserts, so it is
         * stored as such rather than inferred.
         */
        externalGroupKey: optionalString(employer?.organization_number),
        payload: withoutContactDetails(job),
      });
    });

    return { accepted, rejected };
  }
}
