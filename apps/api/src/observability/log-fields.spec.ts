import { describe, expect, it } from 'vitest';

import {
  ALLOWED_LOG_FIELDS,
  describeError,
  pseudonymize,
  safeFields,
  safeRequestId,
  safeRoute,
} from './log-fields.js';

/*
 * What may reach a log line.
 *
 * This is the security core of PR-5, so most of what is asserted here is
 * about what does NOT come out. The design is an allowlist rather than a
 * denylist, and the tests are written to fail if that is ever inverted:
 * several of them pass an object stuffed with the exact fields a real leak
 * would carry - a bearer token, a session, a resume path - and assert the
 * output is empty.
 */

describe('the allowlist itself', () => {
  /*
   * Pinned as a list. Adding a field is the moment to ask whether its
   * value can identify a person or authenticate as one, and that question
   * should be asked in a review with this diff in front of you.
   */
  it('is exactly these fields', () => {
    expect([...ALLOWED_LOG_FIELDS].sort()).toEqual([
      'actor',
      'dependency',
      'dependencyStatus',
      'durationMs',
      'environment',
      'errorCategory',
      'errorClass',
      'errorCode',
      'event',
      'method',
      'operation',
      'outcome',
      'provider',
      'requestId',
      'route',
      'service',
      'statusCode',
    ]);
  });

  /* The names a leak would use are not among them. */
  it.each([
    'userId',
    'email',
    'token',
    'accessToken',
    'authorization',
    'password',
    'body',
    'session',
    'fileName',
    'storagePath',
    'message',
    'stack',
    'query',
    'params',
  ])('does not allow %s', (field) => {
    expect([...ALLOWED_LOG_FIELDS]).not.toContain(field);
  });
});

describe('filtering the fields of a log line', () => {
  it('keeps allowed primitives', () => {
    expect(
      safeFields({
        requestId: 'abc',
        statusCode: 200,
        durationMs: 12,
        outcome: 'ok',
      }),
    ).toEqual({
      requestId: 'abc',
      statusCode: 200,
      durationMs: 12,
      outcome: 'ok',
    });
  });

  /*
   * THE test. Everything a real leak would carry, passed in at once, and
   * the output is empty. If the model were ever inverted to "strip a few
   * known-bad keys", this is what would start passing things through.
   */
  it('drops every field it was not told to keep', () => {
    expect(
      safeFields({
        authorization: 'Bearer eyJhbGciOi.reallylongtoken.signature',
        accessToken: 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
        refreshToken: 'refresh-me',
        password: 'hunter2',
        email: 'jane@example.com',
        userId: '11111111-1111-4111-8111-111111111111',
        fileName: 'Jane Doe Resume.pdf',
        storagePath: 'user-1/import-1/Jane_Doe_Resume.pdf',
        DATABASE_URL: 'postgresql://u:p@host/db',
        body: { resume: 'contents' },
      }),
    ).toEqual({});
  });

  /*
   * The shape a careless caller actually uses - spreading an error, a
   * request or a session into a log call. Nested objects are dropped
   * whatever their key, which is what stops one innocent-looking field
   * from carrying an entire provider response.
   */
  it('drops nested objects even under an allowed name', () => {
    expect(
      safeFields({
        requestId: 'abc',
        provider: { name: 'github', token: 'secret' },
        operation: ['sync'],
      }),
    ).toEqual({ requestId: 'abc' });
  });

  it('drops undefined, functions and symbols', () => {
    expect(
      safeFields({
        requestId: undefined,
        route: () => '/x',
        method: Symbol('GET'),
      }),
    ).toEqual({});
  });

  it('keeps an explicit null, which means "known to be absent"', () => {
    expect(safeFields({ errorCode: null })).toEqual({ errorCode: null });
  });

  /*
   * A long value is either a mistake - somebody pasting a body in - or an
   * attempt to bury other lines. Truncation is visible so a reader can
   * tell a cut value from a short one.
   */
  it('truncates a long value and says so', () => {
    const result = safeFields({ route: 'x'.repeat(1000) });

    expect(String(result.route).length).toBeLessThan(300);
    expect(String(result.route)).toContain('[truncated]');
  });

  it('does not emit NaN or Infinity, which read as missing in JSON', () => {
    expect(safeFields({ durationMs: Number.NaN })).toEqual({ durationMs: null });
    expect(safeFields({ durationMs: Number.POSITIVE_INFINITY })).toEqual({
      durationMs: null,
    });
  });
});

