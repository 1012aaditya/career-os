import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  FRESHNESS_FILTERS,
  MAX_FILTER_VALUES,
  MAX_PAGE_SIZE,
  MAX_QUERY_LENGTH,
  SORT_OPTIONS,
} from './search-ruleset.js';

/*
 * What a caller is allowed to send.
 *
 * A whitelist, and the global ValidationPipe runs with
 * forbidNonWhitelisted - so a parameter that is not declared here is a
 * 400, not something quietly ignored. That matters more on a search
 * endpoint than anywhere else in the API: search is the surface where an
 * unvalidated field becomes an ORDER BY, a LIMIT or a column name.
 *
 * Nothing here is ever interpolated into SQL. `sort` is checked against a
 * fixed list and then mapped to a fixed expression in the service; every
 * other value reaches the database as a bound parameter.
 *
 * There is no field for a user id, a profile, or anything a person owns.
 * Phase 10 answers "what jobs exist that match this search", and it must
 * not be POSSIBLE to ask it anything else.
 */

/**
 * Repeated query parameters arrive as a string when given once and an
 * array when given more than once. Normalized here so a validator sees
 * one shape, and trimmed of empties so `?skills=` is absent rather than
 * a filter on the empty string.
 */
function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw = Array.isArray(value) ? value : [value];

  const cleaned = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return cleaned.length === 0 ? undefined : cleaned;
}

/** Canonical slugs, as the vocabulary spells them. Never free text. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export class MarketSearchQueryDto {
  /** Free text. Bounded, because every token becomes a scoring term. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  company?: string;

  /**
   * A canonical role slug. Pattern-constrained rather than merely typed:
   * a role is a key from a fixed vocabulary, and anything that is not
   * slug-shaped is a caller error worth reporting rather than a filter
   * that will match nothing.
   */
  @IsOptional()
  @IsString()
  @Matches(SLUG)
  @MaxLength(80)
  role?: string;

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @ArrayMaxSize(MAX_FILTER_VALUES)
  @IsString({ each: true })
  @Matches(SLUG, { each: true })
  skills?: string[];

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @ArrayMaxSize(MAX_FILTER_VALUES)
  @IsString({ each: true })
  @Matches(SLUG, { each: true })
  sources?: string[];

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @ArrayMaxSize(MAX_FILTER_VALUES)
  @IsIn(FRESHNESS_FILTERS, { each: true })
  freshness?: Array<(typeof FRESHNESS_FILTERS)[number]>;

  /**
   * A floor on the publisher's own publication date, in days.
   *
   * Capped at 3650 rather than left open: the corpus holds postings
   * published in 2014, and an unbounded value is a filter that reads as
   * a filter and does nothing.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  publishedWithinDays?: number;

  @IsOptional()
  @IsIn(SORT_OPTIONS)
  sort?: (typeof SORT_OPTIONS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /**
   * An opaque continuation token from a previous response.
   *
   * Length-capped so a caller cannot make the decoder do unbounded work,
   * and character-constrained to base64url so a malformed one is refused
   * before it reaches the decoder at all.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}
