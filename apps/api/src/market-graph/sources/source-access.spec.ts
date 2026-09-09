import { afterEach, describe, expect, it } from 'vitest';

import {
  INGESTIBLE_ACCESS_STATES,
  TERMINAL_ACCESS_STATES,
  accessStateAwaitsCredentials,
  declarationProblems,
  evaluateIngestGate,
  type CredentialState,
  type SourceAccessState,
} from './source-access.js';
import { MarketSourceCredentials } from './source-credentials.js';

/*
 * The gate, and the property the whole phase rests on: a source that has
 * not been cleared cannot be walked, and no combination of inputs makes it
 * walkable by accident.
 *
 * The interesting tests here are the exhaustive ones. A gate tested with
 * three hand-picked states is a gate tested for the states somebody
 * thought of; the eleventh state is the one that will be added in a hurry.
 */

const ALL_STATES: SourceAccessState[] = [
  'DISCOVERED',
  'ACCESS_REQUESTED',
  'ACCESS_GRANTED',
  'CREDENTIALS_REQUIRED',
  'CREDENTIALS_CONFIGURED',
  'LEGAL_REVIEW',
  'BLOCKED_EXTERNAL_ACCESS',
  'ENABLED',
  'DISABLED',
  'REJECTED',
  'EXPIRED',
];

const CONFIGURED: CredentialState = { kind: 'NOT_REQUIRED' };

function gate(overrides: {
  declared?: SourceAccessState;
  stored?: SourceAccessState;
  storedIsEnabled?: boolean;
  credentials?: CredentialState;
}) {
  const declared = overrides.declared ?? 'ENABLED';

  return evaluateIngestGate({
    declared,
    stored: overrides.stored ?? declared,
    storedIsEnabled: overrides.storedIsEnabled ?? true,
    credentials: overrides.credentials ?? CONFIGURED,
  });
}

describe('which states may be ingested', () => {
  /*
   * The complete answer, as a value rather than as a branch a reader has
   * to simulate. Adding a member to this list should look alarming in a
   * diff, which is why the list is asserted and not just used.
   */
  it('permits exactly one state, and it is ENABLED', () => {
    expect([...INGESTIBLE_ACCESS_STATES]).toEqual(['ENABLED']);
  });

  it.each(ALL_STATES.filter((state) => state !== 'ENABLED'))(
    'refuses a source declared %s, however healthy everything else is',
    (state) => {
      const verdict = gate({ declared: state });

      expect(verdict.permitted).toBe(false);
      expect(verdict.permitted === false && verdict.reason).toBe(
        'access_not_enabled',
      );
    },
  );

  /*
   * The state Phase 11 adds for its own outcome. An adapter can be
   * finished, tested, and shipped, and the source still ingests nothing -
   * and the gate must not treat "we built it" as any kind of progress
   * toward "we may use it".
   */
  it('refuses a source that is implemented but externally blocked', () => {
    expect(gate({ declared: 'BLOCKED_EXTERNAL_ACCESS' }).permitted).toBe(false);
  });

  it('names the terminal states, so "waiting" and "finished" stay apart', () => {
    expect([...TERMINAL_ACCESS_STATES].sort()).toEqual([
      'BLOCKED_EXTERNAL_ACCESS',
      'DISABLED',
      'ENABLED',
      'EXPIRED',
      'REJECTED',
    ]);

    expect(accessStateAwaitsCredentials('CREDENTIALS_REQUIRED')).toBe(true);
    expect(accessStateAwaitsCredentials('ENABLED')).toBe(false);
  });
});

describe('when code and the database disagree', () => {
  /*
   * The live bug this exists for. Two descriptors moved to `isEnabled:
   * false` and neither row changed, because ensureSource creates rows and
   * does not update them - so this database held an enabled Greenhouse
   * while the reviewed decision in code said otherwise.
   */
  it('refuses rather than picking a winner', () => {
    const verdict = gate({ declared: 'ENABLED', stored: 'REJECTED' });

    expect(verdict.permitted).toBe(false);
    expect(verdict.permitted === false && verdict.reason).toBe(
      'access_state_disagreement',
    );
    expect(verdict.permitted === false && verdict.detail).toBe(
      'code declares ENABLED, row records REJECTED',
    );
  });

  it('refuses in the other direction too', () => {
    expect(gate({ declared: 'REJECTED', stored: 'ENABLED' }).permitted).toBe(
      false,
    );
  });

  /*
   * A cleared source that an operator switched off stays off, and it says
   * so as its own reason - because "nobody approved this" and "I turned
   * this off on Tuesday" are different things to go and look at.
   */
  it('keeps an operator switch-off distinct from a missing approval', () => {
    const verdict = gate({ storedIsEnabled: false });

    expect(verdict.permitted === false && verdict.reason).toBe(
      'source_disabled',
    );
  });
});

describe('credentials at the gate', () => {
  /*
   * Without this branch, a source needing a key it does not have would
   * send an unauthenticated request, read the provider's 401, and record a
   * provider failure - sending somebody to a status page to debug a
   * variable that was never set on this machine.
   */
  it('refuses before the network when a declared key is unset', () => {
    const verdict = gate({
      credentials: { kind: 'MISSING', missingKeys: ['B_TOKEN', 'A_KEY'] },
    });

    expect(verdict.permitted === false && verdict.reason).toBe(
      'credentials_missing',
    );
    /* Names, sorted so two machines print the same line. No values. */
    expect(verdict.permitted === false && verdict.detail).toBe(
      'missing configuration: A_KEY, B_TOKEN',
    );
  });

  it('permits a source that needs none, and one whose keys are set', () => {
    expect(gate({ credentials: { kind: 'NOT_REQUIRED' } }).permitted).toBe(true);
    expect(gate({ credentials: { kind: 'CONFIGURED' } }).permitted).toBe(true);
  });
});

