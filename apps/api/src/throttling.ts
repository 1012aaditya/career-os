import type { ThrottlerOptions } from '@nestjs/throttler';

import { currentEnvironment } from './environment.js';

/*
 * Request limits, in one place with their reasons.
 *
 * PR-1 found no rate limiting anywhere. The consequence that mattered most
 * was not user-facing abuse but a credential: `/v1/resume-processing/*` is
 * protected by a single long-lived shared secret and nothing bounded how
 * many guesses a caller could make.
 *
 * TWO PRINCIPLES SHAPE THE NUMBERS.
 *
 * First, a limit that stops a real user is a bug, not a security control.
 * The default tier is deliberately generous - it exists to bound a loop,
 * not to police normal use. A person tapping through the app quickly, or a
 * screen that fires several requests on mount, must never see a 429.
 *
 * Second, the expensive and the credential-guarded routes get their own,
 * tighter tiers, because those are the ones where the cost of an
 * unbounded caller is real: storage objects, database rows, and attempts
 * at a secret.
 *
 * WHAT THIS DOES NOT DO. The store is in-memory and per-process, so the
 * effective limit is multiplied by the instance count. It also keys on IP,
 * which behind a load balancer means the limit is only as good as the
 * proxy configuration - `trust proxy` and a shared store are both PR-6,
 * because both are decisions about a deployment that does not exist yet.
 * Stated here rather than discovered later.
 */

/** The tier every route gets unless it asks for another. */
export const DEFAULT_THROTTLE_TTL_MS = 60_000;
export const DEFAULT_THROTTLE_LIMIT = 300;

/**
 * Resume import creation: 10 per 10 minutes.
 *
 * Deliberately far tighter than the default, because each call mints a
 * storage upload URL and writes a row. It sits comfortably above the
 * per-user policy ceiling in upload-policy.ts (20 per hour), so the two
 * limits do not fight: this one bounds an anonymous flood by address, that
 * one bounds a single authenticated user, and a normal person hits
 * neither.
 */
export const IMPORT_THROTTLE_TTL_MS = 600_000;
export const IMPORT_THROTTLE_LIMIT = 10;

/**
 * Worker endpoints: 120 per minute.
 *
 * Sized from the worker's real behaviour rather than from a feeling. A
 * polling worker asking for work once a second is 60/min; doubling that
 * leaves room for a second worker process and for the claim/complete pair
 * without ever throttling legitimate work. Against a caller guessing the
 * shared secret it turns an unbounded search into 120 attempts a minute
 * per address, which combined with a properly generated secret is not a
 * search anybody finishes.
 */
export const WORKER_THROTTLE_TTL_MS = 60_000;
export const WORKER_THROTTLE_LIMIT = 120;

/**
 * The default tier, raised out of the way under NODE_ENV=test.
 *
 * The counter is in-memory and per PROCESS, and the hermetic suite runs
 * many controller specs in one process against the same synthetic client
 * address - so their requests all land in one bucket. At 300/min that
 * bucket fills, and a test asserting a 404 gets a 429 instead. It showed
 * up exactly as it would in the wild: intermittently, in whichever spec
 * happened to run last.
 *
 * Raised rather than disabled, so the guard is still mounted and still in
 * the request path during tests - a limit nobody reaches is a different
 * thing from a guard that is not there, and only the first keeps the
 * wiring under test.
 *
 * This is a test-environment concern, not a production one. The real
 * per-process limitation is unchanged and still belongs to PR-6, which
 * owns the shared store.
 */
function defaultLimit(): number {
  /*
   * Through currentEnvironment() rather than process.env directly, so
   * configuration reads stay in the one file the security boundary spec
   * permits them in - which is the check that caught this the first time.
   */
  return currentEnvironment() === 'test'
    ? 1_000_000
    : DEFAULT_THROTTLE_LIMIT;
}

export const THROTTLE_TIERS: ThrottlerOptions[] = [
  {
    name: 'default',
    ttl: DEFAULT_THROTTLE_TTL_MS,
    limit: defaultLimit(),
  },
];

/** Applied with @Throttle on the routes named above. */
export const IMPORT_THROTTLE = {
  default: { ttl: IMPORT_THROTTLE_TTL_MS, limit: IMPORT_THROTTLE_LIMIT },
};

/**
 * Account deletion: 5 per hour.
 *
 * Not a route anybody calls repeatedly in normal use, and an expensive one
 * - it walks a storage prefix and cascades a dozen tables. Five leaves
 * room for a user retrying after a network failure, which is the only
 * legitimate reason to call it twice.
 */
export const ACCOUNT_DELETION_THROTTLE = {
  default: { ttl: 3_600_000, limit: 5 },
};

export const WORKER_THROTTLE = {
  default: { ttl: WORKER_THROTTLE_TTL_MS, limit: WORKER_THROTTLE_LIMIT },
};
