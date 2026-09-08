import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MarketGraphService } from '../../src/market-graph/market-graph.service.js';
import { MarketSignalService } from '../../src/market-graph/signals/market-signal.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  createMarketTestContext,
  MarketFixture,
  truncateMarket,
} from './market-db.js';

/*
 * Does the explanation describe the population the number was computed
 * from?
 *
 * Answering it needs the signal and its explanation to come from the SAME
 * rows, which means computing a real signal with the real service and then
 * explaining it with the real read service. Nothing in the hermetic suite
 * constructs either, which is why this shipped wrong: with two sources
 * loaded, explainSignal returned 168 mention rows for a signal whose
 * numerator was 22, 145 of them from the other source.
 *
 * Every decoy below exists to make one filter load-bearing. Without them
 * the fixture would pass against a completely unfiltered implementation -
 * if every posting is in scope, eligible, in window and on the right role,
 * returning everything is returning the right answer.
 */

const RULESET = 2;
const T0 = new Date('2026-01-10T00:00:00.000Z');
const T1 = new Date('2026-02-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Inside the window, after every posting's last sighting. */
const ALPHA_COMPLETE_AT = new Date(T0.getTime() + 20 * DAY);

let app: INestApplicationContext;
let prisma: PrismaService;
let graph: MarketGraphService;
let signals: Array<{
  id: string;
  signalType: string;
  numeratorCount: number;
  denominatorCount: number;
  skillSlug: string | null;
  roleSlug: string;
}>;

beforeAll(async () => {
  app = await createMarketTestContext();
  prisma = app.get(PrismaService);
  graph = app.get(MarketGraphService);

  await truncateMarket(prisma);

  const fixture = new MarketFixture(prisma, RULESET);

  await fixture.source('src-a');
  await fixture.source('src-b');

  await fixture.coverage('src-a', 'alpha', { finishedAt: ALPHA_COMPLETE_AT });
  /*
   * Complete, but complete BEFORE beta's postings were last seen - so beta
   * is UNAVAILABLE. This single row is the guard for two separate
   * mutations: grouping the coverage maximum per SOURCE would lend alpha's
   * later certificate to beta, and dropping the completeForScope filter
   * would let the incomplete row below stand in for a complete read.
   */
  await fixture.coverage('src-a', 'beta', { finishedAt: T0 });
  await fixture.coverage('src-a', 'beta', {
    run: 'later-incomplete',
    completeForScope: false,
    finishedAt: new Date(T0.getTime() + 25 * DAY),
  });
  await fixture.coverage('src-a', 'gamma', { completeForScope: false });
  await fixture.coverage('src-b', 'alpha', { finishedAt: ALPHA_COMPLETE_AT });

  const ts = ['typescript'];

  /* The four true contributors to typescript prevalence. */
  await fixture.posting({
    key: 'p-a',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: ts },
    ],
  });
  await fixture.posting({
    key: 'p-b',
    sourceSlug: 'src-a',
    scope: 'beta',
    company: 'globex',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  await fixture.posting({
    key: 'p-c',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'initech',
    versions: [
      {
        observedAt: new Date(T0.getTime() + 2 * DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  /* Mentions typescript in BOTH loci: two mention rows, one posting. */
  await fixture.posting({
    key: 'p-multi',
    sourceSlug: 'src-a',
    scope: 'beta',
    company: 'umbrella',
    versions: [
      {
        observedAt: new Date(T0.getTime() + 3 * DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
        alsoInTitle: 'typescript',
      },
    ],
  });

  /* Eligible, role-resolved, but not mentioning typescript: denominator only. */
  await fixture.posting({
    key: 'p-d',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + 4 * DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ['react'],
      },
    ],
  });
  await fixture.posting({
    key: 'p-e',
    sourceSlug: 'src-a',
    scope: 'beta',
    company: 'globex',
    versions: [
      {
        observedAt: new Date(T0.getTime() + 5 * DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ['react'],
      },
    ],
  });

  /* One decoy per filter. Each is p-a in every respect but one. */
  await fixture.posting({
    key: 'd-scope',
    sourceSlug: 'src-a',
    scope: 'gamma',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  await fixture.posting({
    key: 'd-source',
    sourceSlug: 'src-b',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  await fixture.posting({
    key: 'd-status',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
        extractionStatus: 'FAILED',
      },
    ],
  });
  await fixture.posting({
    key: 'd-truncated',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
        completeness: 'TRUNCATED',
      },
    ],
  });
  await fixture.posting({
    key: 'd-before',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() - 1),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  await fixture.posting({
    key: 'd-at-end',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      { observedAt: T1, roleSlug: 'backend-engineer', skillSlugs: ts },
    ],
  });
  /*
   * Edited mid-window. The EARLIER version mentions typescript and the
   * later one does not, and both have in-window sightings - so the
   * predicate this replaced ("any version sighted in the window") admits
   * the superseded one as evidence for a number computed from its
   * successor.
   */
  await fixture.posting({
    key: 'd-edited',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + HOUR),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
      },
      {
        observedAt: new Date(T0.getTime() + 2 * HOUR),
        roleSlug: 'backend-engineer',
        skillSlugs: ['react'],
      },
    ],
  });
  await fixture.posting({
    key: 'd-ruleset',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'backend-engineer',
        skillSlugs: ts,
        rulesetVersion: 1,
      },
    ],
  });
  await fixture.posting({
    key: 'd-role',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: 'frontend-engineer',
        skillSlugs: ts,
      },
    ],
  });
  await fixture.posting({
    key: 'd-unresolved',
    sourceSlug: 'src-a',
    scope: 'alpha',
    company: 'acme',
    versions: [
      {
        observedAt: new Date(T0.getTime() + DAY),
        roleSlug: null,
        skillSlugs: ts,
      },
    ],
  });

  const computed = await app.get(MarketSignalService).compute({
    sourceSlug: 'src-a',
    scopes: ['alpha', 'beta'],
    windowStart: T0,
    windowEnd: T1,
    minDenominator: 3,
    minDistinctCompanies: 2,
    rulesetVersion: RULESET,
    now: new Date(T1.getTime() + DAY),
    clock: () => new Date(T1.getTime() + DAY),
  });

  expect(computed.status).toBe('SUCCEEDED');

  const rows = await prisma.marketSignal.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      signalType: true,
      numeratorCount: true,
      denominatorCount: true,
      role: { select: { slug: true } },
      skill: { select: { slug: true } },
    },
  });

  signals = rows.map((row) => ({
    id: row.id,
    signalType: row.signalType,
    numeratorCount: row.numeratorCount,
    denominatorCount: row.denominatorCount,
    skillSlug: row.skill?.slug ?? null,
    roleSlug: row.role.slug,
  }));
});