describe('pseudonymising a user', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  /* Stable, so "the same person again" is answerable. */
  it('is stable for the same id and salt', () => {
    expect(pseudonymize(USER, 'salt')).toBe(pseudonymize(USER, 'salt'));
  });

  it('differs between users', () => {
    expect(pseudonymize(USER, 'salt')).not.toBe(
      pseudonymize('22222222-2222-4222-8222-222222222222', 'salt'),
    );
  });

  /*
   * A pseudonym from staging must say nothing about production, so the
   * same id under a different salt is a different value.
   */
  it('differs between deployments', () => {
    expect(pseudonymize(USER, 'staging')).not.toBe(
      pseudonymize(USER, 'production'),
    );
  });

  /* And it is not the id, nor anything containing it. */
  it('does not contain the id it stands for', () => {
    const pseudonym = pseudonymize(USER, 'salt');

    expect(pseudonym).not.toContain(USER);
    expect(pseudonym).not.toContain('1111');
    expect(pseudonym).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('reducing an error to what is safe to record', () => {
  /*
   * THE most important assertion in the file. A message is where a
   * provider writes a bucket name, a tenant id, or - for a connection
   * failure - the connection string.
   */
  it('never carries the message', () => {
    const error = new Error(
      'connect ECONNREFUSED postgresql://user:hunter2@db.example.com:5432/prod',
    );

    const shape = describeError(error);

    expect(JSON.stringify(shape)).not.toContain('hunter2');
    expect(JSON.stringify(shape)).not.toContain('db.example.com');
    expect(Object.keys(shape).sort()).toEqual([
      'errorCategory',
      'errorClass',
      'errorCode',
    ]);
  });

  it('keeps the class, which is the useful part', () => {
    class GithubApiError extends Error {}

    expect(describeError(new GithubApiError('x')).errorClass).toBe(
      'GithubApiError',
    );
  });

  /*
   * P2028 is the transaction-start timeout PR-4 found against the Sydney
   * pooler. Categorising it as 'database' rather than 'internal' is what
   * makes it alertable separately from a bug in our own code.
   */
  it('categorises a Prisma code as a database failure', () => {
    const error = Object.assign(new Error('tx failed'), { code: 'P2028' });

    expect(describeError(error)).toMatchObject({
      errorCode: 'P2028',
      errorCategory: 'database',
    });
  });

  it('categorises a connection refusal as a dependency failure', () => {
    const error = Object.assign(new Error('nope'), { code: 'ECONNREFUSED' });

    expect(describeError(error).errorCategory).toBe('dependency');
  });

  /*
   * A `code` that is not token-shaped is something else wearing the name -
   * a message, a URL, a payload - and is dropped rather than trusted.
   */
  it('refuses a code that is really a message', () => {
    const error = Object.assign(new Error('x'), {
      code: 'failed to connect to postgresql://user:hunter2@host/db',
    });

    expect(describeError(error).errorCode).toBeNull();
  });

  it('handles a thrown non-error without crashing', () => {
    expect(describeError('a string')).toMatchObject({ errorClass: 'string' });
    expect(describeError(null)).toMatchObject({ errorClass: 'object' });
  });
});

describe('masking a route', () => {
  /*
   * `/v1/resume-imports/8f3a…/file` names one person's document;
   * `/v1/resume-imports/:id/file` names an endpoint. Only the second
   * belongs in a log.
   */
  it('replaces a uuid with a placeholder', () => {
    expect(
      safeRoute('/v1/resume-imports/8f3a1b2c-1111-4111-8111-9d3a18eeffd3/file'),
    ).toBe('/v1/resume-imports/:id/file');
  });

  it('replaces numeric and long opaque segments', () => {
    expect(safeRoute('/v1/market/postings/12345')).toBe(
      '/v1/market/postings/:id',
    );
    expect(safeRoute(`/v1/thing/${'a'.repeat(64)}`)).toBe('/v1/thing/:id');
  });

  it('drops the query string, where the filters and tokens are', () => {
    expect(safeRoute('/v1/market/search?q=nurse&token=secret')).toBe(
      '/v1/market/search',
    );
  });

  it('leaves an ordinary route alone', () => {
    expect(safeRoute('/v1/career-graph')).toBe('/v1/career-graph');
  });
});

describe('accepting a client correlation id', () => {
  it('accepts a sane one so a trace can cross systems', () => {
    expect(safeRequestId('abc123-DEF_456')).toBe('abc123-DEF_456');
  });

  /*
   * The value is written into every log line this request produces. An
   * unvalidated one is a newline injection that forges log entries.
   */
  it('refuses one carrying a newline', () => {
    expect(safeRequestId('abc12345\n{"level":"info","event":"forged"}')).toBeNull();
  });

  it('refuses padding, punctuation and the wrong type', () => {
    expect(safeRequestId('x'.repeat(500))).toBeNull();
    expect(safeRequestId('short')).toBeNull();
    expect(safeRequestId('has spaces here')).toBeNull();
    expect(safeRequestId(42)).toBeNull();
    expect(safeRequestId(undefined)).toBeNull();
  });
});
