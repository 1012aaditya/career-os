import { Controller, Delete, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AccountService } from './account.service.js';
import { ACCOUNT_DELETION_THROTTLE } from '../throttling.js';

/*
 * The account surface.
 *
 * One route, and its shape is the security control. There is no
 * `DELETE /account/:id` and no user id in a body, so there is no
 * parameter through which a caller could name somebody else's account -
 * the identity comes from `req.user.id`, which the guard sets from a token
 * it verified with Supabase and which no request header can influence.
 *
 * This is deliberately not expressed as "we check that the id matches the
 * session". A check can be forgotten when a second route is added; an
 * endpoint that has nowhere to put another user's id cannot be.
 */
@Controller('account')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /**
   * Deletes the authenticated user's account and everything it owns.
   *
   * Returns a summary rather than 204, because the caller needs to know
   * one thing that a bare success cannot express: whether the GitHub
   * grant was revoked at GitHub, or whether the user should also revoke it
   * there themselves.
   *
   * Throttled hard. This is not a route anybody calls repeatedly in normal
   * use, and it is expensive - it walks a storage prefix and cascades a
   * dozen tables.
   */
  @Delete()
  @Throttle(ACCOUNT_DELETION_THROTTLE)
  async deleteAccount(@Req() req: AuthenticatedRequest) {
    return this.account.deleteAccount(req.user.id);
  }
}
