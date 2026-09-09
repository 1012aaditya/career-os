import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';
import { SupabaseClientService } from './supabase.client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * The authentication request path.
 *
 * WHY THIS FILE CHANGED. It carried two failures that PR-1 diagnosed as
 * stale test code rather than a production defect, and both diagnoses were
 * right: the spec constructed AuthService with one argument after the
 * class had grown a second, so `this.prisma` was undefined inside the test
 * only, and it asserted a message string that had drifted. PR-2 changes
 * AuthService itself - a bounded timeout and a provisioning cache - so the
 * spec had to be rewritten to cover the new behaviour, and the two stale
 * failures went with it. They were not fixed by being deleted: both
 * assertions they were making are still made below, against a service
 * constructed the way the container constructs it.
 *
 * The property this file really defends: the TOKEN CHECK is never cached.
 * Only the knowledge that a user row exists is, and a stale entry there
 * cannot let anybody in.
 */

const USER = { id: 'user-123', email: 'test@example.com' };

function makeSupabase(getUser: ReturnType<typeof vi.fn>): SupabaseClientService {
  return { client: { auth: { getUser } } } as unknown as SupabaseClientService;
}

function makePrisma() {
  const upsert = vi.fn().mockResolvedValue({ id: USER.id });

  return {
    service: { user: { upsert } } as unknown as PrismaService,
    upsert,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verifying a token', () => {
  it('returns the authenticated user for a valid token', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await expect(service.verifyAccessToken('valid-token')).resolves.toEqual(
      USER,
    );

    expect(getUser).toHaveBeenCalledWith('valid-token');
  });

  it('rejects an invalid token', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: null }, error: { message: 'bad' } });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await expect(
      service.verifyAccessToken('invalid-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    /* A rejected token provisions nothing. */
    expect(prisma.upsert).not.toHaveBeenCalled();
  });

  /*
   * The property the whole design turns on. Three requests, three checks -
   * there is no path by which a previously accepted token is trusted
   * without asking Supabase again.
   */
  it('checks every request against Supabase, never a cache', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await service.verifyAccessToken('t');
    await service.verifyAccessToken('t');
    await service.verifyAccessToken('t');

    expect(getUser).toHaveBeenCalledTimes(3);
  });

  /*
   * A token that was valid a moment ago and has since been revoked is
   * refused on the next request. This is the test that would fail first if
   * somebody ever "optimised" verification into a cache.
   */
  it('refuses a token the moment Supabase stops accepting it', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValueOnce({ data: { user: USER }, error: null })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'revoked' },
      });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await expect(service.verifyAccessToken('t')).resolves.toEqual(USER);
    await expect(service.verifyAccessToken('t')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('when Supabase Auth stops answering', () => {
  /*
   * Before PR-2 this call had no ceiling, so an Auth service that accepted
   * connections and never replied would hang every request to every route
   * for as long as it stayed that way.
   */
  it('gives up rather than hanging the request', async () => {
    vi.useFakeTimers();

    const getUser = vi.fn().mockReturnValue(new Promise(() => {}));
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);
    const assertion = expect(
      service.verifyAccessToken('t'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  /*
   * 503 and not 401, and the distinction is the point: nobody looked at
   * the token. Reporting a stalled dependency as "invalid token" sends a
   * user to re-authenticate over a problem that is not theirs, and hides
   * an outage behind a wall of plausible 401s.
   */
  it('does not report an outage as a rejected credential', async () => {
    vi.useFakeTimers();

    const getUser = vi.fn().mockReturnValue(new Promise(() => {}));
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);
    const assertion = expect(
      service.verifyAccessToken('t'),
    ).rejects.not.toBeInstanceOf(UnauthorizedException);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('provisions nothing when the check never completed', async () => {
    vi.useFakeTimers();

    const getUser = vi.fn().mockReturnValue(new Promise(() => {}));
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);
    const assertion = expect(service.verifyAccessToken('t')).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(prisma.upsert).not.toHaveBeenCalled();
  });
});

describe('provisioning the user row', () => {
  /* The write that used to happen on every authenticated request. */
  it('writes once and then stops, for repeated requests by one user', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await service.verifyAccessToken('t');
    await service.verifyAccessToken('t');
    await service.verifyAccessToken('t');

    expect(prisma.upsert).toHaveBeenCalledTimes(1);
  });

  it('provisions each user separately', async () => {
    const other = { id: 'user-456', email: 'other@example.com' };
    const getUser = vi
      .fn()
      .mockResolvedValueOnce({ data: { user: USER }, error: null })
      .mockResolvedValueOnce({ data: { user: other }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await service.verifyAccessToken('a');
    await service.verifyAccessToken('b');

    expect(prisma.upsert).toHaveBeenCalledTimes(2);
  });

  /*
   * The cache expires. Without expiry it would be a permanent assertion
   * that a row exists, and a row deleted underneath us - account deletion
   * is PR-3 - would never be re-created.
   */
  it('provisions again once the entry has expired', async () => {
    vi.useFakeTimers();

    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await service.verifyAccessToken('t');
    expect(prisma.upsert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    await service.verifyAccessToken('t');
    expect(prisma.upsert).toHaveBeenCalledTimes(2);
  });

  /*
   * The hook account deletion needs. Deleting a row without clearing this
   * would leave the process believing the user is provisioned, and the
   * next write on their behalf would fail on a foreign key.
   */
  it('can be told to forget a user', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await service.verifyAccessToken('t');
    service.forgetProvisioning(USER.id);
    await service.verifyAccessToken('t');

    expect(prisma.upsert).toHaveBeenCalledTimes(2);
  });

  it('forgetting an unknown user is harmless', () => {
    const service = new AuthService(makeSupabase(vi.fn()), makePrisma().service);

    expect(() => service.forgetProvisioning('nobody')).not.toThrow();
  });

  /*
   * A failed write must not be remembered as done. Recording it before it
   * succeeded would leave the user unprovisioned for the whole TTL while
   * every request believed otherwise.
   */
  it('does not remember a provisioning that failed', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: USER }, error: null });
    const prisma = makePrisma();

    prisma.upsert.mockRejectedValueOnce(new Error('database unavailable'));

    const service = new AuthService(makeSupabase(getUser), prisma.service);

    await expect(service.verifyAccessToken('t')).rejects.toThrow(
      'database unavailable',
    );

    await expect(service.verifyAccessToken('t')).resolves.toEqual(USER);
    expect(prisma.upsert).toHaveBeenCalledTimes(2);
  });
});
