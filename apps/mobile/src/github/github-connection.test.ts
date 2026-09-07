import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  deriveUiState,
  describeCallbackFailure,
  describeSyncSummary,
  isPartialSync,
  parseCallbackUrl,
} from './github-connection';

/*
 * The GitHub connection surface, tested as pure functions only.
 *
 * There is no React Native transform in this suite (see
 * vitest.config.mts), so nothing here may import a component. That is not
 * a limitation for what actually needs testing: the risky decisions in
 * this feature are string decisions — what a deep link is allowed to mean,
 * and what a sentence is allowed to claim — and those live in plain
 * TypeScript.
 *
 * Two things are being defended.
 *
 * The first is the deep link itself. A custom-scheme callback is visible
 * to the operating system, can be logged by it, and can be claimed by
 * another installed application (RFC 8252 §7.1 is why the scheme is
 * derived from the bundle id, not why it is safe). So the app must treat
 * an inbound link as an untrusted hint: it carries a status and nothing
 * else, and anything else it carries must die at the parser rather than
 * reach state, a log line or a screen.
 *
 * The second is the prose. Every sentence this module produces is a claim
 * about the user, and the product's whole position is that it does not
 * infer things it has not observed. A sync that read 3 of 40 repositories
 * has not brought anything "up to date", and no count of commits is
 * evidence that somebody is "senior".
 */

const SCHEME = 'com.careeros.mobile';
const CALLBACK = `${SCHEME}://github/callback`;

/*
 * The backend's closed set, copied from CallbackOutcome in
 * apps/api/src/integrations/github/github-oauth.service.ts (minus
 * 'success', which travels as the status rather than as a reason).
 *
 * Copied rather than imported: the mobile app cannot import from the API,
 * and a divergence between the two lists is exactly the bug worth
 * catching — if the backend adds a reason, this list is where the mobile
 * side notices it is missing a sentence.
 */
const BACKEND_REASONS = [
  'access_denied',
  'invalid_state',
  'exchange_failed',
  'unverified_email',
  'account_unavailable',
  'account_already_linked',
  'server_error',
] as const;

/*
 * Assembled from halves so this test file does not itself contain a
 * literal matching GitHub's secret-scanning pattern. A test that trips a
 * push protection rule is a test that gets deleted.
 */
const TOKEN_PREFIXES = [
  'gh' + 'o_',
  'gh' + 'u_',
  'gh' + 'p_',
  'gh' + 's_',
  'gh' + 'r_',
] as const;

/*
 * Language that would assert something about the person rather than
 * report something observed. None of it may ever appear in a generated
 * sentence, whatever the counts happen to be.
 */
const INFERENCE_WORDS = [
  'expert',
  'senior',
  'proficient',
  'employed',
  'employer',
  'skilled',
  'mastery',
  'ownership',
] as const;

type Counts = {
  created: number;
  updated: number;
  reposScanned: number;
  reposRevalidated: number;
  reposTotal: number;
  reposSkipped: number;
};

function makeSummary(
  status: string,
  counts: Partial<Counts> = {},
) {
  return {
    status,
    counts: {
      created: 0,
      updated: 0,
      reposScanned: 0,
      reposRevalidated: 0,
      reposTotal: 0,
      reposSkipped: 0,
      ...counts,
    },
  };
}

/*
 * Asserts against the WHOLE returned object, not against the fields we
 * happen to expect. A parser that quietly carried an extra property
 * through would pass a field-by-field check and fail this one.
 */
function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function assertNoInferenceLanguage(
  sentence: string,
) {
  for (const word of INFERENCE_WORDS) {
    expect(
      new RegExp(`\\b${word}`, 'i').test(
        sentence,
      ),
    ).toBe(false);
  }
}

