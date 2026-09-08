import { describe, expect, it } from 'vitest';

import { GreenhouseClient } from './greenhouse/greenhouse.client.js';
import { JobTechClient } from './jobtech/jobtech.client.js';
import { MarketSourceRegistry } from './source-registry.js';

/*
 * The licence position, asserted rather than commented.
 *
 * Every fact below was written in a comment and believed on that basis,
 * and one of them drifted: Greenhouse's descriptor said `isEnabled: true`
 * while the schema default said false and the decision record said the
 * source was fail-closed. Nothing failed, because nothing looked. A
 * licence position that no test reads is a licence position that can be
 * changed by anyone in a hurry.
 */

function registry(): MarketSourceRegistry {
  return new MarketSourceRegistry(new GreenhouseClient(), new JobTechClient());
}

describe('the source registry', () => {
  it('declares the two sources Phase 8 ingests, and no others', () => {
    expect(
      registry()
        .descriptors()
        .map((source) => source.slug),
    ).toEqual(['greenhouse', 'jobtech']);
  });

  /*
   * The rule, stated once: ingesting a source whose right to be ingested
   * has not been established is the thing the licence column exists to
   * prevent. An unresolved position that ingests anyway is an unresolved
   * position being ignored.
   */
  it('enables no source whose licence position is unresolved', () => {
    for (const source of registry().descriptors()) {
      if (source.licenceBasis === 'UNADDRESSED_PUBLIC_ENDPOINT') {
        expect(`${source.slug}: ${source.isEnabled}`).toBe(
          `${source.slug}: false`,
        );
      }
    }
  });

  it('keeps Greenhouse unaddressed, fail-closed, and not redistributable', () => {
    const greenhouse = registry().get('greenhouse');

    expect(greenhouse.licenceBasis).toBe('UNADDRESSED_PUBLIC_ENDPOINT');
    expect(greenhouse.isEnabled).toBe(false);
    expect(greenhouse.mayRedistributeDerived).toBe(false);
  });

  /*
   * The contrast is the point. One source has an affirmative public-domain
   * grant and one has no statement at all, and they are treated
   * differently rather than averaged into "public".
   */
  it('redistributes derived aggregates only where a licence grants it', () => {
    for (const source of registry().descriptors()) {
      if (source.mayRedistributeDerived) {
        expect(`${source.slug}: ${source.licenceBasis}`).toBe(
          `${source.slug}: EXPLICIT_GRANT`,
        );
      }
    }
  });

  it('records when each licence position was last reviewed', () => {
    for (const source of registry().descriptors()) {
      expect(source.licenceReviewedAt).toBeInstanceOf(Date);
      expect(source.licenceNote.length).toBeGreaterThan(40);
    }
  });
});
