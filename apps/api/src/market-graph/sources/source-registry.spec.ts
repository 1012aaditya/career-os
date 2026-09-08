import { describe, expect, it } from 'vitest';

import { GreenhouseClient } from './greenhouse/greenhouse.client.js';
import { JobTechClient } from './jobtech/jobtech.client.js';
import { MarketSourceRegistry } from './source-registry.js';
import { TeachingVacanciesClient } from './teaching-vacancies/teaching-vacancies.client.js';

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
  return new MarketSourceRegistry(
    new GreenhouseClient(),
    new JobTechClient(),
    new TeachingVacanciesClient(),
  );
}

describe('the source registry', () => {
  it('declares exactly the sources Phase 8 ingests, and no others', () => {
    expect(
      registry()
        .descriptors()
        .map((source) => source.slug),
    ).toEqual(['greenhouse', 'jobtech', 'teaching-vacancies']);
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

describe('what a descriptor may carry', () => {
  /*
   * queryParams is stored VERBATIM on every ingestion run and hashed into
   * queryFingerprint - which GET /v1/market/signals/:id serves. So a
   * credential put here would become a plaintext secret in the database
   * and, because the rest of the object is public in this file, a
   * brute-forceable commitment to that secret served over HTTP.
   *
   * No source needs a key today. The first authenticated one will, and the
   * obvious place to put it is exactly here - which is why this test
   * exists before that source does. A key belongs in the client, read from
   * configuration, sent as a header.
   *
   * user-agent is in the pattern deliberately: USAJOBS requires the
   * operator's own email address as a User-Agent header, which is both a
   * credential and personal data.
   */
  const CREDENTIAL_SHAPED =
    /key|token|secret|auth|password|credential|bearer|user-?agent/i;

  it('carries no credential-shaped key in queryParams', () => {
    for (const source of registry().descriptors()) {
      const offending = Object.keys(source.queryParams).filter((key) =>
        CREDENTIAL_SHAPED.test(key),
      );

      expect(`${source.slug}: ${offending.join(',')}`).toBe(`${source.slug}: `);
    }
  });

  it('carries no credential-shaped VALUE in queryParams either', () => {
    for (const source of registry().descriptors()) {
      for (const value of Object.values(source.queryParams)) {
        /*
         * A long opaque string is what an API key looks like. Every real
         * queryParams value is a short enum, a number or a boolean.
         */
        expect(
          typeof value === 'string' && value.length > 40 ? source.slug : 'ok',
        ).toBe('ok');
      }
    }
  });

  it('detects a planted credential, so the checks above are not vacuous', () => {
    expect(CREDENTIAL_SHAPED.test('apiKey')).toBe(true);
    expect(CREDENTIAL_SHAPED.test('Authorization-Key')).toBe(true);
    expect(CREDENTIAL_SHAPED.test('User-Agent')).toBe(true);
    expect(CREDENTIAL_SHAPED.test('pageSize')).toBe(false);
  });

  /*
   * Required by the type, so this cannot regress silently - but a source
   * could still declare an empty profile without anyone asking whether
   * that is true of its market. This is the line that makes it a decision.
   */
  it('declares a contact-redaction profile for every source', () => {
    for (const source of registry().descriptors()) {
      expect(
        Array.isArray(source.adapter.contactRedaction.structuredFields),
      ).toBe(true);
      expect(source.adapter.contactRedaction.nationalPhone).not.toBeUndefined();
    }
  });
});
