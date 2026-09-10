import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvidenceRecord } from './contract.js';
import {
  SIGNAL_VOCABULARY,
  type Signal,
  deriveSignals,
} from './signal.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function github(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    sourceType: 'GITHUB',
    title: 'repo',
    description: null,
    sourceUrl: 'https://github.com/u/repo',
    externalId: '101',
    occurredAt: daysAgo(400),
    capturedAt: daysAgo(10),
    lastObservedAt: daysAgo(1),
    authenticity: 'DIRECT_API_OBSERVATION',
    attribution: 'AUTHENTICATED_ACCOUNT',
    completeness: 'PARTIAL',
    transformVersion: 1,
    independenceKey: 'github:555',
    metadata: null,
    ...over,
  };
}

const resume = (over: Partial<EvidenceRecord> = {}): EvidenceRecord =>
  github({
    sourceType: 'RESUME',
    externalId: null,
    sourceUrl: null,
    occurredAt: null,
    authenticity: 'USER_CLAIM',
    attribution: 'USER_ASSERTED',
    completeness: 'UNKNOWN',
    independenceKey: 'resume:aaaaaaaa-0000-0000-0000-000000000001',
    ...over,
  });

/* The words a career conclusion would have to use. */
const CAREER_VERDICT =
  /senior|junior|expert|proficien|master|leader|leadership|high.?perform|excellent|strong engineer|great|talented|skilled|hire|rank|score|level/i;

describe('every signal states its limits', () => {
  it('always returns supports and a non-empty doesNotEstablish', () => {
    const cases: EvidenceRecord[][] = [
      [],
      [github()],
      [resume()],
      [github(), resume()],
      [github({ attribution: 'WEAK_MATCH' })],
      [github({ completeness: 'NOT_SCANNED' })],
      [github({ completeness: 'ACCESS_LOST' })],
      [github({ lastObservedAt: daysAgo(400) })],
    ];

    for (const records of cases) {
      const signals = deriveSignals(records, NOW);

      expect(signals.length).toBeGreaterThan(0);

      for (const signal of signals) {
        expect(signal.supports).toBeTruthy();
        expect(signal.doesNotEstablish.length).toBeGreaterThan(0);
        expect(signal.doesNotEstablish.every((l) => l.length > 0)).toBe(
          true,
        );
      }
    }
  });

  /*
   * Exhaustive, not sampled. The vocabulary is the ONLY source of these
   * strings - nothing is concatenated or interpolated - so enumerating it
   * enumerates everything this module can ever say.
   */
  it('has no career verdict anywhere in the supported vocabulary', () => {
    for (const [kind, entry] of Object.entries(SIGNAL_VOCABULARY)) {
      expect(
        CAREER_VERDICT.test(entry.supports),
        `${kind} supports: ${entry.supports}`,
      ).toBe(false);
    }
  });

  it('names those limits explicitly where they matter', () => {
    /* The limitations SHOULD use the words the supports may not. */
    const observed = SIGNAL_VOCABULARY.OBSERVED_VIA_AUTHENTICATED_ACCOUNT;

    expect(observed.doesNotEstablish.join(' ')).toMatch(/seniority/i);
    expect(observed.doesNotEstablish.join(' ')).toMatch(/expertise/i);
    expect(observed.doesNotEstablish.join(' ')).toMatch(/leadership/i);
  });

  it('gives each kind limits of its own, not shared boilerplate', () => {
    const lists = Object.values(SIGNAL_VOCABULARY).map((entry) =>
      entry.doesNotEstablish.join('|'),
    );

    expect(new Set(lists).size).toBe(lists.length);
  });
});

