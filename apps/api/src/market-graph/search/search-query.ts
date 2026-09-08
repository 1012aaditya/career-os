import { foldTerm } from '../observations/text.js';
import { normalizeTitle, tokenize } from '../normalization/normalize.js';
import { MAX_QUERY_TOKENS } from './search-ruleset.js';

/*
 * Query understanding.
 *
 * The whole of it, and it is deliberately small. A search box is where
 * systems reach for fuzzy matching, and Phase 9's finding was that fuzzy
 * matching is how "Data Analyst" quietly becomes "Data Scientist". So
 * this file does exactly one clever thing: it runs the user's query
 * through the SAME pipeline a posting title goes through.
 *
 * That single decision buys everything section 9 asks for and refuses
 * everything it forbids:
 *
 *   - "backend developer" resolves to the backend-engineer role through
 *     Phase 9's curated alias table, so it finds "Backend Engineer",
 *     "Backend Software Engineer" and "Java Backend Developer" - because
 *     a human decided those are the same role, once, in ruleset.ts.
 *   - "Software Engineer" cannot reach "Engineering Manager", because no
 *     alias says it can. There is no edit distance, no stemmer and no
 *     embedding anywhere in this path to invent an edge nobody authored.
 *   - A query that resolves to no role still searches. It just searches
 *     by tokens instead, and says so.
 *
 * Pure: no clock, no database, no Intl, no locale-dependent casing.
 */

/**
 * How the query reached a canonical role, if it did.
 *
 * Returned to the caller and rendered in the API response, because a
 * result set widened by a role expansion looks arbitrary unless the
 * reader is told which role it was widened to.
 */
export type QueryRoleResolution = 'ALIAS' | 'UNRESOLVED';

export type ParsedQuery = {
  /** Exactly what the caller sent, after trimming. Echoed, never used to match. */
  raw: string;
  /**
   * The query put through normalizeTitle, so it is directly comparable
   * with a document's titleNormalized. This is what TITLE_EXACT tests.
   */
  normalized: string;
  /** Folded tokens, capped. The order is the caller's; duplicates removed. */
  tokens: string[];
  /** The canonical role the query resolved to, via Phase 9's alias table. */
  roleSlug: string | null;
  roleResolution: QueryRoleResolution;
  /**
   * True when the caller sent something that produced no usable token -
   * punctuation, or a string of separators. Distinguished from "sent
   * nothing", because the two deserve different answers.
   */
  degenerate: boolean;
};

/** Duplicates removed, order preserved, length capped. */
function boundedTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }

    seen.add(token);
    out.push(token);

    if (out.length === MAX_QUERY_TOKENS) {
      break;
    }
  }

  return out;
}

/**
 * A free-text query, understood.
 *
 * `normalizeTitle` is doing the work, and using it rather than a
 * query-specific copy is the point: any divergence between how a query is
 * read and how a title is read would show up as a posting that cannot be
 * found by its own title. Two normalizers would drift; one cannot.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();

  const title = normalizeTitle(trimmed);
  const tokens = boundedTokens(tokenize(trimmed));

  return {
    raw: trimmed,
    normalized: title.titleNormalized,
    tokens,
    roleSlug: title.roleSlug,
    roleResolution: title.roleSlug === null ? 'UNRESOLVED' : 'ALIAS',
    degenerate: trimmed.length > 0 && tokens.length === 0,
  };
}

export type ParsedLocation = {
  raw: string;
  /**
   * Folded, whitespace-collapsed. Compared against a document's
   * locationNormalized, which was built by the same call.
   */
  normalized: string;
  tokens: string[];
  degenerate: boolean;
};

/**
 * A location query, understood.
 *
 * Folded and tokenized, and NOT put through normalizeTitle - that
 * function splits on a comma to drop a job title's trailing team name,
 * which would silently reduce "Toronto, ON" to "Toronto" and quietly
 * discard the half of the query that disambiguates it.
 *
 * There is no location taxonomy here, and that is a decision with a
 * measurement behind it rather than an omission. Five of the six sources
 * publish a bare city name with no country attached - "Toronto",
 * "Stockholm", "London" - so a taxonomy would have to INFER the country
 * from which source supplied the row. That is precisely the inference
 * Phase 9 refused for roles, and it fails the same way: "London" is a
 * city in Ontario as well as in England, and a taxonomy that resolved it
 * from the source slug would be asserting a fact the publisher never
 * stated. Token containment finds both and claims neither.
 */
export function parseLocationQuery(raw: string): ParsedLocation {
  const trimmed = raw.trim();
  const tokens = boundedTokens(tokenize(trimmed));

  return {
    raw: trimmed,
    normalized: foldTerm(trimmed),
    tokens,
    degenerate: trimmed.length > 0 && tokens.length === 0,
  };
}

/**
 * The location text stored on a document, and the tokens it is found by.
 *
 * Exported so the projection and the query use one implementation. A
 * document tokenized differently from the query that must match it is the
 * classic search bug, and the only reliable cure is that there is one
 * function.
 */
export function projectLocation(locationRaw: string | null): {
  normalized: string | null;
  tokens: string[];
} {
  if (locationRaw === null) {
    return { normalized: null, tokens: [] };
  }

  const normalized = foldTerm(locationRaw);

  /*
   * Not capped. The cap on the QUERY bounds the work; a document's tokens
   * are computed once at projection time and truncating them would make a
   * posting unfindable by the tail of its own location - which is exactly
   * what Greenhouse's "San Francisco, CA | New York City, NY | Seattle,
   * WA" would lose.
   */
  const tokens = [...new Set(tokenize(locationRaw))].sort();

  return { normalized: normalized === '' ? null : normalized, tokens };
}
