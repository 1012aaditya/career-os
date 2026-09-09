import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { CredentialState } from './source-access.js';

/*
 * Credentials for sources that need one.
 *
 * No source needed one for the whole of Phase 8, and the registry spec
 * wrote a test against that day arriving anyway: `queryParams` is stored
 * verbatim on every ingestion run and hashed into a fingerprint the API
 * serves, so a key put there would become a plaintext secret in the
 * database AND a brute-forceable commitment to it over HTTP. This file is
 * the place that test pointed at.
 *
 * THE RULES, and they are the whole design:
 *
 *   Values are read from configuration and returned to exactly one caller
 *   - the client that is about to build a request header. They are never
 *   stored, never put on a descriptor, never put in queryParams, never
 *   returned from an API, never logged, and never attached to an error.
 *
 *   A missing credential is its own outcome, not a failure. `state()`
 *   answers without throwing so the gate can refuse a run with the code
 *   `credentials_missing` - which is a different operational fact from a
 *   provider returning 401, and sends somebody to check a different thing.
 *
 *   Nothing here ever invents a value. There is no development default, no
 *   empty-string fallback and no "" placeholder: a blank value is MISSING,
 *   because a request sent with an empty Authorization header is a request
 *   that will fail confusingly rather than one that will fail clearly.
 */

/**
 * What one source needs configured, by environment variable name.
 *
 * Names, not values, and it lives on the adapter's descriptor where the
 * rest of that source's knowledge lives. `null` on a descriptor means the
 * source genuinely needs nothing - which is a claim somebody makes, not a
 * field they forgot.
 */
export type SourceCredentialRequirement = {
  readonly envKeys: readonly string[];
};

/**
 * Thrown when a credential is asked for and is not configured.
 *
 * Carries key names and no values. Deliberately not an HTTP exception:
 * this is reached from the ingestion path, which is a CLI, and dressing it
 * as a 500 would suggest somewhere to send it.
 */
export class MissingCredentialError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super(`Missing market source credentials: ${[...missingKeys].sort().join(', ')}`);

    this.name = 'MissingCredentialError';
    this.missingKeys = [...missingKeys].sort();
  }
}

@Injectable()
export class MarketSourceCredentials {
  constructor(
    /*
     * Optional so the CLI and the unit tests can construct this without a
     * ConfigModule; process.env is then read directly, which is the same
     * source ConfigService reads after ConfigModule.forRoot has loaded the
     * .env file. Not a fallback that invents anything - just the same
     * values by a shorter path.
     */
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Whether this source's credentials are configured, without throwing.
   *
   * The gate calls this. It returns key names so a refusal can say what to
   * set, and it returns them in the requirement's own order rather than
   * the environment's, so two machines report the same thing.
   */
  state(requirement: SourceCredentialRequirement | null): CredentialState {
    if (requirement === null || requirement.envKeys.length === 0) {
      return { kind: 'NOT_REQUIRED' };
    }

    const missingKeys = requirement.envKeys.filter(
      (key) => this.read(key) === null,
    );

    return missingKeys.length === 0
      ? { kind: 'CONFIGURED' }
      : { kind: 'MISSING', missingKeys };
  }

  /**
   * The values, for the one caller that builds a request.
   *
   * Throws rather than returning a partial map, so a client cannot send a
   * request with half its authentication and read the provider's 401 as
   * evidence about the provider.
   */
  resolve(
    requirement: SourceCredentialRequirement,
  ): Readonly<Record<string, string>> {
    const resolved: Record<string, string> = {};
    const missing: string[] = [];

    for (const key of requirement.envKeys) {
      const value = this.read(key);

      if (value === null) {
        missing.push(key);
        continue;
      }

      resolved[key] = value;
    }

    if (missing.length > 0) {
      throw new MissingCredentialError(missing);
    }

    return resolved;
  }

  /**
   * One value, or null.
   *
   * A whitespace-only value is null. An operator who exports an empty
   * variable has not configured a credential, and treating that as
   * configured turns a clear "not set up here" into an opaque provider
   * rejection.
   */
  private read(key: string): string | null {
    const raw = this.config?.get<string>(key) ?? process.env[key];

    if (typeof raw !== 'string' || raw.trim() === '') {
      return null;
    }

    return raw;
  }
}