describe('absence of evidence', () => {
  it('produces a statement about our records, not about the person', () => {
    const signals = deriveSignals([], NOW);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('INSUFFICIENT_EVIDENCE');
    expect(signals[0]!.supports).toMatch(/Career OS holds no admissible/i);
    expect(signals[0]!.doesNotEstablish.join(' ')).toMatch(
      /lacks this skill or experience/i,
    );
  });

  it('says the same when every row was disqualified', () => {
    const signals = deriveSignals(
      [
        github({ attribution: 'WEAK_MATCH' }),
        github({ externalId: '2', completeness: 'NOT_SCANNED' }),
      ],
      NOW,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('never emits a negative capability claim in any shape', () => {
    const NEGATIVE = /does not know|cannot|no skill|lacks (?!this skill or experience)|not capable|unskilled/i;

    for (const records of [[], [github({ attribution: 'WEAK_MATCH' })]]) {
      for (const signal of deriveSignals(records, NOW)) {
        expect(NEGATIVE.test(signal.supports)).toBe(false);
      }
    }
  });
});

describe('volume never becomes ability', () => {
  it('cannot produce seniority from one repository', () => {
    for (const signal of deriveSignals([github()], NOW)) {
      expect(CAREER_VERDICT.test(signal.supports)).toBe(false);
    }
  });

  it('cannot produce expertise from fourteen repositories', () => {
    const repos = Array.from({ length: 14 }, (_v, i) =>
      github({ externalId: String(i) }),
    );

    const signals = deriveSignals(repos, NOW);

    for (const signal of signals) {
      expect(CAREER_VERDICT.test(signal.supports)).toBe(false);
    }

    /* And fourteen rows are still one source. */
    expect(signals[0]!.basis.independentSources).toBe(1);
    expect(
      signals.some((s) => s.kind === 'INDEPENDENTLY_CORROBORATED'),
    ).toBe(false);
  });

  it('cannot produce leadership from any amount of activity', () => {
    const lots = Array.from({ length: 200 }, (_v, i) =>
      github({ externalId: String(i) }),
    );

    for (const signal of deriveSignals(lots, NOW)) {
      expect(signal.supports).not.toMatch(/leader/i);
    }
  });

  /*
   * The most tempting shortcut in the whole layer: reliability standing
   * in for competence. VERY_STRONG says the evidence is dependable, not
   * that the person is good.
   */
  it('does not turn VERY_STRONG reliability into a career verdict', () => {
    const signals = deriveSignals([github(), resume()], NOW);

    expect(signals[0]!.basis.trustClass).toBe('VERY_STRONG');

    for (const signal of signals) {
      expect(CAREER_VERDICT.test(signal.supports)).toBe(false);
    }
  });

  it('keeps weak evidence weak however many rows there are', () => {
    const many = Array.from({ length: 50 }, (_v, i) =>
      resume({
        independenceKey: `resume:aaaaaaaa-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`,
      }),
    );

    const signals = deriveSignals(many, NOW);

    expect(
      signals.some((s) => s.kind === 'OBSERVED_VIA_AUTHENTICATED_ACCOUNT'),
    ).toBe(false);
    expect(signals.some((s) => s.kind === 'SELF_REPORTED_CLAIM')).toBe(
      true,
    );
  });
});

describe('corroboration counts sources, not rows', () => {
  it('does not corroborate from many rows of one source', () => {
    const repos = Array.from({ length: 14 }, (_v, i) =>
      github({ externalId: String(i), independenceKey: 'github:555' }),
    );

    expect(
      deriveSignals(repos, NOW).some(
        (s) => s.kind === 'INDEPENDENTLY_CORROBORATED',
      ),
    ).toBe(false);
  });

  it('corroborates from two genuinely independent sources', () => {
    const signals = deriveSignals([github(), resume()], NOW);

    expect(
      signals.some((s) => s.kind === 'INDEPENDENTLY_CORROBORATED'),
    ).toBe(true);
    expect(signals[0]!.basis.independentSources).toBe(2);
  });

  it('does not corroborate from rows with no independence key', () => {
    expect(
      deriveSignals(
        [
          github({ independenceKey: null }),
          github({ externalId: '2', independenceKey: null }),
        ],
        NOW,
      ).some((s) => s.kind === 'INDEPENDENTLY_CORROBORATED'),
    ).toBe(false);
  });
});

describe('sources keep their character', () => {
  it('keeps a resume a claim rather than an observation', () => {
    const signals = deriveSignals([resume()], NOW);
    const kinds = signals.map((s) => s.kind);

    expect(kinds).toContain('SELF_REPORTED_CLAIM');
    expect(kinds).not.toContain('OBSERVED_VIA_AUTHENTICATED_ACCOUNT');
    expect(signals[0]!.basis.trustClass).toBe('WEAK');
  });

  it('keeps a direct observation a bounded observation', () => {
    const signals = deriveSignals([github()], NOW);

    expect(signals.map((s) => s.kind)).toContain(
      'OBSERVED_VIA_AUTHENTICATED_ACCOUNT',
    );

    const observed = signals.find(
      (s) => s.kind === 'OBSERVED_VIA_AUTHENTICATED_ACCOUNT',
    )!;

    expect(observed.supports).toMatch(/attributed this activity/i);
    expect(observed.doesNotEstablish.join(' ')).toMatch(/seniority/i);
  });
});

describe('determinism and purity', () => {
  it('returns the same signals in the same order regardless of input order', () => {
    const set = [github(), resume(), github({ externalId: '9' })];
    const reversed = [...set].reverse();

    expect(deriveSignals(set, NOW)).toEqual(deriveSignals(reversed, NOW));
  });

  it('does not mutate the records it is given', () => {
    const records = [Object.freeze(github()), Object.freeze(resume())];
    const before = JSON.stringify(records);

    expect(() => deriveSignals(records, NOW)).not.toThrow();
    expect(JSON.stringify(records)).toBe(before);
  });

  it('does not let a caller edit the shared vocabulary through a signal', () => {
    const signal = deriveSignals([github()], NOW)[0] as Signal;

    signal.doesNotEstablish.push('tampered');

    expect(
      SIGNAL_VOCABULARY.OBSERVED_VIA_AUTHENTICATED_ACCOUNT.doesNotEstablish,
    ).not.toContain('tampered');
  });

  /*
   * Purity enforced by reading the source, because "writes nothing" is a
   * property no unit test can observe by calling the function. If a
   * persistence import ever appears here, this fails.
   */
  it('imports nothing that can write', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./signal.ts', import.meta.url)),
      'utf8',
    );

    /*
     * Comments stripped before scanning, the same way
     * security-boundary.spec.ts does it. Otherwise the file's own
     * promise not to touch UserSkill reads as touching UserSkill.
     */
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const imports = [...raw.matchAll(/^import[^;]+from\s+'([^']+)'/gm)].map(
      (match) => match[1]!,
    );

    expect(imports).toEqual(['./contract.js', './trust.js']);

    for (const forbidden of [
      'prisma',
      'PrismaService',
      'userSkill',
      'UserSkill',
      'careerGraph',
      '.create(',
      '.update(',
      '.upsert(',
      '.delete(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
