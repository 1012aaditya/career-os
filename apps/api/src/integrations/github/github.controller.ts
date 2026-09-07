import {
  Controller,
  Delete,
  Get,
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
}