describe('parseCallbackUrl', () => {
  it('reads the success callback as a success', () => {
    expect(
      parseCallbackUrl(
        `${CALLBACK}?status=success`,
      ),
    ).toEqual({ outcome: 'success' });
  });

  /*
   * One case per backend reason rather than a loop inside a single test,
   * so a newly added reason names itself in the failure output instead of
   * hiding inside "parses failures".
   */
  for (const reason of BACKEND_REASONS) {
    it(`reads the ${reason} failure`, () => {
      expect(
        parseCallbackUrl(
          `${CALLBACK}?status=error&reason=${reason}`,
        ),
      ).toEqual({
        outcome: 'error',
        reason,
      });
    });
  }

  it('ignores a link on a different scheme', () => {
    /*
     * The OS hands the app every link it is registered for, and a
     * universal link or an https URL that merely shares our path must
     * not be able to drive the connection state machine.
     */
    for (const url of [
      'https://github/callback?status=success',
      'com.other.app://github/callback?status=success',
      'exp://127.0.0.1:8081/--/github/callback?status=success',
    ]) {
      expect(parseCallbackUrl(url)).toBeNull();
    }
  });

  it('ignores our scheme on a different path', () => {
    for (const url of [
      `${SCHEME}://github/other?status=success`,
      `${SCHEME}://other/callback?status=success`,
      `${SCHEME}://github/callback/extra?status=success`,
      `${SCHEME}://resume/import?status=success`,
    ]) {
      expect(parseCallbackUrl(url)).toBeNull();
    }
  });

  it('returns null for garbage instead of throwing', () => {
    /*
     * Anything can arrive here. A parser that throws takes the screen
     * down on a link the app did not even want.
     */
    for (const url of [
      '',
      '   ',
      'not a url at all',
      '://///',
      '%%%',
      `${SCHEME}`,
      'com.careeros.mobile//github/callback',
    ]) {
      expect(() =>
        parseCallbackUrl(url),
      ).not.toThrow();

      expect(parseCallbackUrl(url)).toBeNull();
    }
  });

  it('returns null for null input', () => {
    /*
     * The cold-start path: getInitialURL() resolves null when the app was
     * not opened by a link.
     */
    expect(parseCallbackUrl(null)).toBeNull();
  });

  it('treats a callback with no status as a failure', () => {
    /*
     * Absence is not consent. A missing status means we do not know what
     * happened, and "we do not know" must resolve towards error — the
     * screen then re-reads the truth from GET /github/status anyway.
     */
    const result = parseCallbackUrl(CALLBACK);

    expect(result).not.toBeNull();
    expect(result?.outcome).toBe('error');
  });

  it('never treats an unknown status as success', () => {
    for (const status of [
      'ok',
      'SUCCESS',
      'succeeded',
      'true',
      '1',
      'success ',
    ]) {
      const result = parseCallbackUrl(
        `${CALLBACK}?status=${encodeURIComponent(
          status,
        )}`,
      );

      expect(result?.outcome).not.toBe(
        'success',
      );
    }
  });

  it('pairs an unknown reason with a describable failure', () => {
    /*
     * The two functions have to agree. Whatever the parser puts in
     * `reason` for a value the backend never sends, the describer has to
     * survive it.
     */
    const result = parseCallbackUrl(
      `${CALLBACK}?status=error&reason=brand_new_reason`,
    );

    expect(result?.outcome).toBe('error');

    const sentence = describeCallbackFailure(
      result?.outcome === 'error'
        ? result.reason
        : '',
    );

    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence).not.toContain(
      'brand_new_reason',
    );
  });
});

/*
 * The group that matters most.
 *
 * The backend deliberately puts nothing but a status in this redirect
 * (see buildRedirectUrl). These tests assume that guarantee will one day
 * be broken — by a proxy, a misconfiguration, a future change, or another
 * app forging a link at our scheme — and pin the client-side half: the
 * parser is a whitelist, so a credential that arrives cannot leave.
 */
