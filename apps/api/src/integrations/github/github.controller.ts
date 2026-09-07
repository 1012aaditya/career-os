import {
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { Response } from 'express';

import { AuthGuard } from '../../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../../auth/auth.guard.js';

import { GithubConnectionService } from './github-connection.service.js';
import { GithubOAuthService } from './github-oauth.service.js';
import {
  GithubConnectionUnavailableError,
  GithubSyncFailedError,
  GithubSyncService,
} from './github-sync.service.js';

/*
 * The GitHub connection lifecycle.
 *
 * The guard is applied per method rather than to the whole controller,
 * because one route here is deliberately public: GitHub redirects a
 * browser to /callback, and that browser carries no credential of ours.
 * A class-level guard plus a public-route escape hatch would express the
 * same thing less honestly - it makes "public" the exception that is easy
 * to add by accident. Written this way, every authenticated route says so
 * on its own line, and forgetting one is visible in review.
 */
@Controller('github')
export class GithubController {
  constructor(
    private readonly oauth: GithubOAuthService,
    private readonly connections: GithubConnectionService,
    private readonly sync: GithubSyncService,
  ) {}

  /**
   * Starts the flow. Authenticated, because this is where the pending
   * request is bound to a user - the only place that binding can be
   * established truthfully.
   */
  @Post('connect')
  @UseGuards(AuthGuard)
  async connect(
    @Req() req: AuthenticatedRequest,
  ) {
    const result =
      await this.oauth.createAuthorizationRequest(
        req.user.id,
      );

    return {
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  /**
   * GitHub's redirect target. Public by necessity.
   *
   * Responds with a bare 302 and no body. That is a security requirement
   * rather than a style choice: this URL carries the authorization code
   * and the state in its query string, and any rendered content - an
   * image, a font, an analytics snippet, a client-side error reporter -
   * would send the whole URL to a third party in the Referer header.
   *
   * Query parameters are read individually rather than through a DTO. The
   * global ValidationPipe runs with forbidNonWhitelisted, so a validated
   * DTO would answer an unexpected parameter with a JSON 400 rendered in
   * the user's browser instead of returning them to the app.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const outcome =
      await this.oauth.handleCallback({
        code,
        state,
        error,
      });

    res.setHeader(
      'Referrer-Policy',
      'no-referrer',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader(
      'Location',
      this.oauth.buildRedirectUrl(outcome),
    );

    /*
     * status().end() rather than res.redirect().
     *
     * Express's redirect() helper writes a courtesy body - "Found.
     * Redirecting to ...", as HTML when the client accepts it - which
     * defeats the whole reason this response is bare. A body means a
     * document, a document can reference a resource, and a resource
     * request carries this URL, with its authorization code and state, to
     * a third party in the Referer header.
     *
     * Nothing needs the body: the only client here is a browser following
     * a redirect.
     */
    res.status(302).end();
  }

  /**
   * The app's source of truth after a callback. Deliberately so: the deep
   * link carries only a hint, and the real state is read here under the
   * user's own authentication.
   */
  @Get('status')
  @UseGuards(AuthGuard)
  async status(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.connections.getStatus(
      req.user.id,
    );
  }

  @Delete('disconnect')
  @UseGuards(AuthGuard)
  async disconnect(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.connections.disconnect(
      req.user.id,
    );
  }

  /**
   * Runs a sync for the caller's own connection.
   *
   * The user id comes from the guard and from nowhere else - there is no
   * body, no query parameter and no path parameter on this route, so
   * there is no shape in which a caller can name somebody else's account
   * and no validation gap through which one could be smuggled.
   *
   * The response carries counts, flags, a status and two instants. It
   * never carries the access token, the encrypted columns, an
   * Authorization header, a raw GitHub payload, or an error object - see
   * GithubSyncSummary, whose fields are enumerated for exactly that
   * reason, and GithubSyncFailedError, which exists so that a failure has
   * nothing to leak.
   *
   * Errors are mapped here rather than thrown as HTTP exceptions from the
   * service, so the service stays a use case that a job runner or a
   * future scheduled sync can call without an HTTP layer attached.
   */
  @Post('sync')
  @UseGuards(AuthGuard)
  async runSync(
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      return await this.sync.sync(req.user.id);
    } catch (error) {
      if (
        error instanceof
        GithubConnectionUnavailableError
      ) {
        /*
         * 404, and the same message whether the connection is absent,
         * revoked or credential-less. The internal `reason` is not
         * rendered: the fix is identical in all three cases - connect
         * GitHub again - and a response that distinguishes them is a
         * response that describes the state of a stored credential.
         */
        throw new NotFoundException(
          'No active GitHub connection',
        );
      }

      if (
        error instanceof GithubSyncFailedError
      ) {
        /*
         * 502 rather than 500: the run opened and was recorded as
         * FAILED, and what went wrong was almost always upstream. The
         * body carries the reason CODE - a value assembled from our own
         * vocabulary - and never a message from a caught error.
         */
        throw new HttpException(
          {
            statusCode:
              HttpStatus.BAD_GATEWAY,
            status: 'FAILED',
            error: error.reasonCode,
            message: 'GitHub sync failed',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      /*
       * Everything else - notably the ConflictException raised when a
       * sync is already running for this connection - is already an
       * HTTP exception with a safe message and is left alone.
       */
      throw error;
    }
  }
}
