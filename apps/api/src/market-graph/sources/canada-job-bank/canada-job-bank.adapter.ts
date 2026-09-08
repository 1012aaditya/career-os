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
 * Canada Job Bank open data -> RawPostingRecord.
 *
 * Pure: rows in, records out. No network, no clock, no database.
 *
 * Verified live on 2026-09-08 against the Government of Canada open data
 * portal, whose CKAN metadata returns `"license_id": "ca-ogl-lgo"` - the
 * Open Government Licence – Canada, which grants the right to "copy,
 * modify, publish, translate, adapt, distribute or otherwise use the
 * Information in any medium, mode or format for any lawful purpose".
 *
 * This is the source that proves the contract is not a JSON contract.
 * Every other adapter parses an HTTP JSON envelope; this one parses a
 * monthly UTF-16LE tab-separated file with 65 columns. The canonical model
 * needed no new field for it, and `parse(body: unknown)` needed no new
 * signature - the client hands over decoded rows, which is the same
 * arrangement by which the JobTech client hands over a decoded JSON
 * envelope.
 *
 * WHAT IT DOES NOT CARRY, and this shapes what it can contribute:
 * there is no employer name and no description anywhere in the 65 columns.
 * So every posting is ABSENT and companyRaw is null, which means this
 * source contributes to ROLE_POSTING_VOLUME and to no prevalence
 * denominator - and, because distinctCompanyCount can never exceed zero
 * here, it will not clear the minDistinctCompanies floor for any
 * prevalence pair even if a description ever appeared. That is a property
 * of the data, stated here rather than discovered as a suppression count.
 */

const SOURCE_SLUG = 'canada-job-bank';

const ADAPTER_VERSION = 1;

/** The columns this adapter reads, by their exact header text. */
const ID = 'WIC Job Location Snapshot ID';
const TITLE = 'Job Title';
const ORIGINAL_TITLE = 'Original Job Title';
const POSTED = 'First Posting Date';
const CITY = 'City';
const PROVINCE = 'Province/Territory';
const NOC_2016 = 'NOC 2016 Code';
const NOC_2016_NAME = 'NOC 2016 Code Name';
const NOC_21 = 'NOC21 Code';
const NOC_21_NAME = 'NOC21 Code Name';

export type CanadaRow = Readonly<Record<string, string>>;

/*
 * A slash-separated calendar date, resolved by DECLARING midnight UTC.
 *
 * `First Posting Date` is "2026/08/07" - not ISO, and with no time and no
 * zone. Rewritten to ISO and given an explicit Z, because the shared
 * parser refuses a zone-less date-time and it is right to: the same string
 * would otherwise mean different moments on different machines. Midnight
 * UTC is a declaration and nothing may treat this as better than day
 * resolution.
 */
export function canadaDateInstant(value: unknown): string | null {
  const text = optionalString(value);

  if (text === null) {
    return null;
  }

  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);

  if (match === null) {
    return null;
  }

  return optionalInstant(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}

/** Occupation codes and labels, ordered by us so a reshuffle cannot rehash. */
function occupationLabels(row: CanadaRow): string[] {
  const values = [
    row[NOC_2016],
    row[NOC_2016_NAME],
    row[NOC_21],
    row[NOC_21_NAME],
  ]
    .map((value) => optionalString(value))
    .filter((value): value is string => value !== null);

  return [...new Set(values)].sort();
}

export class CanadaJobBankAdapter implements SourceAdapter {
  readonly sourceSlug = SOURCE_SLUG;

  readonly adapterVersion = ADAPTER_VERSION;

  /*
   * The snapshot id the publisher assigns to each job location. It is
   * unique within a monthly file, which is why the scope is the month -
   * the same id in two months is two observations of the market, and
   * scoping by month keeps them distinct without pretending they are
   * unrelated.
   */
  readonly identityBasis: IdentityBasis = 'SOURCE_ID';

  /*
   * Nothing to declare, and unusually this is certain rather than
   * probable: all 65 columns were enumerated and none is an employer name,
   * a contact, an email, a phone or a description. It is the lowest
   * privacy risk of any source surveyed - there is no free text at all.
   */
  readonly contactRedaction: ContactRedaction = {
    structuredFields: [],
    nationalPhone: null,
  };

  parse(body: unknown, sourceScope: string): AdapterParseResult {
    const accepted: RawPostingRecord[] = [];
    const rejected: RejectedRecord[] = [];

    const envelope = body as { rows?: unknown } | null;

    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      !Array.isArray(envelope.rows)
    ) {
      return { accepted, rejected: [{ index: -1, reason: 'unreadable_body' }] };
    }

    envelope.rows.forEach((entry: unknown, index: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        rejected.push({ index, reason: 'not_an_object' });
        return;
      }

      const row = entry as CanadaRow;
      const externalKey = optionalString(row[ID]);

      if (externalKey === null) {
        rejected.push({ index, reason: 'unusable_id' });
        return;
      }

      const titleRaw =
        optionalString(row[TITLE]) ?? optionalString(row[ORIGINAL_TITLE]);

      if (titleRaw === null) {
        rejected.push({ index, reason: 'missing_title' });
        return;
      }

      accepted.push({
        externalKey,
        sourceScope,
        titleRaw,
        /*
         * Null, and it must stay null. The file carries no employer of any
         * kind, and putting a placeholder here - the province, say, or the
         * publisher's own name - would make distinctCompanyCount a count
         * of something that is not employers, which is the number the
         * publication floor exists to protect.
         */
        companyRaw: null,
        locationRaw: optionalString(row[CITY]) ?? optionalString(row[PROVINCE]),
        descriptionRaw: null,
        descriptionCompleteness: 'ABSENT',
        sourcePublishedAt: canadaDateInstant(row[POSTED]),
        sourceUpdatedAt: null,
        sourceValidThrough: null,
        applyUrlRaw: null,
        sourceCategoriesRaw: occupationLabels(row),
        externalGroupKey: null,
        payload: { ...row },
      });
    });

    return { accepted, rejected };
  }
}
