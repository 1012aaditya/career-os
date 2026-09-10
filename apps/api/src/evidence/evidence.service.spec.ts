import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';

/*
 * The query contract, asserted on the ARGUMENTS the service sends.
 *
 * Ordering, column selection and the row cap are properties of the query
 * rather than of any particular data, so they are checked where they are
 * decided. A fixture-driven test would pass over an implementation that
 * ordered by nothing at all, because a three-row table usually comes back
 * in insertion order anyway.
 */

const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  sourceType: 'GITHUB',
  title: 'acme/payments',
  description: 'Handles settlement',
  sourceUrl: 'https://github.com/acme/payments',
  externalId: 'github:repo:1',
  occurredAt: new Date('2024-03-15T00:00:00.000Z'),
  capturedAt: new Date('2026-09-09T00:00:00.000Z'),
  lastObservedAt: new Date('2026-09-09T00:00:00.000Z'),
  authenticity: 'DIRECT_API_OBSERVATION' as const,
  attribution: 'AUTHENTICATED_ACCOUNT' as const,
  completeness: 'PARTIAL' as const,
  transformVersion: 1,
  independenceKey: 'github:555',
};

function build(rows: (typeof ROW)[] = [ROW]) {
  const findMany = vi.fn().mockResolvedValue(rows);

  const prisma = {
    evidence: { findMany },
  } as unknown as PrismaService;

  return { service: new EvidenceService(prisma), findMany };
}

describe('the query the service sends', () => {
  it('scopes to the given user and nothing else', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a');

    expect(findMany.mock.calls[0]![0].where).toEqual({
      userId: 'user-a',
    });
  });

  /*
   * A total order. capturedAt alone is not one - a resume writes its
   * evidence in a single transaction and rows can share an instant to the
   * millisecond, at which point the database is free to choose, and a
   * client diffing two responses sees a change that did not happen.
   */
  it('orders deterministically, with a unique tiebreaker', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a');

    expect(findMany.mock.calls[0]![0].orderBy).toEqual([
      { capturedAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  /*
   * metadata is where provider-shaped detail accumulates. Not selecting
   * it makes "no internals reach the client" a property of the QUERY, so
   * a later edit that forgets to strip it cannot leak it.
   */
  it('never selects metadata', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a');

    const select = findMany.mock.calls[0]![0].select;

    expect(select).not.toHaveProperty('metadata');
    expect(Object.keys(select)).not.toContain('metadata');
  });

  it('asks for one more row than it will return, to detect truncation', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a', { limit: 5 });

    expect(findMany.mock.calls[0]![0].take).toBe(6);
  });

  it('applies the source filter only when one was given', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a', { sourceType: 'RESUME' });

    expect(findMany.mock.calls[0]![0].where).toEqual({
      userId: 'user-a',
      sourceType: 'RESUME',
    });
  });

  it('clamps the limit rather than trusting it', async () => {
    const { service, findMany } = build();

    await service.listForUser('user-a', { limit: 100_000 });
    expect(findMany.mock.calls[0]![0].take).toBe(201);

    await service.listForUser('user-a', { limit: -4 });
    expect(findMany.mock.calls[1]![0].take).toBe(2);
  });
});

describe('what the client is given', () => {
  it('exposes provenance: where from, when, and how attributed', async () => {
    const { service } = build();

    const [view] = (await service.listForUser('user-a')).evidence;

    expect(view!.sourceType).toBe('GITHUB');
    expect(view!.sourceUrl).toBe('https://github.com/acme/payments');
    expect(view!.externalId).toBe('github:repo:1');
    expect(view!.occurredAt).toBe('2024-03-15T00:00:00.000Z');
    expect(view!.capturedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(view!.lastObservedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(view!.reliability.attribution).toBe('AUTHENTICATED_ACCOUNT');
  });

  it('keeps reliability structured rather than scored', async () => {
    const { service } = build();

    const [view] = (await service.listForUser('user-a')).evidence;

    expect(Object.keys(view!.reliability).sort()).toEqual([
      'attribution',
      'authenticity',
      'completeness',
      'recency',
      'specificity',
      'transformVersion',
      'trustClass',
    ]);

    /* Named states, never a number. */
    expect(typeof view!.reliability.trustClass).toBe('string');
    for (const value of Object.values(view!.reliability)) {
      if (typeof value === 'number') {
        expect(value).toBe(view!.reliability.transformVersion);
      }
    }
  });

  it('returns no independence key and no metadata', async () => {
    const { service } = build();

    const result = await service.listForUser('user-a');
    const serialised = JSON.stringify(result);

    expect(result.evidence[0]).not.toHaveProperty('independenceKey');
    expect(result.evidence[0]).not.toHaveProperty('metadata');
    expect(serialised).not.toContain('github:555');
  });

  it('counts independent sources without returning their keys', async () => {
    const { service } = build([
      ROW,
      {
        ...ROW,
        id: '22222222-2222-2222-2222-222222222222',
        independenceKey: 'github:555',
      },
      {
        ...ROW,
        id: '33333333-3333-3333-3333-333333333333',
        sourceType: 'RESUME',
        authenticity: 'USER_CLAIM' as never,
        attribution: 'USER_ASSERTED' as never,
        completeness: 'UNKNOWN' as never,
        independenceKey: 'resume:abc',
      },
    ]);

    const result = await service.listForUser('user-a');

    /* Three rows, two sources - the whole point of the key. */
    expect(result.evidence).toHaveLength(3);
    expect(result.independentSources).toBe(2);
  });

  it('reports truncation instead of silently returning a prefix', async () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({
      ...ROW,
      id: `0000000${i}-1111-1111-1111-111111111111`,
    }));

    const { service } = build(many);

    const result = await service.listForUser('user-a', { limit: 5 });

    expect(result.evidence).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('handles a user with no evidence at all', async () => {
    const { service } = build([]);

    expect(await service.listForUser('user-a')).toEqual({
      evidence: [],
      independentSources: 0,
      truncated: false,
    });
  });
});

describe('who the endpoint reads for', () => {
  it('takes the user from the session', async () => {
    const listForUser = vi.fn().mockResolvedValue({
      evidence: [],
      independentSources: 0,
      truncated: false,
    });

    const controller = new EvidenceController({
      listForUser,
    } as unknown as EvidenceService);

    await controller.list(
      { user: { id: 'session-user' } } as never,
      {},
    );

    expect(listForUser.mock.calls[0]![0]).toBe('session-user');
  });

  /*
   * The isolation property is structural: EvidenceQueryDto has no userId
   * field, and the global ValidationPipe runs with forbidNonWhitelisted,
   * so a request carrying one is rejected before this method is entered.
   * This asserts the other half - that nothing in the query reaches the
   * identity the service is called with.
   */
  it('ignores a userId smuggled into the query', async () => {
    const listForUser = vi.fn().mockResolvedValue({
      evidence: [],
      independentSources: 0,
      truncated: false,
    });

    const controller = new EvidenceController({
      listForUser,
    } as unknown as EvidenceService);

    await controller.list({ user: { id: 'session-user' } } as never, {
      userId: 'someone-else',
    } as never);

    expect(listForUser.mock.calls[0]![0]).toBe('session-user');
    expect(JSON.stringify(listForUser.mock.calls[0]![1])).not.toContain(
      'someone-else',
    );
  });

  it('refuses a request with no verified session', async () => {
    const controller = new EvidenceController(
      { listForUser: vi.fn() } as unknown as EvidenceService,
    );

    await expect(
      controller.list({} as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      controller.list({ user: {} } as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
