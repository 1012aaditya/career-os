import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from './supabase.client.js';

export type AuthenticatedUser = {
  id: string;
  email?: string;
};

/*
 * Verifying a bearer token, and provisioning the user row behind it.
 *
 * These are two different jobs that used to happen unconditionally on
 * every single authenticated request: a network round trip to Supabase
 * Auth, followed by a database write. PR-1 flagged the pair - an external
 * dependency with no timeout on the hot path of every route, plus an
 * upsert on every read.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT.
 *
 * The token check still happens on every request, against Supabase, every
 * time. It is not cached, not memoised, and not replaced with local JWT
 * verification. Local verification is the obvious "faster" answer and it
 * is refused here for a specific reason rather than a cautious one: it
 * requires knowing whether this project signs with a legacy shared HS256
 * secret or with an asymmetric key served from JWKS, and getting that
 * wrong does not fail loudly - it fails by accepting tokens it should not.
 * That is a change to make deliberately, with the project's signing
 * configuration in front of you, not as a performance tweak. PR-3 owns it.
 *
 * What IS cached is the fact that a user row has already been provisioned.
 * That is not a security decision - it is a data-sync side effect, and a
 * stale entry cannot grant access to anything. The token still has to pass
 * on its own merits before the cache is ever consulted.
 *
 * And the Supabase call is now bounded. Without a timeout, an Auth service
 * that accepted connections and stopped answering would hang every request
 * to every route for as long as it stayed that way.
 */

/**
 * How long we remember that a user row exists.
 *
 * Five minutes is short enough that a row deleted underneath us - account
 * deletion is PR-3 - is re-provisioned rather than assumed away for the
 * life of the process, and long enough that a normally active session
 * costs one upsert rather than one per request.
 */
const PROVISIONING_TTL_MS = 5 * 60 * 1000;

/**
 * A ceiling on the cache, so it cannot become an unbounded map keyed by
 * anything an attacker can mint. Entries are cheap - a uuid and a number -
 * so this is generous; the point is that it is finite.
 */
const PROVISIONING_MAX_ENTRIES = 10_000;

/**
 * How long we wait for Supabase Auth before giving up on one request.
 *
 * Five seconds is far longer than a healthy verification and short enough
 * that a stalled Auth service degrades into fast 503s rather than a pile
 * of hung requests holding connections and sockets.
 */
const VERIFY_TIMEOUT_MS = 5_000;

/** Distinguishes a timeout from every other rejection, without leaking one. */
const TIMED_OUT = Symbol('auth.verify.timeout');

@Injectable()
export class AuthService {
  /** userId -> the instant its provisioning may no longer be assumed. */
  private readonly provisionedUntil = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseClientService,
    private readonly prisma: PrismaService,
  ) {}

  async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser> {
    const result = await this.getUserWithTimeout(accessToken);

    if (result === TIMED_OUT) {
      /*
       * 503, not 401. The token was not rejected - nobody looked at it.
       * Reporting an upstream stall as "invalid token" would send a user
       * to re-authenticate over a problem that has nothing to do with
       * their credentials, and would hide an Auth outage behind a wall of
       * plausible-looking 401s.
       */
      throw new ServiceUnavailableException(
        'Authentication is temporarily unavailable',
      );
    }

    const { data, error } = result;
    const user = data?.user;

    if (error || !user) {
      throw new UnauthorizedException('Invalid access token');
    }

    await this.ensureProvisioned(user.id);

    return {
      id: user.id,
      email: user.email,
    };
  }

  /**
   * Forgets a cached provisioning fact.
   *
   * Exists for account deletion, which PR-3 owns: deleting the row without
   * clearing this would leave a process believing the user is provisioned
   * for up to the TTL, and the next write on their behalf would fail on a
   * foreign key. Safe to call for a user that was never cached.
   */
  forgetProvisioning(userId: string): void {
    this.provisionedUntil.delete(userId);
  }

  /**
   * The Supabase call, with a ceiling on how long it may take.
   *
   * The timer is always cleared, including on the success path - an
   * uncleared five-second timer per request keeps the event loop alive and
   * makes shutdown wait for work nobody is expecting.
   */
  private async getUserWithTimeout(
    accessToken: string,
  ): Promise<
    | typeof TIMED_OUT
    | Awaited<ReturnType<SupabaseClientService['client']['auth']['getUser']>>
  > {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.supabase.client.auth.getUser(accessToken),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), VERIFY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Makes sure the user has a row, at most once per TTL per process.
   *
   * The upsert itself is unchanged and still idempotent; what changed is
   * how often it runs. On a cache miss the write happens first and the
   * entry is recorded only after it succeeds, so a failed upsert is
   * retried on the next request rather than being remembered as done.
   */
  private async ensureProvisioned(userId: string): Promise<void> {
    const now = Date.now();
    const until = this.provisionedUntil.get(userId);

    if (until !== undefined && until > now) {
      return;
    }

    await this.prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
    });

    this.rememberProvisioned(userId, now);
  }

  private rememberProvisioned(userId: string, now: number): void {
    /*
     * Expired entries are swept before the size rule is applied, so a
     * long-running process with heavy churn reclaims naturally and only
     * genuinely live entries are ever evicted.
     */
    if (this.provisionedUntil.size >= PROVISIONING_MAX_ENTRIES) {
      for (const [key, expiry] of this.provisionedUntil) {
        if (expiry <= now) {
          this.provisionedUntil.delete(key);
        }
      }
    }

    /*
     * Still full after the sweep: drop the oldest insertion, which a Map
     * gives us in iteration order for free. Evicting only costs the
     * evicted user one extra upsert on their next request.
     */
    if (this.provisionedUntil.size >= PROVISIONING_MAX_ENTRIES) {
      const oldest = this.provisionedUntil.keys().next();

      if (!oldest.done) {
        this.provisionedUntil.delete(oldest.value);
      }
    }

    this.provisionedUntil.set(userId, now + PROVISIONING_TTL_MS);
  }
}
