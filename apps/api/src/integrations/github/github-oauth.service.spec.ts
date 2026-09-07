import type { PrismaService } from '../../prisma/prisma.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { OAuthStateService } from '../oauth/oauth-state.service.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
  TEST_GITHUB_CONFIG,
} from '../test-doubles.js';

import { GithubApiClient } from './github-api.client.js';
import { GithubConnectionService } from './github-connection.service.js';
import { GithubOAuthConfig } from './github-oauth.config.js';
import { GithubOAuthService } from './github-oauth.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const TOKEN_PREFIX = 'gho';

const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

/*
 * The whole stack, real, with only the network replaced. Every service
 * under test is the production class: the state machine, the encryption,
 * the connection persistence and the HTTP client's parsing all execute.
 * Replacing fetch is what makes the token exchange observable - it is how
 * "the exchange happens server-side" is asserted rather than assumed.
 */
function build(
  responder: (
    call: Call,
  ) => { status?: number; body: unknown } = () => ({
    body: {
      access_token: TOKEN,
      /* GitHub returns granted scopes COMMA-delimited. */
      scope: 'user:email',
      token_type: 'bearer',
    },
  }),
) {
  const calls: Call[] = [];

  const store = createInMemoryPrisma();

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const config = new GithubOAuthConfig(
    stubConfig(TEST_GITHUB_CONFIG),
  );

  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (input, init) => {
        const call: Call = {
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ??
            {}) as Record<string, string>,
          body:
            typeof init?.body === 'string'
              ? init.body
              : null,
        };

        calls.push(call);

        const isUserEndpoint =
          call.url.endsWith('/user');

        const result = isUserEndpoint
          ? {
              body: {
                id: 583231,
                login: 'octocat',
              },
            }
          : responder(call);

        return new Response(
          JSON.stringify(result.body),
          {
            status: result.status ?? 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        );
      },
    );

  const api = new GithubApiClient(config);

  const state = new OAuthStateService(
    store.prisma as unknown as PrismaService,
    encryption,
  );

  const connections =
    new GithubConnectionService(
      store.prisma as unknown as PrismaService,
      encryption,
      api,
    );

  const service = new GithubOAuthService(
    config,
    state,
    api,
    connections,
  );

  return {
    service,
    state,
    connections,
    store,
    calls,
    fetchSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GithubOAuthService', () => {
  describe('authorization request', () => {
    it('requests exactly user:email, and never a repository scope', async () => {
      const { service } = build();

      const { authorizationUrl } =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const url = new URL(authorizationUrl);

      expect(url.origin).toBe(
        'https://github.com',
      );
      expect(url.pathname).toBe(
        '/login/oauth/authorize',
      );

      /*
       * The scope must be present. Omitting it does not request nothing -
       * GitHub grants the union of everything this user previously
       * approved for the app.
       */
      expect(
        url.searchParams.get('scope'),
      ).toBe('user:email');

      for (const forbidden of [
        'repo',
        'public_repo',
        'read:user',
      ]) {
        expect(
          url.searchParams.get('scope'),
        ).not.toContain(forbidden);
      }
    });

    it('carries S256 PKCE and a 43-character challenge', async () => {
      const { service } = build();

      const { authorizationUrl } =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const url = new URL(authorizationUrl);

      expect(
        url.searchParams.get(
          'code_challenge_method',
        ),
      ).toBe('S256');

      /*
       * 43 characters is unpadded base64url of a SHA-256 digest, which is
       * what GitHub documents. A 44-character value would mean base64 with
       * padding, and PKCE verification would fail at the exchange.
       */
      const challenge = url.searchParams.get(
        'code_challenge',
      );

      expect(challenge).toHaveLength(43);
      expect(challenge).not.toContain('=');
      expect(challenge).toMatch(
        /^[A-Za-z0-9_-]+$/,
      );
    });

    it('sends the registered callback unchanged', async () => {
      const { service } = build();

      const { authorizationUrl } =
        await service.createAuthorizationRequest(
          USER_A,
        );

      expect(
        new URL(
          authorizationUrl,
        ).searchParams.get('redirect_uri'),
      ).toBe(
        TEST_GITHUB_CONFIG.GITHUB_OAUTH_CALLBACK_URL,
      );
    });

    it('never puts the client secret in the authorization URL', async () => {
      const { service } = build();

      const { authorizationUrl } =
        await service.createAuthorizationRequest(
          USER_A,
        );

      expect(authorizationUrl).not.toContain(
        TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
      );
    });
  });

  /*
   * The security boundary this whole phase turns on.
   */
  describe('callback user binding', () => {
    it('binds the connection to the state owner, not to any caller', async () => {
      const { service, store } = build();

      /*
       * USER_B starts a flow. Nothing else in the callback carries an
       * identity, so if the implementation ever reached for an ambient
       * user this would attach to the wrong account.
       */
      const started =
        await service.createAuthorizationRequest(
          USER_B,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      const outcome =
        await service.handleCallback({
          code: 'valid-code',
          state,
        });

      expect(outcome).toBe('success');

      expect(
        store.rows.connections,
      ).toHaveLength(1);
      expect(
        store.rows.connections[0]!.userId,
      ).toBe(USER_B);
    });

    it('accepts no user identity from the callback parameters', async () => {
      const { service, store } = build();

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      /*
       * A forged callback carrying a different user id. The signature of
       * handleCallback has nowhere to put it - that is the design - and
       * the resulting connection belongs to the state's owner.
       */
      await service.handleCallback({
        code: 'valid-code',
        state,
        ...({ userId: USER_B } as object),
      });

      expect(
        store.rows.connections[0]!.userId,
      ).toBe(USER_A);
    });
  });

  /* Security test 8. */
  describe('token exchange', () => {
    it('exchanges the code server-side with the client secret', async () => {
      const { service, calls } = build();

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      await service.handleCallback({
        code: 'valid-code',
        state,
      });

      const exchange = calls.find((call) =>
        call.url.includes(
          'login/oauth/access_token',
        ),
      )!;

      expect(exchange.method).toBe('POST');

      const sent = new URLSearchParams(
        exchange.body!,
      );

      expect(sent.get('client_secret')).toBe(
        TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
      );
      expect(sent.get('code')).toBe(
        'valid-code',
      );
      /* PKCE verifier is replayed from the stored record. */
      expect(
        sent.get('code_verifier'),
      ).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

      /*
       * Without this header GitHub replies form-encoded and the token
       * silently parses as undefined.
       */
      expect(exchange.headers['Accept']).toBe(
        'application/json',
      );
    });

    it('treats an HTTP 200 error body as a failure', async () => {
      /*
       * GitHub answers OAuth errors with 200 and an error body. An
       * implementation that only checked response.ok would store an empty
       * credential and report success.
       */
      const { service, store } = build(() => ({
        status: 200,
        body: {
          error: 'bad_verification_code',
          error_description:
            'The code passed is incorrect or expired.',
        },
      }));

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      expect(
        await service.handleCallback({
          code: 'stale-code',
          state,
        }),
      ).toBe('exchange_failed');

      expect(
        store.rows.connections,
      ).toHaveLength(0);
    });

    it('surfaces an unverified primary email as its own outcome', async () => {
      const { service } = build(() => ({
        status: 200,
        body: {
          error: 'unverified_user_email',
          error_description:
            'The user must have a verified primary email.',
        },
      }));

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      expect(
        await service.handleCallback({
          code: 'code',
          state,
        }),
      ).toBe('unverified_email');
    });

    it('records the scopes GitHub granted rather than the ones requested', async () => {
      const { service, store } = build(() => ({
        body: {
          access_token: TOKEN,
          /* Comma-delimited, as GitHub documents for the response. */
          scope: 'user:email,gist',
          token_type: 'bearer',
        },
      }));

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      await service.handleCallback({
        code: 'code',
        state: new URL(
          started.authorizationUrl,
        ).searchParams.get('state')!,
      });

      expect(
        store.rows.connections[0]!.grantedScopes,
      ).toEqual(['user:email', 'gist']);
    });
  });

  /* Security tests 7 and 20. */
  describe('callback safety', () => {
    const cases: Array<[string, { code?: string; state?: string; error?: string }]> = [
      ['a forged state', { code: 'c', state: 'forged' }],
      ['no state at all', { code: 'c' }],
      ['no code', { state: 'whatever' }],
      ['an empty state', { code: 'c', state: '' }],
    ];

    it.each(cases)(
      'fails safely with %s',
      async (_label, params) => {
        const { service, store, calls } =
          build();

        const outcome =
          await service.handleCallback(params);

        expect(outcome).toBe('invalid_state');

        /* Nothing persisted... */
        expect(
          store.rows.connections,
        ).toHaveLength(0);

        /* ...and no code was sent to GitHub. */
        expect(calls).toHaveLength(0);
      },
    );

    it('reports a user who declined at GitHub', async () => {
      const { service, calls } = build();

      expect(
        await service.handleCallback({
          error: 'access_denied',
        }),
      ).toBe('access_denied');

      expect(calls).toHaveLength(0);
    });

    it('cannot be replayed after consumption', async () => {
      const { service, store } = build();

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      expect(
        await service.handleCallback({
          code: 'code',
          state,
        }),
      ).toBe('success');

      /*
       * The replay. Browsers re-issue GETs and link previewers follow
       * redirects, so this is a real event, not only an attack.
       */
      expect(
        await service.handleCallback({
          code: 'code',
          state,
        }),
      ).toBe('invalid_state');

      expect(
        store.rows.connections,
      ).toHaveLength(1);
    });

    it('refuses a second user replaying a consumed state', async () => {
      const { service, store } = build();

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      await service.handleCallback({
        code: 'code',
        state,
      });

      expect(
        await service.handleCallback({
          code: 'code',
          state,
        }),
      ).toBe('invalid_state');

      expect(
        store.rows.connections,
      ).toHaveLength(1);
      expect(
        store.rows.connections[0]!.userId,
      ).toBe(USER_A);
    });

    it('reports an account already linked to someone else', async () => {
      const { service, connections } = build();

      await connections.upsertConnection({
        userId: USER_B,
        accountId: '583231',
        login: 'octocat',
        accessToken: TOKEN,
        grantedScopes: ['user:email'],
      });

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      expect(
        await service.handleCallback({
          code: 'code',
          state: new URL(
            started.authorizationUrl,
          ).searchParams.get('state')!,
        }),
      ).toBe('account_already_linked');
    });
  });

  /* Security test 11. */
  describe('redirect back to the app', () => {
    it('carries a status and nothing else', async () => {
      const { service } = build();

      const url = new URL(
        service.buildRedirectUrl('success'),
      );

      expect(url.protocol).toBe('careeros:');
      expect(
        url.searchParams.get('status'),
      ).toBe('success');

      expect([
        ...url.searchParams.keys(),
      ]).toEqual(['status']);
    });

    it('never carries a token, code, state or verifier', async () => {
      const { service } = build();

      const started =
        await service.createAuthorizationRequest(
          USER_A,
        );

      const state = new URL(
        started.authorizationUrl,
      ).searchParams.get('state')!;

      const outcome =
        await service.handleCallback({
          code: 'valid-code',
          state,
        });

      const redirect =
        service.buildRedirectUrl(outcome);

      expect(redirect).not.toContain(TOKEN);
      expect(redirect).not.toContain(
        TOKEN_PREFIX,
      );
      expect(redirect).not.toContain(state);
      expect(redirect).not.toContain(
        'valid-code',
      );
      expect(redirect).not.toContain(
        TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
      );
    });

    it('reports a failure reason from the closed set', async () => {
      const { service } = build();

      const url = new URL(
        service.buildRedirectUrl(
          'account_already_linked',
        ),
      );

      expect(
        url.searchParams.get('status'),
      ).toBe('error');
      expect(
        url.searchParams.get('reason'),
      ).toBe('account_already_linked');
    });

    it('cannot be steered elsewhere by the callback', async () => {
      const { service } = build();

      /*
       * The redirect base is configuration, so there is no input that
       * could turn this endpoint into an open redirect.
       */
      for (const outcome of [
        'success',
        'invalid_state',
        'server_error',
      ] as const) {
        expect(
          service.buildRedirectUrl(outcome),
        ).toMatch(
          /^careeros:\/\/github-callback/,
        );
      }
    });
  });
});