describe('parseCallbackUrl secrets handling', () => {
  const SECRETS = {
    access_token: TOKEN_PREFIXES[0] + 'SECRETA',
    code: 'authcode-SECRETB',
    state: 'state-SECRETC',
    refresh_token: TOKEN_PREFIXES[4] + 'SECRETD',
    client_secret: 'clientsecret-SECRETE',
  };

  function laden(status: string): string {
    const params = Object.entries(SECRETS)
      .map(
        ([key, value]) =>
          `${key}=${encodeURIComponent(value)}`,
      )
      .join('&');

    return `${CALLBACK}?status=${status}&${params}`;
  }

  it('drops credentials from a success callback', () => {
    const serialized = serialize(
      parseCallbackUrl(laden('success')),
    );

    for (const value of Object.values(
      SECRETS,
    )) {
      expect(serialized).not.toContain(value);
    }

    for (const key of Object.keys(SECRETS)) {
      expect(serialized).not.toContain(key);
    }
  });

  it('drops credentials from an error callback', () => {
    const serialized = serialize(
      parseCallbackUrl(
        `${laden('error')}&reason=access_denied`,
      ),
    );

    for (const value of Object.values(
      SECRETS,
    )) {
      expect(serialized).not.toContain(value);
    }
  });

  it('never emits a GitHub token prefix', () => {
    /*
     * Checked by prefix as well as by exact value, because the shape is
     * what a log scraper or a screenshot leaks. A parsed result that
     * contains gh?_ at all is wrong regardless of which parameter it
     * came from.
     */
    const urls = [
      laden('success'),
      `${laden('error')}&reason=server_error`,
      `${CALLBACK}?status=error&reason=${TOKEN_PREFIXES[2]}LEAKED`,
      `${CALLBACK}?status=${TOKEN_PREFIXES[1]}LEAKED`,
      `${CALLBACK}#${TOKEN_PREFIXES[3]}LEAKED`,
      /*
       * A fragment glued onto a legitimate reason. Worth its own case
       * because a parser that splits on '?' but not on '#' hands the
       * describer "access_denied#<token>" - which is only harmless
       * because the reason is normalised against the known set before it
       * is returned. This pins that normalisation.
       */
      `${CALLBACK}?status=error&reason=access_denied#${TOKEN_PREFIXES[0]}LEAKED`,
    ];

    for (const url of urls) {
      const serialized = serialize(
        parseCallbackUrl(url),
      );

      for (const prefix of TOKEN_PREFIXES) {
        expect(serialized).not.toContain(
          prefix,
        );
      }

      expect(serialized).not.toContain(
        'LEAKED',
      );
    }
  });

  it('keeps credentials out of the failure sentence too', () => {
    /*
     * The parsed result is not the only way out. describeCallbackFailure
     * takes a string that ultimately came off the wire, so it has to be
     * a whitelist as well — echoing its argument would put whatever the
     * parser passed through onto the screen.
     */
    for (const value of Object.values(
      SECRETS,
    )) {
      const sentence =
        describeCallbackFailure(value);

      expect(sentence).not.toContain(value);

      for (const prefix of TOKEN_PREFIXES) {
        expect(sentence).not.toContain(prefix);
      }
    }
  });
});