afterAll(async () => {
  await app?.close();
});

function ids(evidence: {
  contributing: Array<{ version: { posting: { externalId: string } } }>;
}): string[] {
  return evidence.contributing.map((row) => row.version.posting.externalId);
}

async function explain(signalId: string, asOf = new Date(T1.getTime() + DAY)) {
  const { data } = await graph.explainSignal(signalId, asOf);

  return data;
}

describe('the fixture', () => {
  /*
   * Asserted before anything else. A fixture that quietly loses its
   * adversarial rows in a later refactor would keep every test below
   * green while testing nothing at all.
   */
  it('emits at least one signal of each type, with a numerator that is not the denominator', () => {
    const prevalence = signals.filter(
      (s) => s.signalType === 'ROLE_SKILL_PREVALENCE',
    );
    const volume = signals.filter(
      (s) => s.signalType === 'ROLE_POSTING_VOLUME',
    );

    expect(prevalence.length).toBeGreaterThanOrEqual(2);
    expect(volume.length).toBeGreaterThanOrEqual(1);

    for (const signal of [...prevalence, ...volume]) {
      expect(signal.numeratorCount).toBeGreaterThan(0);
      expect(signal.numeratorCount).not.toBe(signal.denominatorCount);
    }
  });

  it('holds a decoy for every filter, so no filter can be dropped unnoticed', async () => {
    const planted = await prisma.marketPosting.findMany({
      where: { externalKey: { startsWith: 'd-' } },
      select: { externalKey: true },
    });

    expect(planted.map((row) => row.externalKey).sort()).toEqual([
      'd-at-end',
      'd-before',
      'd-edited',
      'd-role',
      'd-ruleset',
      'd-scope',
      'd-source',
      'd-status',
      'd-truncated',
      'd-unresolved',
    ]);
  });

  /*
   * The regression canary. The predicate this replaced is run against the
   * same fixture and must return MORE than the numerator - which is what
   * proves the fixture still discriminates between the two.
   */
  it('is one the superseded predicate answers wrongly, so the fix is what the tests measure', async () => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;
    const stored = await prisma.marketSignal.findUniqueOrThrow({
      where: { id: signal.id },
      select: { windowStart: true, windowEnd: true, rulesetVersion: true },
    });

    const old = await prisma.marketPostingSkillMention.findMany({
      where: {
        rulesetVersion: stored.rulesetVersion,
        skill: { slug: 'typescript' },
        normalization: {
          role: { slug: 'backend-engineer' },
          version: {
            sightings: {
              some: {
                observedAt: { gte: stored.windowStart, lt: stored.windowEnd },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    expect(old.length).toBeGreaterThan(signal.numeratorCount);
  });
});

describe('explaining a prevalence signal', () => {
  it('explains exactly the postings the numerator counted', async () => {
    for (const signal of signals.filter(
      (s) => s.signalType === 'ROLE_SKILL_PREVALENCE',
    )) {
      const data = await explain(signal.id);

      expect(data.evidence.contributingPostingCount).toBe(
        signal.numeratorCount,
      );
      expect(data.evidence.kind).toBe('ELIGIBLE_POSTINGS_MENTIONING_SKILL');
    }
  });

  it('names the four postings behind the typescript numerator, and only those', async () => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;
    const data = await explain(signal.id);

    expect(signal.numeratorCount).toBe(4);
    expect(ids(data.evidence)).toEqual([
      'src-a:p-a',
      'src-a:p-b',
      'src-a:p-c',
      'src-a:p-multi',
    ]);
  });

  it.each([
    ['a scope the run did not cover', 'src-a:d-scope'],
    ['another source using the same scope token', 'src-b:d-source'],
    ['a posting whose skills could not be extracted', 'src-a:d-status'],
    ['a posting whose description we only read in part', 'src-a:d-truncated'],
    ['a sighting before the window opened', 'src-a:d-before'],
    ['a sighting at the instant the window closed', 'src-a:d-at-end'],
    ['a version the posting has since replaced', 'src-a:d-edited'],
    ['a normalization at a different ruleset', 'src-a:d-ruleset'],
    ['a different role', 'src-a:d-role'],
    ['a posting that resolved to no role', 'src-a:d-unresolved'],
  ])('draws no evidence from %s', async (_label, externalId) => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;
    const data = await explain(signal.id);

    expect(ids(data.evidence)).not.toContain(externalId);
    /* The positive control: an empty result would satisfy the line above. */
    expect(ids(data.evidence)).toContain('src-a:p-a');
  });

  it('counts a posting once however many terms resolved to the skill', async () => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;
    const data = await explain(signal.id);

    const mentions = await prisma.marketPostingSkillMention.count({
      where: {
        normalization: { version: { posting: { externalKey: 'p-multi' } } },
      },
    });

    expect(mentions).toBe(2);
    expect(
      ids(data.evidence).filter((id) => id === 'src-a:p-multi'),
    ).toHaveLength(1);
    expect(data.evidence.contributingPostingCount).toBe(signal.numeratorCount);
  });

  it('returns the same rows in the same order however the query is repeated', async () => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;

    expect(JSON.stringify(await explain(signal.id))).toBe(
      JSON.stringify(await explain(signal.id)),
    );
  });
});

describe('explaining a volume signal', () => {
  it('explains it with the postings that resolved to the role, not an empty list', async () => {
    const signal = signals.find(
      (s) =>
        s.signalType === 'ROLE_POSTING_VOLUME' &&
        s.roleSlug === 'backend-engineer',
    )!;
    const data = await explain(signal.id);

    expect(data.evidence.kind).toBe('ROLE_RESOLVED_POSTINGS');
    expect(data.evidence.contributing).not.toEqual([]);
    expect(data.evidence.contributingPostingCount).toBe(signal.numeratorCount);
  });

  /*
   * Volume's denominator is every posting that entered role resolution,
   * eligibility included. Filtering it here would be the same defect as
   * omitting it from prevalence, in the other direction.
   */
  it('includes postings a prevalence signal would have excluded as ineligible', async () => {
    const signal = signals.find(
      (s) =>
        s.signalType === 'ROLE_POSTING_VOLUME' &&
        s.roleSlug === 'backend-engineer',
    )!;
    const data = await explain(signal.id);

    expect(ids(data.evidence)).toContain('src-a:d-status');
    expect(ids(data.evidence)).toContain('src-a:d-truncated');
  });

  it('states the composition of the denominator it is a numerator of', async () => {
    const signal = signals.find((s) => s.signalType === 'ROLE_POSTING_VOLUME')!;
    const data = await explain(signal.id);

    expect(data.evidence.denominatorComposition).toMatchObject({
      postingsRoleUnresolved: expect.any(Number),
      postingsInWindow: expect.any(Number),
    });
  });

  it('carries no skill-mention fields, which a volume signal has none of', async () => {
    const signal = signals.find((s) => s.signalType === 'ROLE_POSTING_VOLUME')!;
    const data = await explain(signal.id);

    for (const row of data.evidence.contributing) {
      expect(row.mentions).toEqual([]);
    }
  });
});

describe('what the evidence may contain', () => {
  it('returns no description text and no raw payload', async () => {
    const signal = signals.find((s) => s.skillSlug === 'typescript')!;
    const body = JSON.stringify(await explain(signal.id));

    expect(body).not.toContain('descriptionRaw');
    expect(body).not.toContain('descriptionText');
    expect(body).not.toContain('rawPayload"');
  });
});
