import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { ResumeProcessingController } from './resume-processing.controller.js';
import type { ResumeProcessingService } from './resume-processing.service.js';

/*
 * The worker credential.
 *
 * One long-lived shared secret stands between the public internet and a
 * signed URL for every resume in the system. These tests cover the two
 * things that decide whether that is acceptable: that it fails closed when
 * unconfigured, and that a wrong guess reveals nothing about how wrong it
 * was.
 */

const SECRET = 'a-configured-worker-secret-value';

/*
 * `configured` is passed as a one-element tuple rather than a plain
 * optional, because a default parameter swallows an explicitly-passed
 * `undefined` - so `makeController(undefined)` would have silently tested
 * the configured case, which is the exact opposite of what it claims.
 */
function makeController(configured: [string | undefined] = [SECRET]) {
  const service = {
    claimNext: vi.fn(async () => null),
    getFileUrl: vi.fn(async () => ({ signedUrl: 'x' })),
    complete: vi.fn(async () => ({})),
    fail: vi.fn(async () => ({})),
  } as unknown as ResumeProcessingService;

  const config = {
    get: vi.fn(() => configured[0]),
  } as unknown as ConfigService;

  return {
    controller: new ResumeProcessingController(service, config),
    service,
  };
}

describe('the worker secret', () => {
  it('accepts the configured value', async () => {
    const { controller, service } = makeController();

    await controller.claim(SECRET);

    expect(service.claimNext).toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret of the same length', 'b-configured-worker-secret-value'],
    ['a prefix of the real secret', 'a-configured'],
    ['a longer string starting with it', `${SECRET}-extra`],
    ['an empty string', ''],
  ])('rejects %s', async (_label, attempt) => {
    const { controller, service } = makeController();

    await expect(controller.claim(attempt)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(service.claimNext).not.toHaveBeenCalled();
  });

  it('rejects a missing header', async () => {
    const { controller } = makeController();

    await expect(controller.claim(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  /*
   * Fails closed. A worker endpoint with no configured credential must
   * reject everything rather than accept anything - the alternative is an
   * environment that forgot the variable becoming an open door.
   */
  it.each([undefined, ''])(
    'rejects everything when the secret is not configured (%j)',
    async (configured) => {
      const { controller } = makeController([configured]);

      await expect(controller.claim(SECRET)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(controller.claim(undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('guards every worker route, not only the first one', async () => {
    const { controller, service } = makeController();

    await expect(controller.getFile('wrong', 'id')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      controller.complete('wrong', { id: 'id' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.fail('wrong', { id: 'id' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(service.getFileUrl).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
    expect(service.fail).not.toHaveBeenCalled();
  });
});

describe('a malformed request from an authenticated worker', () => {
  /*
   * 400, not 401. Reporting a missing field as an auth failure sends an
   * operator to check the worker's credentials over a typo in a body.
   */
  it('is a bad request rather than an authentication failure', async () => {
    const { controller } = makeController();

    await expect(controller.complete(SECRET, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.fail(SECRET, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
