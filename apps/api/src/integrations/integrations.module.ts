import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

import { EncryptionService } from './crypto/encryption.service.js';
import { ExternalSyncRunService } from './github/external-sync-run.service.js';
import { GithubApiClient } from './github/github-api.client.js';
import { GithubIngestionService } from './github/github-ingestion.service.js';
import { GithubRestClient } from './github/github-rest.client.js';
import { GithubConnectionService } from './github/github-connection.service.js';
import { GithubController } from './github/github.controller.js';
import { GithubOAuthConfig } from './github/github-oauth.config.js';
import { GithubOAuthService } from './github/github-oauth.service.js';
import { OAuthStateService } from './oauth/oauth-state.service.js';

/*
 * The External Evidence Layer.
 *
 * Phase 7.1 registered the encryption boundary, 7.2 the GitHub connection
 * lifecycle, and 7.3 the ingestion layer that turns GitHub responses into
 * normalized source observations.
 *
 * The ingestion services are registered but not yet reachable from any
 * route: 7.3 stops at observations, and nothing here writes an Evidence
 * row or touches the Career Graph. The endpoint that drives a sync is
 * 7.6's, and the observation-to-Evidence step is 7.4's.
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
    GithubRestClient,
    GithubIngestionService,
    ExternalSyncRunService,
  ],
  exports: [
    EncryptionService,
    GithubConnectionService,
    GithubIngestionService,
    ExternalSyncRunService,
  ],
})
export class IntegrationsModule {}
