import { describe, expect, it } from 'vitest';

import {
  failureMessage,
  isMutating,
  isRetryable,
  mayRetryAutomatically,
  REQUEST_TIMEOUT_MS,
  type FailureKind,
} from './request-policy';

/*
 * What the app waits for, and what it is willing to repeat.
 *
 * The rule worth defending here is the one that is easy to get backwards:
 * a timeout means we stopped listening, NOT that the request did not
 * happen. So a DELETE that timed out may already have succeeded, and
 * anything that retries it automatically can delete twice.
 */

describe('the timeout', () => {
  it('is bounded and reasonable for a mobile connection', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

describe('which requests change something', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s mutates',
    (method) => {
      expect(isMutating(method)).toBe(true);
    },
  );

  it('GET does not', () => {
    expect(isMutating('GET')).toBe(false);
  });
});

describe('what may be retried automatically', () => {
  /*
   * THE test in this file. Both destructive endpoints PR-3 added are
   * DELETEs, and an automatic retry of either would race an operation that
   * may already have succeeded.
   */
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'never repeats a %s on its own',
    (method) => {
      expect(mayRetryAutomatically(method)).toBe(false);
    },
  );

  it('would allow a GET, which is safe by definition', () => {
    expect(mayRetryAutomatically('GET')).toBe(true);
  });
});

describe('what a person is told', () => {
  it('explains an expired session without blaming the network', () => {
    expect(failureMessage('unauthenticated')).toMatch(/session/i);
    expect(failureMessage('unauthenticated')).toMatch(/sign in/i);
  });

  it('distinguishes a timeout from being offline', () => {
    expect(failureMessage('timeout')).not.toBe(failureMessage('offline'));
    expect(failureMessage('timeout')).toMatch(/too long/i);
    expect(failureMessage('offline')).toMatch(/connection/i);
  });

  /*
   * A 4xx body is a refusal the API wrote for a user, and PR-3 made those
   * safe. Passing it through is better than replacing it with something
   * generic.
   */
  it('uses the server sentence when there is one', () => {
    expect(failureMessage('server', 'You already have 3 imports in progress')).toBe(
      'You already have 3 imports in progress',
    );
  });

  it('falls back when the server said nothing useful', () => {
    for (const empty of ['', '   ', undefined]) {
      expect(failureMessage('server', empty)).toBe(
        'Something went wrong. Please try again.',
      );
    }
  });

  /*
   * No status codes, no hostnames, no provider names. These strings are
   * rendered to a person holding a phone.
   */
  it.each([
    'unauthenticated',
    'timeout',
    'offline',
    'server',
    'unknown',
  ] as FailureKind[])('says nothing technical for %s', (kind) => {
    const message = failureMessage(kind);

    expect(message).not.toMatch(/\b[45]\d\d\b/);
    expect(message).not.toMatch(/http|fetch|supabase|token|api\./i);
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('whether to offer a retry button', () => {
  /*
   * Retrying an expired session sends the same dead token again and fails
   * identically. The app signs the user out instead, and a retry button
   * beside that would be a button that cannot work.
   */
  it('does not offer one for an expired session', () => {
    expect(isRetryable('unauthenticated')).toBe(false);
  });

  it.each(['timeout', 'offline', 'server', 'unknown'] as FailureKind[])(
    'offers one for %s',
    (kind) => {
      expect(isRetryable(kind)).toBe(true);
    },
  );
});
