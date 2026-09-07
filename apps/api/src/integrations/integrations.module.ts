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
import { GithubSyncService } from './github/github-sync.service.js';
import { GithubEvidenceRepository } from './github/evidence/github-evidence.repository.js';
import { OAuthStateService } from './oauth/oauth-state.service.js';

/*
 * The External Evidence Layer.
 *
 * Phase 7.1 registered the encryption boundary, 7.2 the GitHub connection
 * lifecycle, and 7.3 the ingestion layer that turns GitHub responses into
 * normalized source observations.
 *
 * Phase 7.4 closes the loop: GithubEvidenceRepository writes Evidence
 * rows, and GithubSyncService is the use case that runs a whole sync -
 * connection, ingestion, projection, persistence, ledger - behind POST
 * /v1/github/sync.
 *
 * What is still NOT here: nothing in this module writes a Project,
 * Experience, Skill or UserSkill row, and nothing touches the Career
 * Graph. Deciding that a repository is a project, or that a language is a
 * skill somebody has, is interpretation and belongs to 7.5.
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
    /* New in 7.4. Everything above was already registered by 7.1-7.3. */
    GithubEvidenceRepository,
    GithubSyncService,
  ],
  exports: [
    EncryptionService,
    GithubConnectionService,
    GithubIngestionService,
    ExternalSyncRunService,
    GithubEvidenceRepository,
    GithubSyncService,
  ],
})
export class IntegrationsModule {}
