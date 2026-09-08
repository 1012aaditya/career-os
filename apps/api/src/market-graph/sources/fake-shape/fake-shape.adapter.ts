import type { ContactRedaction } from '../../observations/redaction.js';
import { optionalString } from '../../observations/values.js';
import type {
  AdapterParseResult,
  IdentityBasis,
  RawPostingRecord,
  RejectedRecord,
  SourceAdapter,
} from '../source-adapter.js';

/*
 * A second adapter, shaped deliberately unlike the first.
 *
 * This exists to keep the adapter contract honest. A contract that only
 * one adapter has ever satisfied is not a contract - it is a description
 * of that adapter - and the claim that a second source can be added
 * without redesigning the canonical schema is untested until a second
 * source with a different shape actually passes.
 *
 * So every axis on which real sources differ is inverted here relative to
 * Greenhouse:
 *
 *   envelope      nested { data: { items } }   vs a flat { jobs }
 *   ids           strings                      vs JSON numbers
 *   timestamps    Unix epoch SECONDS           vs ISO-8601 with an offset
 *   description   a truncated preview          vs the full body
 *   skills        a comma-joined string        vs prose only
 *   company       absent from the record       vs a field on every job
 *   update time   not supplied at all          vs updated_at
 *
 * It is a test double in the sense that no server serves it, but it is
 * production code in the sense that it implements the real interface with
 * no shortcuts - which is the only way it can prove anything about the
 * interface.
 *
 * It is also the only adapter that can currently produce a TRUNCATED
 * description. Greenhouse always returns the whole body, so without this
 * the branch that excludes truncated postings from the prevalence
 * denominator - the piece of the signal definition that carries the most
 * weight - would never execute until the first snippet-shaped source
 * arrived, in production, untested.
 */

const SOURCE_SLUG = 'fake-shape';
const ADAPTER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * Epoch seconds to an ISO-8601 instant in UTC.
 *
 * The unit is declared by the adapter, never sniffed from the magnitude of
 * the number. Guessing seconds-versus-milliseconds from size is how a
 * timestamp lands in 1970 or in the year 55000, and the source knows which
 * it emits even when the value does not.
 */
function fromEpochSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

/** "js, postgres" -> ["js", "postgres"], ordered by us, not by the source. */
function splitTags(value: unknown): string[] {
  const text = optionalString(value);

  if (text === null) {
    return [];
  }

  return [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ].sort();
}

export class FakeShapeAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * This source supplies a stable string id. It is still SOURCE_ID: the
   * basis describes where identity came from, not what type it happens to
   * be stored as.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /* Nothing source-specific; the universal patterns are the whole rule. */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: [],
    nationalPhone: null,
  };

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = asRecord(body);
    const data = envelope === null ? null : asRecord(envelope.data);
    const items = data === null ? null : data.items;

    if (!Array.isArray(items)) {
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    items.forEach((entry: unknown, index: number) => {
      const item = asRecord(entry);

      if (item === null) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const externalKey = optionalString(item.ref);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw = optionalString(item.headline);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      const preview = optionalString(item.preview);

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        /* This source states no employer at all. Absent, not empty. */
        companyRaw: optionalString(item.employer),
        locationRaw: optionalString(item.place),
        descriptionRaw: preview,
        /*
         * A preview, never the whole body. Recorded honestly so the signal
         * layer can keep these out of a prevalence denominator they would
         * systematically drag down.
         */
        descriptionCompleteness: preview === null ? 'ABSENT' : 'TRUNCATED',
        sourcePublishedAt: fromEpochSeconds(item.posted_ts),
        /* Not supplied by this source. Null means the source did not say. */
        sourceUpdatedAt: null,
        sourceValidThrough: fromEpochSeconds(item.closes_ts),
        applyUrlRaw: optionalString(item.link),
        sourceCategoriesRaw: splitTags(item.tags),
        externalGroupKey: null,
        payload: item,
      });
    });

    return { accepted, rejected };
  }
}
