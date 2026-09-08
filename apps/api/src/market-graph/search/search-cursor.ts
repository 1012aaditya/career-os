import { canonicalHash } from '../../common/canonical-hash.js';

/*
 * Keyset pagination, encoded.
 *
 * Offset pagination is the obvious thing and it is wrong here for a
 * reason that has nothing to do with speed. OFFSET 20 asks the database
 * to re-run the whole ranked query and throw the first twenty rows away,
 * so page 2 is computed against whatever the table holds at the moment it
 * is asked - and a projection rebuild between two pages silently drops
 * results the reader never sees and repeats ones they already did. A
 * keyset says "resume after exactly this row", which cannot skip and
 * cannot repeat.
 *
 * The key is the full ordering tuple:
 *
 *   (relevance DESC, sourcePublishedAt DESC NULLS LAST, externalId ASC)
 *
 * externalId is last and is what makes the order TOTAL. Without it two
 * postings with the same score and the same publication date - which
 * happens constantly, 1,892 Canada Job Bank postings share a city and a
 * day - would come back in whatever order the executor chose, and that
 * order can differ between two runs of the same query on the same rows.
 * It is externalId rather than the uuid primary key because a uuid is
 * different in dev, CI and production, so an ordering broken by one would
 * reproduce in-process and differ everywhere else.
 *
 * Pure: no clock, no database, no randomness.
 */

/** The version of the encoding, so a stored cursor cannot outlive it. */
const CURSOR_VERSION = 1;

const SEPARATOR = '|';

export type SearchCursor = {
  relevance: number;
  /** Epoch milliseconds, or null for a posting with no stated date. */
  publishedAtMs: number | null;
  externalId: string;
};

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`cursor is not usable: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

/**
 * A fingerprint of everything that decides the ordering.
 *
 * Carried inside the cursor and checked on the way back in. Without it a
 * cursor from "software engineer in Toronto" could be replayed against
 * "nurse in Malmo" and would silently resume from a position that means
 * nothing in the second ordering - returning a page that is neither
 * correct nor detectably wrong.
 *
 * The ranking version and the as-of DAY are in it too, so a cursor issued
 * yesterday, or under different weights, is refused rather than used to
 * page through an ordering that no longer exists.
 */
export function orderingFingerprint(value: unknown): string {
  return canonicalHash(value).slice(0, 16);
}

/**
 * The cursor, as a URL-safe opaque string.
 *
 * Opaque by contract, not by encryption. It carries no secret and no user
 * identity - only a position in a public ordering - so base64url of a
 * readable form is the honest representation: it is tamper-EVIDENT
 * through the fingerprint rather than tamper-proof, and a tampered
 * position can only ever move a reader within results they were already
 * entitled to see.
 */
export function encodeCursor(
  cursor: SearchCursor,
  fingerprint: string,
): string {
  const parts = [
    String(CURSOR_VERSION),
    fingerprint,
    String(cursor.relevance),
    cursor.publishedAtMs === null ? '-' : String(cursor.publishedAtMs),
    /*
     * base64url'd on its own, because an externalId contains ':' and '/'
     * and would otherwise collide with the separator. Encoded rather than
     * escaped so the decoder needs no un-escaping rules.
     */
    Buffer.from(cursor.externalId, 'utf8').toString('base64url'),
  ];

  return Buffer.from(parts.join(SEPARATOR), 'utf8').toString('base64url');
}

/**
 * The position a cursor names, or a refusal.
 *
 * Every failure path throws rather than falling back to page one. A
 * silent fallback is the worst available behaviour: the caller believes
 * it is on page 4 and is served page 1, so the list appears to loop and
 * nothing in the response says why.
 */
export function decodeCursor(
  encoded: string,
  fingerprint: string,
): SearchCursor {
  let decoded: string;

  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    /* The caught error is never inspected and never attached. */
    throw new InvalidCursorError('not base64url');
  }

  const parts = decoded.split(SEPARATOR);

  if (parts.length !== 5) {
    throw new InvalidCursorError('wrong shape');
  }

  const [version, carried, relevance, published, externalId] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== String(CURSOR_VERSION)) {
    throw new InvalidCursorError('unknown version');
  }

  if (carried !== fingerprint) {
    throw new InvalidCursorError('issued for a different query');
  }

  const relevanceValue = Number(relevance);

  if (!Number.isInteger(relevanceValue)) {
    throw new InvalidCursorError('unreadable position');
  }

  const publishedValue = published === '-' ? null : Number(published);

  if (publishedValue !== null && !Number.isInteger(publishedValue)) {
    throw new InvalidCursorError('unreadable position');
  }

  const id = Buffer.from(externalId, 'base64url').toString('utf8');

  if (id === '') {
    throw new InvalidCursorError('unreadable position');
  }

  return {
    relevance: relevanceValue,
    publishedAtMs: publishedValue,
    externalId: id,
  };
}
