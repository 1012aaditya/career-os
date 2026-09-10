# Technology Stack

**Analysis Date:** 2026-09-10

## Languages

**Primary:**
- TypeScript 6.0.x - API (`apps/api`), Mobile (`apps/mobile`), shared utilities
- JavaScript - Package scripts and configuration

**Secondary:**
- Swift/Kotlin - iOS/Android native modules (via Expo/React Native)

## Runtime

**Environment:**
- Node.js (nodenext module resolution) - API backend
- Expo Runtime ~57.0.20 - Mobile app (iOS, Android, web)

**Package Manager:**
- pnpm 11.25.0
- Lockfile: Yes (pnpm-lock.yaml)

## Frameworks

**Backend:**
- NestJS 12.0.x - REST API framework
  - Platform: Express
  - Modules: Common, Core, Config, Platform-Express, Swagger, Testing, Schematics, CLI

**Frontend/Mobile:**
- React 19.2.3 - UI library
- React Native 0.86.3 - Cross-platform mobile
- Expo ~57.0.20 - Native app development
- React Navigation 7.3.x-7.18.x - Mobile navigation
  - Bottom Tabs, Native Stack navigation

**Testing:**
- Vitest 4.1.x - Unit and E2E tests
- Vitest Coverage v8 - Code coverage reporting
- Supertest 7.0.0 - HTTP assertion library
- NestJS Testing module - Test utilities for NestJS

**Build/Dev:**
- Prisma 7.10.0 - ORM and database toolkit
- Oxlint 1.58.0 - Rust-based linter
- Prettier 3.4.2 - Code formatter

## Key Dependencies

**Critical:**
- `@prisma/client` 7.10.0 - Database ORM client
- `@prisma/adapter-pg` 7.10.0 - PostgreSQL adapter for Prisma
- `@supabase/supabase-js` 2.114.0 - Supabase SDK for auth and storage
- `pg` 8.23.0 - PostgreSQL client driver
- `ioredis` 6.0.0 - Redis client (installed but appears unused)

**Validation:**
- `class-validator` 0.15.1 - DTO validation decorators
- `class-transformer` 0.5.1 - DTO transformation

**Mobile:**
- `@react-native-async-storage/async-storage` 3.1.1 - Local storage for React Native
- `react-native-safe-area-context` 5.7.0 - Safe area handling
- `react-native-screens` 4.26.2 - Native screen navigation optimization
- `react-native-svg` 15.15.4 - SVG support
- `expo-document-picker` 57.0.1 - File picker for document/resume uploads
- `expo-status-bar` 57.0.1 - Status bar control

**Utilities:**
- `reflect-metadata` 0.2.2 - Decorator reflection (required by NestJS)
- `rxjs` 7.8.1 - Reactive programming library

**API Documentation:**
- `@nestjs/swagger` 12.0.1 - OpenAPI/Swagger integration
- Swagger UI hosted at `/docs`

## Configuration

**Environment:**
- ConfigModule (NestJS) with `.env` file support
- Environment-based configuration via `process.env`

**Build:**
- `tsconfig.json` - Base TypeScript configuration
- `apps/api/tsconfig.json` - API-specific TypeScript config (target: ES2023)
- `apps/api/tsconfig.build.json` - Build-specific configuration
- `apps/mobile/tsconfig.json` - Extends Expo's base config
- `apps/api/nest-cli.json` - NestJS CLI configuration

**Database:**
- Prisma config: `apps/api/prisma.config.ts`
- Schema: `apps/api/prisma/schema.prisma`
- Migrations: `apps/api/prisma/migrations/` (PostgreSQL migrations)

## Platform Requirements

**Development:**
- Node.js with nodenext module resolution
- pnpm 11.25.0 or compatible
- PostgreSQL database (local or remote)
- Expo CLI for mobile development
- CocoaPods for iOS development (implicit via Expo)

**Production:**
- Node.js runtime for API server
- PostgreSQL database
- Supabase project (for auth and file storage)
- iOS/Android app distribution (via App Store, Google Play, or direct installation)

**API Server:**
- Runs on PORT (default: 3000)
- Requires `DATABASE_URL` environment variable
- Bearer token authentication via `AuthGuard`

---

*Stack analysis: 2026-09-10*
