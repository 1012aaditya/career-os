import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn();

vi.mock('../api/client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

const { EMPTY_EVIDENCE, fetchEvidence } = await import('./evidence-api');

/*
 * What path the app actually asks for.
 *
 * This is the one piece of the Evidence layer that talks to the outside
 * world, and it was the one piece with no test. The first time the screen
 * was opened against a real API it requested /v1/v1/evidence and got a
 * 404: api/client.ts appends the version to the base URL, so a path
 * carrying its own doubled it.
 *
 * Nothing in the pure logic tests could have caught that - they never
 * build a URL. These do.
 */

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue(EMPTY_EVIDENCE);
});

describe('the path the app requests', () => {
  it('does not carry its own version prefix', async () => {
    await fetchEvidence();

    const path = apiRequest.mock.calls[0]![0] as string;

    expect(path).toBe('/evidence');
    expect(path).not.toMatch(/^\/v1/);
    expect(path).not.toContain('/v1/v1');
  });

  it('matches the shape every other caller uses', async () => {
    await fetchEvidence();

    /*
     * '/account' and '/career-graph' are what the existing modules pass.
     * A leading slash and no version - the client supplies the rest.
     */
    expect(apiRequest.mock.calls[0]![0]).toMatch(/^\/[a-z-]+$/);
  });

  it('appends a source filter as a query parameter', async () => {
    await fetchEvidence({ sourceType: 'GITHUB' });

    expect(apiRequest.mock.calls[0]![0]).toBe('/evidence?sourceType=GITHUB');
  });

  it('appends a limit', async () => {
    await fetchEvidence({ limit: 25 });

    expect(apiRequest.mock.calls[0]![0]).toBe('/evidence?limit=25');
  });

  it('carries both when both are given', async () => {
    await fetchEvidence({ sourceType: 'RESUME', limit: 5 });

    const path = apiRequest.mock.calls[0]![0] as string;

    expect(path).toContain('sourceType=RESUME');
    expect(path).toContain('limit=5');
    expect(path.startsWith('/evidence?')).toBe(true);
  });

  it('sends no query string when nothing was asked for', async () => {
    await fetchEvidence({});

    expect(apiRequest.mock.calls[0]![0]).toBe('/evidence');
  });

  /*
   * A GET, and no body. The read path must never be able to write - the
   * Evidence module is registered without a single mutating route, and
   * the client call should not quietly acquire one.
   */
  it('passes no method or body, so it stays a plain GET', async () => {
    await fetchEvidence();

    expect(apiRequest.mock.calls[0]!.length).toBe(1);
  });
});
