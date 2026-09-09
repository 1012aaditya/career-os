import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Where the Supabase session lives on the device.
 *
 * The reason this module exists at all is the 2 KB Keychain item limit: a
 * Supabase session - access token, refresh token, serialised user - is
 * larger than one item, so writing it whole either fails or, worse,
 * succeeds on one platform and not another. That shows up as "users are
 * randomly signed out", which is the kind of bug nobody traces back to
 * storage.
 *
 * So the tests below are mostly about the chunking: that a large value
 * survives a round trip, that a partial write is never read back as a
 * whole one, and that shrinking a value cannot leave a tail of stale
 * chunks behind.
 */

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

const { getItem, setItem, removeItem } = await import(
  './secure-session-storage'
);
const SecureStore = await import('expo-secure-store');

const KEY = 'sb-project-auth-token';

/** A realistic session: two JWTs and a user object, comfortably over 2 KB. */
const SESSION = JSON.stringify({
  access_token: `header.${'a'.repeat(1400)}.signature`,
  refresh_token: 'r'.repeat(64),
  expires_at: 1893456000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'x@example.com' },
});

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();

  /*
   * Implementations are restored, not merely cleared. `clearAllMocks`
   * resets call history and leaves `mockRejectedValue` in place, so the
   * Keychain-failure tests below would leak a permanently rejecting mock
   * into every test that ran after them - and a later test asserting
   * "the value round-trips" would be silently asserting nothing.
   */
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => store.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(
    async (key: string, value: string) => {
      store.set(key, value);
    },
  );
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(
    async (key: string) => {
      store.delete(key);
    },
  );
});

describe('a round trip', () => {
  it('returns exactly what was written', async () => {
    await setItem(KEY, SESSION);

    await expect(getItem(KEY)).resolves.toBe(SESSION);
  });

  it('returns null for a key that was never written', async () => {
    await expect(getItem(KEY)).resolves.toBeNull();
  });

  it('survives a value far larger than one Keychain item', async () => {
    const big = 'x'.repeat(20_000);

    await setItem(KEY, big);

    await expect(getItem(KEY)).resolves.toBe(big);
  });

  it('handles an empty string as a value rather than as absence', async () => {
    await setItem(KEY, '');

    await expect(getItem(KEY)).resolves.toBe('');
  });

  it('handles unicode without corrupting it at a chunk boundary', async () => {
    const value = '日本語のテキスト'.repeat(400);

    await setItem(KEY, value);

    await expect(getItem(KEY)).resolves.toBe(value);
  });
});

describe('the chunking itself', () => {
  it('actually splits a session across several items', async () => {
    await setItem(KEY, SESSION);

    /* Not one item: the whole point is that a session does not fit in one. */
    expect(store.size).toBeGreaterThan(2);
    expect(store.has(`${KEY}.meta`)).toBe(true);
    expect(store.has(`${KEY}.0`)).toBe(true);
  });

  /*
   * The header is written LAST, so a write interrupted partway leaves no
   * header - and a reader that finds no header reads nothing rather than
   * assembling half a session.
   */
  it('is not readable when the header never landed', async () => {
    await setItem(KEY, SESSION);
    store.delete(`${KEY}.meta`);

    await expect(getItem(KEY)).resolves.toBeNull();
  });

  /*
   * The opposite failure: a header promising chunks that are not there.
   * A truncated session is worse than none - it could deserialise into
   * something the client treats as a valid credential.
   */
  it('refuses to assemble a session with a missing chunk', async () => {
    await setItem(KEY, SESSION);
    store.delete(`${KEY}.1`);

    await expect(getItem(KEY)).resolves.toBeNull();
  });

  it('clears a corrupted entry rather than failing on it forever', async () => {
    await setItem(KEY, SESSION);
    store.set(`${KEY}.meta`, 'not-a-number');

    await expect(getItem(KEY)).resolves.toBeNull();
    /* And the wreckage is gone, so the next launch is not slowed by it. */
    await expect(getItem(KEY)).resolves.toBeNull();
    expect(store.has(`${KEY}.meta`)).toBe(false);
  });

  it.each(['0', '-1', '999'])(
    'refuses an out-of-range chunk count of %s',
    async (count) => {
      await setItem(KEY, SESSION);
      store.set(`${KEY}.meta`, count);

      await expect(getItem(KEY)).resolves.toBeNull();
    },
  );

  /*
   * Shrinking a value must not leave a tail. Without clearing first, a
   * later larger header could read stale chunks from a previous session
   * as part of the current one - which is a credential-mixing bug.
   */
  it('leaves no stale chunks when a value shrinks', async () => {
    await setItem(KEY, 'y'.repeat(10_000));
    await setItem(KEY, 'small');

    await expect(getItem(KEY)).resolves.toBe('small');
    expect(store.has(`${KEY}.5`)).toBe(false);
  });
});

describe('signing out', () => {
  it('removes the value', async () => {
    await setItem(KEY, SESSION);
    await removeItem(KEY);

    await expect(getItem(KEY)).resolves.toBeNull();
  });

  it('removes every chunk, not only the header', async () => {
    await setItem(KEY, SESSION);
    await removeItem(KEY);

    expect(store.size).toBe(0);
  });

  it('is safe on a key that was never written', async () => {
    await expect(removeItem(KEY)).resolves.toBeUndefined();
  });

  /*
   * The header is deleted FIRST, so an interrupted sign-out leaves
   * orphaned bytes rather than a readable session that was meant to be
   * gone. Asserted by checking the call order.
   */
  it('deletes the header before the chunks', async () => {
    await setItem(KEY, SESSION);
    vi.clearAllMocks();

    await removeItem(KEY);

    const deleted = vi
      .mocked(SecureStore.deleteItemAsync)
      .mock.calls.map((call) => call[0]);

    expect(deleted[0]).toBe(`${KEY}.meta`);
  });
});

describe('when the Keychain itself fails', () => {
  /*
   * A read failure means the user signs in again. An exception thrown out
   * of the storage adapter during startup means the app does not open, so
   * every path here degrades rather than throws.
   */
  it('reads as absent rather than crashing the app', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error('keychain unavailable'),
    );

    await expect(getItem(KEY)).resolves.toBeNull();
  });

  it('does not throw out of a failed write', async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(
      new Error('keychain unavailable'),
    );

    await expect(setItem(KEY, SESSION)).resolves.toBeUndefined();
  });

  it('does not throw out of a failed sign-out', async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(
      new Error('keychain unavailable'),
    );

    await expect(removeItem(KEY)).resolves.toBeUndefined();
  });
});

describe('key names', () => {
  /*
   * SecureStore keys must be alphanumeric plus . - _ . Supabase derives
   * its storage key from a project URL, which is not ours to promise
   * about, so every key is normalised rather than trusted.
   */
  it('normalises a key containing characters the Keychain refuses', async () => {
    await setItem('sb:project/auth token', 'value');

    for (const key of store.keys()) {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    }

    await expect(getItem('sb:project/auth token')).resolves.toBe('value');
  });
});
