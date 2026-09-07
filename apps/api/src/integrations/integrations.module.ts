import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EncryptionService } from './crypto/encryption.service.js';

/*
 * The External Evidence Layer.
 *
 * Phase 7.1 registers only the encryption boundary. The OAuth flow (7.2),
 * the GitHub client (7.3) and evidence ingestion (7.4) join this module as
 * they are built, so the credential handling exists and is tested before
 * anything can acquire a credential to handle.
 */
@Module({
  imports: [ConfigModule],
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class IntegrationsModule {}
