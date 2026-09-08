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
 * Jobicy (remote jobs) -> RawPostingRecord.
 *
 * Pure: payload in, records out. No network, no clock, no database.
 *
 * Verified against the live API on 2026-09-08. Jobicy's syndication terms
 * grant this use in unusually plain words: "You may use Jobicy listings in
 * your own products and user experiences without requesting individual
 * permission... You may create your own interfaces, summaries, categories,
 * search experiences, and additional context around listings."
 *
 * What it adds to the contract's coverage: a source with NO pagination of
 * any kind. It serves a rolling window of the most recent listings and
 * offers no offset, page or cursor - so the walk is one page and the scope
 * is complete by construction, while the corpus behind it is not. That
 * distinction is recorded in the licence note rather than hidden, because
 * "we read everything the source would serve" is not "we read the market".
 */

const SOURCE_SLUG = 'jobicy';

const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/** Labels, ordered by us so a reshuffle cannot change the hash. */
function labels(job: Record<string, unknown>): string[] {
  const values = [
    ...(Array.isArray(job.jobIndustry) ? job.jobIndustry : []),
    ...(Array.isArray(job.jobType) ? job.jobType : []),
    job.jobLevel,
  ].map((entry) => optionalString(entry));

  return [...new Set(values.filter((v): v is string => v !== null))].sort();
}

export class JobicyAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * A JSON number, and small enough to be safe - the live ids sit around
   * 150000, far below 2^53. numericKey refuses anything that is not a
   * safe integer rather than storing a rounded id, because a rounded id
   * could collide with a different posting and silently merge two jobs.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /*
   * No structured contact fields. Jobicy aggregates from employer sites,
   * so the body is the exposure and the universal patterns cover it.
   * Remote-first listings are English-language and international, so no
   * single national phone form applies.
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
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(job.jobTitle);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      /*
       * The full description, not the excerpt. Both are present;
       * jobExcerpt is a truncated preview and storing it would make every
       * posting from this source permanently ineligible for prevalence
       * while looking like a complete read.
       */
      const descriptionRaw = optionalString(job.jobDescription);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        companyRaw: optionalString(job.companyName),
        locationRaw: optionalString(job.jobGeo),
        descriptionRaw,
        descriptionCompleteness: descriptionRaw === null ? 'ABSENT' : 'FULL',
        /* ISO 8601 with an explicit +00:00 offset. */
        sourcePublishedAt: optionalInstant(job.pubDate),
        /*
         * No last-modified field is published, so an edit is invisible to
         * a re-fetch and only the content hash detects it.
         */
        sourceUpdatedAt: null,
        /*
         * No expiry field. Freshness therefore falls back to the
         * configured expectedPostingLifetimeDays for this source, and the
         * verdict says lifetimeBasis DEFAULT so a reader can see that the
         * number rests on our guess rather than the employer's statement.
         */
        sourceValidThrough: null,
        applyUrlRaw: optionalString(job.url),
        sourceCategoriesRaw: labels(job),
        /*
         * No employer identifier of any kind - companyName is a display
         * string, so two spellings of one employer are two employers here.
         * Null rather than the name, because a name is not an id and
         * storing it as one would make the weakness invisible.
         */
        externalGroupKey: null,
        payload: job,
      });
    });

    return { accepted, rejected };
  }
}
