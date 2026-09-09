/*
 * Where the Supabase session lives on the device.
 *
 * It lived in AsyncStorage, which is an unencrypted file inside the app
 * sandbox. That is fine for a remembered filter or a collapsed section; it
 * is not fine for a credential that grants access to somebody's resume and
 * employment history. On iOS an AsyncStorage value is readable from an
 * unencrypted device backup and from a compromised device; the Keychain
 * item this module writes instead is not.
 *
 * THE 2048-BYTE PROBLEM, which is the reason this file is more than three
 * lines. SecureStore stores small values - the platform limit is around
 * 2 KB per item, and a Supabase session is comfortably larger than that:
 * an access token, a refresh token, and a serialised user object. Writing
 * it whole either fails outright or, worse, fails silently on one platform
 * and works on another, which shows up as "users are randomly logged out".
 *
 * So a value is split into fixed-size chunks across numbered Keychain
 * items, with a small header recording how many there are. The header is
 * written LAST on save and FIRST on delete, so an interrupted write is
 * never mistaken for a complete one: a reader that finds no header reads
 * nothing, and a reader that finds a header can rely on every chunk it
 * names existing.
 */

import * as SecureStore from 'expo-secure-store';

/*
 * Comfortably under the platform limit. Not 2048: the key name, the
 * encoding overhead and the platform's own bookkeeping all consume part of
 * the budget, and a chunk that is nearly exactly at the limit is one
 * encoding change away from failing on a user's phone rather than in a
 * test.
 */
const CHUNK_SIZE = 1536;

/**
 * A ceiling on how many chunks one value may occupy.
 *
 * At 1.5 KB each this is 48 KB, far more than any session, and it exists
 * so that a corrupted header can never send the reader into a long loop of
 * Keychain calls on a cold start.
 */
const MAX_CHUNKS = 32;

/**
 * SecureStore keys must be alphanumeric plus `.`, `-` and `_`. Supabase's
 * own storage keys contain none of those problems today, but they are
 * derived from a project URL and are not ours to promise about - so every
 * key is normalised rather than trusted.
 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function headerKey(key: string): string {
  return `${safeKey(key)}.meta`;
}

function chunkKey(key: string, index: number): string {
  return `${safeKey(key)}.${index}`;
}

/**
 * Reads a value, or null.
 *
 * Returns null rather than throwing for every failure mode - no header, a
 * malformed header, a missing chunk, a Keychain error. A session that
 * cannot be read means the user signs in again, which is a minor
 * annoyance; an exception thrown out of the Supabase client's storage
 * adapter during startup means the app does not open.
 */
export async function getItem(key: string): Promise<string | null> {
  try {
    const header = await SecureStore.getItemAsync(headerKey(key));

    if (header === null) {
      return null;
    }

    const count = Number(header);

    if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
      /* A header we cannot trust. Clear it rather than leave it to fail
       * again on every future launch. */
      await removeItem(key);
      return null;
    }

    const parts: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, index));

      if (part === null) {
        /*
         * The header promised a chunk that is not there - an interrupted
         * write, or a partial platform failure. A truncated session is
         * worse than no session: it would deserialise into something the
         * client might treat as valid.
         */
        await removeItem(key);
        return null;
      }

      parts.push(part);
    }

    return parts.join('');
  } catch {
    return null;
  }
}

/**
 * Writes a value, splitting it across as many items as it needs.
 *
 * The old chunks are removed first, so shrinking a value cannot leave a
 * tail of stale chunks that a later, larger header would happily read back
 * as part of a different session.
 */
export async function setItem(key: string, value: string): Promise<void> {
  try {
    await removeItem(key);

    const chunks: string[] = [];

    for (let index = 0; index < value.length; index += CHUNK_SIZE) {
      chunks.push(value.slice(index, index + CHUNK_SIZE));
    }

    if (chunks.length === 0) {
      /* An empty string is a real value, and it still needs one chunk so
       * that reading it back returns '' rather than null. */
      chunks.push('');
    }

    if (chunks.length > MAX_CHUNKS) {
      /*
       * Refused rather than truncated. Storing part of a session would
       * produce exactly the corrupted state the reader above works to
       * detect, and there is no session this large that is legitimate.
       */
      return;
    }

    for (const [index, chunk] of chunks.entries()) {
      await SecureStore.setItemAsync(chunkKey(key, index), chunk);
    }

    /*
     * LAST. Until this line there is no header, so a reader sees nothing
     * and the write is atomic from its point of view.
     */
    await SecureStore.setItemAsync(headerKey(key), String(chunks.length));
  } catch {
    /*
     * Swallowed deliberately, and it is the right call here: this is
     * called by the Supabase client on every token refresh, and throwing
     * would surface a Keychain hiccup as a crash in the middle of an
     * otherwise working session. The cost of a failed write is that the
     * user signs in again next launch.
     */
  }
}

/**
 * Removes a value and every chunk it occupies.
 *
 * The header goes FIRST, so an interrupted delete leaves chunks that no
 * reader will ever assemble - orphaned bytes rather than a readable
 * session that was supposed to be gone. This is what makes sign-out safe
 * even if the process dies halfway through it.
 */
export async function removeItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(headerKey(key));

    for (let index = 0; index < MAX_CHUNKS; index += 1) {
      await SecureStore.deleteItemAsync(chunkKey(key, index));
    }
  } catch {
    /* Same reasoning as setItem: a failed delete must not crash sign-out. */
  }
}

/**
 * The adapter object the Supabase client expects.
 *
 * Shaped exactly like the AsyncStorage interface it replaces, so nothing
 * at the call site changes.
 */
export const secureSessionStorage = {
  getItem,
  setItem,
  removeItem,
};
