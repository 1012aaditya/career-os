import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

import { EncryptionService } from './crypto/encryption.service.js';
import { GithubApiClient } from './github/github-api.client.js';
import { GithubConnectionService } from './github/github-connection.service.js';
import { GithubController } from './github/github.controller.js';
import { GithubOAuthConfig } from './github/github-oauth.config.js';
import { GithubOAuthService } from './github/github-oauth.service.js';
import { OAuthStateService } from './oauth/oauth-state.service.js';

/*
 * The External Evidence Layer.
 *
 * Phase 7.1 registered the encryption boundary. Phase 7.2 adds the GitHub
 * connection lifecycle on top of it. Repository ingestion and evidence
 * arrive in 7.3 and 7.4; nothing here fetches repositories or writes an
 * Evidence row.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [GithubController],
  providers: [
    EncryptionService,
    OAuthStateService,
    GithubOAuthConfig,
    GithubApiClient,
    GithubConnectionService,
    GithubOAuthService,
  ],
  exports: [
    EncryptionService,
    GithubConnectionService,
  ],
})
export class IntegrationsModule {}