describe('the gate as a whole', () => {
  /*
   * Fail-closed, stated as a property rather than as a list of cases:
   * across every state, both enabled values and all three credential
   * outcomes, exactly the fully-cleared combinations pass.
   */
  it('permits only the fully cleared combination, over the whole space', () => {
    const credentials: CredentialState[] = [
      { kind: 'NOT_REQUIRED' },
      { kind: 'CONFIGURED' },
      { kind: 'MISSING', missingKeys: ['K'] },
    ];

    const permitted: string[] = [];

    for (const declared of ALL_STATES) {
      for (const stored of ALL_STATES) {
        for (const storedIsEnabled of [true, false]) {
          for (const credential of credentials) {
            const verdict = evaluateIngestGate({
              declared,
              stored,
              storedIsEnabled,
              credentials: credential,
            });

            if (verdict.permitted) {
              permitted.push(
                `${declared}/${stored}/${storedIsEnabled}/${credential.kind}`,
              );
            }
          }
        }
      }
    }

    expect(permitted.sort()).toEqual([
      'ENABLED/ENABLED/true/CONFIGURED',
      'ENABLED/ENABLED/true/NOT_REQUIRED',
    ]);
  });
});

describe('what a declaration may not say', () => {
  const base = {
    slug: 'example',
    accessState: 'ENABLED' as SourceAccessState,
    isEnabled: true,
    mayRedistributeDerived: true,
    licenceBasis: 'EXPLICIT_GRANT' as const,
    attribution: 'Credit where it is due.',
  };

  it('accepts a coherent declaration', () => {
    expect(declarationProblems(base)).toEqual([]);
  });

  it('rejects ENABLED on an unresolved licence', () => {
    expect(
      declarationProblems({
        ...base,
        licenceBasis: 'UNADDRESSED_PUBLIC_ENDPOINT',
      }),
    ).toEqual([
      'example: ENABLED with an unresolved licence position',
      'example: redistributes derived data with an unresolved licence position',
    ]);
  });

  it('rejects a switch and a state that disagree', () => {
    expect(declarationProblems({ ...base, isEnabled: false })).toEqual([
      'example: accessState ENABLED and isEnabled false disagree',
    ]);
  });

  /*
   * An empty attribution is worse than none: it reads as "no credit
   * required" to every truthiness check and as "present" to every null
   * check, so it renders as a blank line under a heading.
   */
  it('rejects an attribution that is an empty string', () => {
    expect(declarationProblems({ ...base, attribution: '  ' })).toEqual([
      'example: attribution is an empty string',
    ]);
  });
});

describe('resolving credentials', () => {
  afterEach(() => {
    delete process.env.TEST_MARKET_KEY;
    delete process.env.TEST_MARKET_OTHER;
  });

  it('reports a source that needs nothing as needing nothing', () => {
    expect(new MarketSourceCredentials().state(null)).toEqual({
      kind: 'NOT_REQUIRED',
    });
    expect(new MarketSourceCredentials().state({ envKeys: [] })).toEqual({
      kind: 'NOT_REQUIRED',
    });
  });

  it('reports exactly which names are unset', () => {
    process.env.TEST_MARKET_KEY = 'set';

    expect(
      new MarketSourceCredentials().state({
        envKeys: ['TEST_MARKET_KEY', 'TEST_MARKET_OTHER'],
      }),
    ).toEqual({ kind: 'MISSING', missingKeys: ['TEST_MARKET_OTHER'] });
  });

  /*
   * All or nothing. A client that got half its authentication would send a
   * request, read the provider's 401, and report a credential problem as a
   * provider problem - the exact confusion the MISSING state exists to
   * prevent, reintroduced one layer down.
   */
  it('throws rather than returning a partial map', () => {
    process.env.TEST_MARKET_KEY = 'set';

    expect(() =>
      new MarketSourceCredentials().resolve({
        envKeys: ['TEST_MARKET_KEY', 'TEST_MARKET_OTHER'],
      }),
    ).toThrow('TEST_MARKET_OTHER');
  });

  it('returns the values to the one caller that asks for them', () => {
    process.env.TEST_MARKET_KEY = 'live-value';

    expect(
      new MarketSourceCredentials().resolve({ envKeys: ['TEST_MARKET_KEY'] }),
    ).toEqual({ TEST_MARKET_KEY: 'live-value' });
  });

  /*
   * The error names keys and carries no values, because it is the object
   * most likely to be caught, wrapped and logged by somebody in a hurry.
   */
  it('names keys and no values when it refuses', () => {
    process.env.TEST_MARKET_KEY = 'live-value';

    const error = (() => {
      try {
        new MarketSourceCredentials().resolve({
          envKeys: ['TEST_MARKET_KEY', 'TEST_MARKET_OTHER'],
        });
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error?.message).not.toContain('live-value');
    expect(JSON.stringify(error)).not.toContain('live-value');
  });
});
