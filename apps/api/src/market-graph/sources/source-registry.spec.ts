import { describe, expect, it } from 'vitest';

import { AshbyClient } from './ashby/ashby.client.js';
import { GreenhouseClient } from './greenhouse/greenhouse.client.js';
import { JobTechClient } from './jobtech/jobtech.client.js';
import { MarketSourceRegistry } from './source-registry.js';
import { CanadaJobBankClient } from './canada-job-bank/canada-job-bank.client.js';
import { JobicyClient } from './jobicy/jobicy.client.js';
import { NavClient } from './nav-no/nav-no.client.js';
import { TeachingVacanciesClient } from './teaching-vacancies/teaching-vacancies.client.js';
import { UsaJobsHistoricClient } from './usajobs-historic/usajobs-historic.client.js';
import { declarationProblems } from './source-access.js';

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
    new UsaJobsHistoricClient(),
    new NavClient(),
    new JobicyClient(),
    new CanadaJobBankClient(),
    new AshbyClient(),
  );
}

describe('the source registry', () => {
  it('declares exactly the sources Phase 8 ingests, and no others', () => {
    expect(
      registry()
        .descriptors()
        .map((source) => source.slug),
    ).toEqual([
      'greenhouse',
      'jobtech',
      'teaching-vacancies',
      'usajobs-historic',
      'nav-no',
      'jobicy',
      'canada-job-bank',
      /*
       * Phase 11's first partner-shaped source. Present, complete, and
       * ingesting nothing - which is a state the list alone cannot show,
       * so the tests below say it out loud.
       */
      'ashby',
    ]);
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

/*
 * Phase 11: what a partner source may and may not do.
 *
 * The rule the whole phase turns on is that technical availability is not
 * permission. Every check below is a way of saying that in a form a build
 * can fail on, because it is the kind of rule that erodes quietly: an
 * endpoint answers, somebody flips a boolean, and nothing anywhere
 * disagrees with them.
 */
describe('the access lifecycle', () => {
  it('holds every declaration internally consistent', () => {
    const problems = registry()
      .descriptors()
      .flatMap((source) =>
        declarationProblems({
          slug: source.slug,
          accessState: source.access.state,
          isEnabled: source.isEnabled,
          mayRedistributeDerived: source.mayRedistributeDerived,
          licenceBasis: source.licenceBasis,
          attribution: source.attribution,
        }),
      );

    expect(problems).toEqual([]);
  });

  /*
   * The one that matters. ENABLED is the only ingestible state, so this is
   * the complete list of sources this build can walk - and a source
   * arriving on it is the single most consequential diff in this file.
   */
  it('enables exactly the sources whose access has been established', () => {
    expect(
      registry()
        .descriptors()
        .filter((source) => source.access.state === 'ENABLED')
        .map((source) => source.slug),
    ).toEqual([
      'jobtech',
      'teaching-vacancies',
      'usajobs-historic',
      'jobicy',
      'canada-job-bank',
    ]);
  });

  it('never enables a source whose licence position is unresolved', () => {
    for (const source of registry().descriptors()) {
      if (source.licenceBasis === 'UNADDRESSED_PUBLIC_ENDPOINT') {
        expect(`${source.slug}: ${source.access.state}`).not.toBe(
          `${source.slug}: ENABLED`,
        );
      }
    }
  });

  it('records when each access position was last reviewed, and why', () => {
    for (const source of registry().descriptors()) {
      expect(source.access.reviewedAt).toBeInstanceOf(Date);
      expect(source.access.note.length).toBeGreaterThan(40);
    }
  });

  /*
   * Categories are about the RELATIONSHIP. A per-employer value would be
   * the per-company registry Phase 11 exists not to build, wearing an enum
   * as a disguise - so the check is that no category is a company name,
   * expressed as: the set of values used is a subset of the five.
   */
  it('categorises by relationship and never by employer', () => {
    const used = [
      ...new Set(registry().descriptors().map((source) => source.category)),
    ].sort();

    expect(used).toEqual(['ATS', 'LICENSED_AGGREGATOR', 'PUBLIC_OPEN_DATA']);
  });
});

describe('the Ashby integration, and what it does not claim', () => {
  const ashby = () => registry().get('ashby');

  /*
   * The distinction the whole phase is built to keep: the adapter is
   * finished and the source is not live, and those are two facts rather
   * than one fact with an excuse attached.
   */
  it('is implemented and is not ingesting', () => {
    expect(ashby().access.state).toBe('BLOCKED_EXTERNAL_ACCESS');
    expect(ashby().isEnabled).toBe(false);
    expect(ashby().mayRedistributeDerived).toBe(false);
    /* Implemented: a real adapter, not a placeholder. */
    expect(ashby().adapter.sourceSlug).toBe('ashby');
    expect(ashby().adapter.identityBasis).toBe('SOURCE_ID');
  });

  it('says the endpoint being open is not the same as being permitted', () => {
    expect(ashby().licenceBasis).toBe('UNADDRESSED_PUBLIC_ENDPOINT');
    expect(ashby().access.note).toContain('partner');
  });

  /*
   * No permission has been established, so nothing has told us what it
   * obliges. A credit line invented here would imply a relationship that
   * does not exist - which is a smaller lie than ingesting, and the same
   * kind.
   */
  it('claims no attribution it was never given', () => {
    expect(ashby().attribution).toBeNull();
  });

  it('declares its credential requirement by name and holds no value', () => {
    expect(ashby().credentials?.envKeys).toEqual(['ASHBY_API_KEY']);

    /* The descriptor is serialisable and contains no secret. */
    expect(JSON.stringify(ashby().credentials)).toBe(
      '{"envKeys":["ASHBY_API_KEY"]}',
    );
  });

  /*
   * A self-imposed ceiling on an ungranted endpoint. The number is ours,
   * the provider publishes none, and the note has to say so - otherwise
   * the field reads as a limit somebody granted us.
   */
  it('paces itself against a limit it set for itself', () => {
    expect(ashby().rateLimit.requestsPerMinute).toBe(60);
    expect(ashby().rateLimit.note).toContain('OUR ceiling');
  });
});

describe('what every source must now state', () => {
  it('declares a rate-limit position, even when the position is "none published"', () => {
    for (const source of registry().descriptors()) {
      const limit = source.rateLimit;

      expect(
        limit.requestsPerMinute === null ||
          (Number.isInteger(limit.requestsPerMinute) &&
            limit.requestsPerMinute > 0),
      ).toBe(true);

      /*
       * A null ceiling is the answer that needs the MOST explanation - it
       * means the provider published nothing, which is not permission to
       * go fast - so the note is required whichever way the number went.
       */
      expect(`${source.slug}: ${limit.note.length > 40}`).toBe(
        `${source.slug}: true`,
      );
    }
  });

  /*
   * Attribution is an OBLIGATION, so null is a real answer (CC0 waives it)
   * and an empty string is not - it reads as "nothing required" to every
   * truthiness check and as "present" to every null check.
   */
  it('carries attribution as a real sentence or as nothing at all', () => {
    for (const source of registry().descriptors()) {
      const attribution = source.attribution;

      expect(
        attribution === null ||
          (typeof attribution === 'string' && attribution.trim().length > 10),
      ).toBe(true);
    }
  });

  it('declares an access note that is not a copy of the licence note', () => {
    for (const source of registry().descriptors()) {
      expect(`${source.slug}: ${source.access.note === source.licenceNote}`).toBe(
        `${source.slug}: false`,
      );
    }
  });
});
