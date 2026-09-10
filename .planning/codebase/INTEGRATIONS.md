# External Integrations

**Analysis Date:** 2026-09-10

## APIs & External Services

**Authentication & Authorization:**
- Supabase Auth - User authentication and session management
  - SDK: `@supabase/supabase-js` 2.114.0
  - Implementation: `apps/api/src/auth/supabase.client.ts`, `apps/mobile/src/lib/supabase.ts`
  - Service role auth (server-side): Uses `SUPABASE_SERVICE_ROLE_KEY`
  - Anon auth (client-side): Uses `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  - Features: Session persistence via AsyncStorage (mobile), auto token refresh (mobile)

## Data Storage

**Databases:**
- PostgreSQL
  - Connection: `DATABASE_URL` environment variable
  - Default (dev): `postgresql://localhost:5432/career_os`
  - Adapter: `@prisma/adapter-pg` 7.10.0
  - Client: `pg` 8.23.0 via Prisma ORM

**File Storage:**
- Supabase Storage
  - Implementation: `apps/api/src/resume-processing/resume-processing.service.ts`
  - Bucket: `resumes` (stores uploaded resume files)
  - Features: Signed URL generation with 300-second expiration
  - Used by: Resume upload and processing flow

**Caching:**
- ioredis 6.0.0 (installed but NOT actively used in codebase)

## Authentication & Identity

**Auth Provider:**
- Supabase (custom implementation via service client)
  - Implementation: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.module.ts`
  - Guard: `apps/api/src/auth/auth.guard.ts`
  - Token validation: Bearer token via Authorization header
  - User context: Passed via `AuthenticatedRequest` type

**Session Management:**
- Mobile: AsyncStorage-backed session persistence via Supabase auth config
- API: Stateless bearer token validation

## Monitoring & Observability

**Error Tracking:**
- Not detected

**Logs:**
- Console logging (`console.error` for resume storage errors)
- Startup logging for DATABASE_URL presence check

## CI/CD & Deployment

**Hosting:**
- Not detected in current codebase

**CI Pipeline:**
- Not detected in current codebase

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - PostgreSQL connection string
- `SUPABASE_URL` - Supabase project URL (API backend)
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role API key (API backend)
- `PORT` - Server port (default: 3000)
- `EXPO_PUBLIC_SUPABASE_URL` - Supabase project URL (mobile app)
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` - Supabase anon key (mobile app)
- `EXPO_PUBLIC_API_URL` - Career OS API URL (mobile app)

**Secrets location:**
- Environment variables via `.env` files (development)
- Environment variables via process.env (production)
- Supabase credentials: Service role key (server-side), Anon key (client-side)

**Public vs Private:**
- `EXPO_PUBLIC_*` variables are embedded in mobile app build
- Service-role key restricted to backend (never exposed to client)

## Webhooks & Callbacks

**Incoming:**
- Not detected

**Outgoing:**
- Not detected

## Data Models & Integrations

**Resume Processing Flow:**
- Endpoint: `POST /v1/resume-imports` (`apps/api/src/resume-import/resume-import.controller.ts`)
- Upload: Signed URL from Supabase Storage
- Processing: Queue system via resume-processing module (worker pattern)
- Status: PENDING → PROCESSING → NEEDS_REVIEW → CONFIRMED or FAILED
- Data extraction: Stored as JSON in `ResumeImport` model

**Career Graph Integration:**
- Endpoint: `GET /v1/career-graph` (`apps/api/src/career-graph/career-graph.controller.ts`)
- Ingestion: Resume data processed into structured graph via `CareerGraphIngestion` model
- Related to: User profiles, experiences, projects, skills, achievements, evidence

**API Documentation:**
- Swagger/OpenAPI endpoint: `/docs`
- Framework: `@nestjs/swagger` 12.0.1
- Auth: Bearer token support configured

---

*Integration audit: 2026-09-10*
