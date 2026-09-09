import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { UserStorageService } from './user-storage.service.js';

/*
 * Account lifecycle. Deletion is the whole of it today.
 *
 * It imports rather than reconstructs: AuthModule for the guard and for
 * the provisioning cache that must be cleared, IntegrationsModule for the
 * GitHub disconnect that already knows how to revoke a grant at the
 * provider. Deletion re-implementing either of those would be a second
 * place for them to drift.
 */
@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [AccountController],
  providers: [AccountService, UserStorageService],
  exports: [UserStorageService],
})
export class AccountModule {}