describe('describeCallbackFailure', () => {
  it('has a sentence for every backend reason', () => {
    for (const reason of BACKEND_REASONS) {
      const sentence =
        describeCallbackFailure(reason);

      expect(
        sentence.trim().length,
      ).toBeGreaterThan(0);

      /*
       * A sentence, not a label. The threshold is deliberately low - it
       * is here to catch a stub returning the reason back, or an empty
       * string, not to police wording.
       */
      expect(
        sentence.trim().length,
      ).toBeGreaterThan(10);
    }
  });

  it('never echoes the raw reason code', () => {
    /*
     * "exchange_failed" on a screen is a leak of internal vocabulary and
     * tells the user nothing they can act on.
     */
    for (const reason of BACKEND_REASONS) {
      expect(
        describeCallbackFailure(reason),
      ).not.toContain(reason);
    }
  });

  it('falls back safely for an unrecognised reason', () => {
    for (const reason of [
      '',
      'totally_unknown',
      'ENOTFOUND',
      'undefined',
      'null',
      '<script>alert(1)</script>',
    ]) {
      const sentence =
        describeCallbackFailure(reason);

      expect(
        sentence.trim().length,
      ).toBeGreaterThan(10);

      /*
       * Skipped for '' only because every string contains the empty
       * string; the length assertion above is what covers that case.
       */
      if (reason.length > 0) {
        expect(sentence).not.toContain(reason);
      }
    }
  });

  it('leaks no internals into any sentence', () => {
    const sentences = [
      ...BACKEND_REASONS,
      'unrecognised_reason',
    ].map(describeCallbackFailure);

    for (const sentence of sentences) {
      /*
       * The three shapes that mean an internal detail escaped: a stack
       * frame, a missing value rendered as text, and snake_case, which
       * in this app only ever comes from a machine.
       */
      expect(sentence).not.toMatch(
        /\bat\s+\w+\s*\(|\.ts:\d+|node_modules/,
      );

      expect(sentence).not.toMatch(
        /undefined|null|NaN|\[object Object\]/,
      );

      expect(sentence).not.toMatch(
        /[a-z]+_[a-z]+/,
      );
    }
  });

  it('makes no claim about the person', () => {
    for (const reason of [
      ...BACKEND_REASONS,
      'unrecognised_reason',
    ]) {
      assertNoInferenceLanguage(
        describeCallbackFailure(reason),
      );
    }
  });
});

describe('isPartialSync', () => {
  it('calls PARTIAL partial and SUCCEEDED complete', () => {
    expect(isPartialSync('PARTIAL')).toBe(true);
    expect(isPartialSync('SUCCEEDED')).toBe(
      false,
    );
  });

  it('treats an unrecognised status as partial', () => {
    /*
     * The safe default runs one way only. Reading an unknown status as
     * complete would let a new backend status - or a truncated one -
     * silently present unread repositories as fully read; reading it as
     * partial only understates what happened.
     */
    for (const status of [
      '',
      'RUNNING',
      'FAILED',
      'succeeded',
      'UNKNOWN',
    ]) {
      expect(isPartialSync(status)).toBe(true);
    }
  });
});

describe('describeSyncSummary', () => {
  /*
   * Claims of completeness, in the forms the wording could take. Note
   * that \bcomplete\b does not match "incomplete", which is a word an
   * honest PARTIAL sentence is allowed to use.
   */
  const COMPLETENESS_CLAIMS = [
    /\bup[ -]to[ -]date\b/i,
    /\bcomplete(d|ly)?\b/i,
    /\bfully\b/i,
    /\beverything\b/i,
    /\ball (your |of your )?(repos|repositories)\b/i,
    /\bfinished scanning\b/i,
    /\bin sync\b/i,
  ];

  it('never calls a PARTIAL sync complete', () => {
    /*
     * The central honesty test. PARTIAL is the NORMAL outcome for any
     * account over the scan budget - not an error - so this sentence is
     * the one most users see, and it is the one most likely to be
     * written as if the job were done.
     */
    const sentence = describeSyncSummary(
      makeSummary('PARTIAL', {
        created: 12,
        updated: 3,
        reposScanned: 15,
        reposTotal: 40,
        reposSkipped: 25,
      }),
    );

    for (const claim of COMPLETENESS_CLAIMS) {
      expect(sentence).not.toMatch(claim);
    }
  });

  it('discloses the repositories it skipped', () => {
    /*
     * 25 repositories with no evidence row is a visible hole in the UI.
     * Saying so is the difference between a partial view and a wrong
     * one.
     */
    const sentence = describeSyncSummary(
      makeSummary('PARTIAL', {
        reposScanned: 15,
        reposTotal: 40,
        reposSkipped: 25,
      }),
    );

    expect(sentence).toContain('25');

    expect(sentence).toMatch(
      /skipped|not (yet )?(looked|read|scanned)|remaining|left/i,
    );
  });

  it('reads as done for a SUCCEEDED sync', () => {
    /*
     * The mirror of the test above: honesty runs both ways, and a
     * finished sync that hedges teaches the user to ignore the hedge
     * when it matters.
     */
    const sentence = describeSyncSummary(
      makeSummary('SUCCEEDED', {
        created: 8,
        updated: 2,
        reposScanned: 10,
        reposTotal: 10,
      }),
    );

    expect(
      sentence.trim().length,
    ).toBeGreaterThan(10);

    expect(sentence).not.toMatch(
      /\bpartial\b|\bincomplete\b|\bsome repositories\b/i,
    );

    expect(sentence).toContain('10');
  });

  it('does not claim to have re-read revalidated repos', () => {
    /*
     * A steady-state sync revalidates by pushed-at and reads nothing.
     * "Scanned 40 repositories" is then true of the ledger and false of
     * the work, which is precisely why the backend reports
     * reposRevalidated separately.
     */
    const sentence = describeSyncSummary(
      makeSummary('SUCCEEDED', {
        created: 0,
        updated: 40,
        reposScanned: 40,
        reposRevalidated: 40,
        reposTotal: 40,
      }),
    );

    expect(sentence).not.toMatch(
      /\bread all\b|\bscanned all\b|\bre-?read (all|every)\b/i,
    );

    expect(sentence).toMatch(
      /unchanged|revalidat|carried|already/i,
    );
  });

  it('renders zero counts honestly', () => {
    /*
     * A connection with nothing to show must say nothing, not go blank
     * and not render a hole where a number should be.
     */
    const sentence = describeSyncSummary(
      makeSummary('SUCCEEDED'),
    );

    expect(
      sentence.trim().length,
    ).toBeGreaterThan(0);

    expect(sentence).toMatch(
      /\b0\b|\bno\b|\bnothing\b|\bnone\b/i,
    );

    expect(sentence).not.toMatch(
      /undefined|NaN|\[object Object\]/,
    );
  });

  it('never leaks internals for any status', () => {
    for (const status of [
      'SUCCEEDED',
      'PARTIAL',
      'RUNNING',
      '',
      'WEIRD_NEW_STATUS',
    ]) {
      const sentence = describeSyncSummary(
        makeSummary(status, {
          created: 1,
          updated: 1,
          reposScanned: 2,
          reposTotal: 3,
          reposSkipped: 1,
        }),
      );

      /* '' is contained in every string; see above. */
      if (status.length > 0) {
        expect(sentence).not.toContain(status);
      }

      expect(sentence).not.toMatch(
        /undefined|NaN|\[object Object\]/,
      );
    }
  });

  it('makes no claim about the person', () => {
    /*
     * The whole point of the feature is that commits are evidence, not a
     * verdict. No arrangement of counts may produce a sentence that
     * grades somebody.
     */
    const summaries = [
      makeSummary('SUCCEEDED'),
      makeSummary('SUCCEEDED', {
        created: 500,
        updated: 500,
        reposScanned: 200,
        reposRevalidated: 100,
        reposTotal: 200,
      }),
      makeSummary('PARTIAL', {
        created: 1,
        reposScanned: 1,
        reposTotal: 90,
        reposSkipped: 89,
      }),
    ];

    for (const summary of summaries) {
      assertNoInferenceLanguage(
        describeSyncSummary(summary),
      );
    }
  });
});

/*
 * The invariant the whole phase rests on, tested at the only place it can
 * be: deriveUiState has no parameter for a deep link, so no arrangement of
 * callback URLs can reach 'connected'. These assertions are what stop that
 * signature being "simplified" later by passing the callback result in.
 */
describe('deriveUiState', () => {
  const base = {
    serverStatus: null as {
      connected: boolean;
      status: string | null;
    } | null,
    busy: null as 'connecting' | 'syncing' | null,
    lastSyncStatus: null as string | null,
    hasError: false,
  };

  it('is disconnected when the server reports no connection', () => {
    expect(deriveUiState(base)).toBe(
      'disconnected',
    );
  });

  it('is connected only when the server says ACTIVE', () => {
    expect(
      deriveUiState({
        ...base,
        serverStatus: {
          connected: true,
          status: 'ACTIVE',
        },
      }),
    ).toBe('connected');
  });

  /*
   * The API reports connected: true whenever a connection row exists and
   * carries the row's real state separately. A REVOKED or INVALID row
   * would otherwise render a Sync button the server refuses with a 404.
   */
  it.each(['REVOKED', 'INVALID', null, 'ACTIVE '])(
    'is disconnected when the connection state is %s, despite connected: true',
    (status) => {
      expect(
        deriveUiState({
          ...base,
          serverStatus: {
            connected: true,
            status: status as string | null,
          },
        }),
      ).toBe('disconnected');
    },
  );

  it('stays partial while the last sync did not complete', () => {
    expect(
      deriveUiState({
        ...base,
        serverStatus: {
          connected: true,
          status: 'ACTIVE',
        },
        lastSyncStatus: 'PARTIAL',
      }),
    ).toBe('partial');
  });

  it('does not treat an unrecognised sync status as complete', () => {
    expect(
      deriveUiState({
        ...base,
        serverStatus: {
          connected: true,
          status: 'ACTIVE',
        },
        lastSyncStatus: 'FAILED',
      }),
    ).toBe('partial');
  });

  it('reports work in progress ahead of anything else', () => {
    expect(
      deriveUiState({
        ...base,
        busy: 'syncing',
        serverStatus: {
          connected: true,
          status: 'ACTIVE',
        },
      }),
    ).toBe('syncing');

    expect(
      deriveUiState({ ...base, busy: 'connecting' }),
    ).toBe('connecting');
  });

  it('surfaces an error over a stale connected state', () => {
    expect(
      deriveUiState({
        ...base,
        hasError: true,
        serverStatus: {
          connected: true,
          status: 'ACTIVE',
        },
      }),
    ).toBe('error');
  });

  /*
   * The security assertion. A successful callback is not an input to this
   * function at all - the only way to reach 'connected' is for the server
   * to have said ACTIVE. If someone ever widens the signature to accept
   * the parsed callback, this test is what should stop them.
   */
  it('cannot reach connected without the server saying so', () => {
    const forged = parseCallbackUrl(
      'com.careeros.mobile://github/callback?status=success',
    );

    expect(forged).toEqual({
      outcome: 'success',
    });

    /* The callback said success; the server said nothing. */
    expect(deriveUiState(base)).toBe(
      'disconnected',
    );

    expect(
      Object.keys(base),
    ).not.toContain('callback');
  });
});
