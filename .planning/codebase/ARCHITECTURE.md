<!-- refreshed: 2026-09-10 -->
# Architecture

**Analysis Date:** 2026-09-10

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     Client Layer (Mobile)                           │
│  React Native (Expo) - iOS/Android                                  │
│  `apps/mobile/src/screens` | `apps/mobile/src/navigation`           │
└───────────────────────┬─────────────────────────────────────────────┘
                        │
                        │ HTTP + Bearer Auth (Supabase JWT)
                        │
┌───────────────────────▼─────────────────────────────────────────────┐
│                    API Layer (Backend)                              │
│  NestJS HTTP API - `apps/api/src/main.ts`                           │
├──────────────┬──────────────┬──────────────┬────────────────────────┤
│ Auth Module  │ Career Graph │ Resume       │  Resume Processing     │
│ `auth/`      │ `career-gra  │ Import       │  `resume-processing/`  │
│              │ ph/`         │ `resume-     │                        │
│              │              │ import/`     │                        │
└──────────────┴──────────────┴──────────────┴──────────┬─────────────┘
                                                        │
                                     ┌──────────────────┼──────────────────┐
                                     │                  │                  │
                        ┌────────────▼──────┐  ┌───────▼─────────┐  ┌─────▼──────────┐
                        │  Prisma Service   │  │ Supabase Client │  │ Health Check   │
                        │ `prisma/`         │  │ Auth (JWT)      │  │ `health.ctrl`  │
                        │ PostgreSQL + PG   │  │ Storage (Resume │  │                │
                        │ Adapter           │  │ Bucket)         │  │                │
                        └────────────┬──────┘  └─────────────────┘  └────────────────┘
                                     │
                        ┌────────────▼──────────────────┐
                        │  PostgreSQL Database          │
                        │  Career Capital Schema        │
                        │  (User, Experience, Project,  │
                        │   Skill, Evidence, etc.)      │
                        └───────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Auth Guard** | Validates Bearer JWT tokens from Supabase | `apps/api/src/auth/auth.guard.ts` |
| **Auth Service** | Verifies access tokens via Supabase | `apps/api/src/auth/auth.service.ts` |
| **Career Graph Controller** | HTTP endpoint for fetching career graph | `apps/api/src/career-graph/career-graph.controller.ts` |
| **Career Graph Service** | Queries and returns complete user career graph with relationships | `apps/api/src/career-graph/career-graph.service.ts` |
| **Career Graph Ingestion Service** | Processes confirmed resume imports into career graph | `apps/api/src/career-graph/career-graph-ingestion.service.ts` |
| **Resume Import Controller** | HTTP endpoints for resume import workflow | `apps/api/src/resume-import/resume-import.controller.ts` |
| **Resume Import Service** | Manages resume file lifecycle (upload URLs, storage, metadata) | `apps/api/src/resume-import/resume-import.service.ts` |
| **Resume Processing Service** | Claims and processes pending resume extractions | `apps/api/src/resume-processing/resume-processing.service.ts` |
| **Prisma Service** | Database abstraction layer with connection pooling | `apps/api/src/prisma/prisma.service.ts` |
| **Mobile Auth Provider** | Manages Supabase session and login state | `apps/mobile/src/auth/AuthProvider.tsx` |
| **Career Graph Model** | Pure client-side graph rendering model (deterministic, testable) | `apps/mobile/src/career/graph-model.ts` |
| **Career State** | Client-side career graph state management | `apps/mobile/src/career/career-state.test.ts` |
| **Navigation Stack** | Auth/Main app routing | `apps/mobile/src/navigation/RootNavigator.tsx` |

## Pattern Overview

**Overall:** Layered API + Client architecture with clear separation of concerns.

**Key Characteristics:**
- **Module-driven backend**: NestJS modules encapsulate related services and controllers
- **Request/Response validation**: Global NestJS ValidationPipe with class-transformer/class-validator
- **Service injection**: Constructor-based dependency injection throughout
- **Deterministic graph model**: Mobile app's graph rendering is pure, side-effect-free logic
- **JWT + Supabase Auth**: Stateless authentication via Bearer tokens
- **File storage abstraction**: Resume uploads via Supabase storage with signed URLs
- **Type-safe ORM**: Prisma with PostgreSQL adapter, full type safety

## Layers

**Presentation Layer:**
- Purpose: Mobile UI screens and navigation
- Location: `apps/mobile/src/screens`, `apps/mobile/src/navigation`, `apps/mobile/src/ui`
- Contains: React Native components, navigation stacks, UI primitives
- Depends on: API clients, state management, auth provider
- Used by: End users via iOS/Android

**API Controller Layer:**
- Purpose: HTTP endpoint handlers, request routing, validation
- Location: `apps/api/src/*/**.controller.ts`
- Contains: NestJS controllers with route decorators
- Depends on: Services, guards (auth), DTOs
- Used by: Mobile client via HTTP

**Business Logic Layer:**
- Purpose: Core functionality, database operations, external integrations
- Location: `apps/api/src/*/**.service.ts`, `apps/mobile/src/career/graph-model.ts`
- Contains: Services (Auth, CareerGraph, ResumeImport, ResumeProcessing), graph algorithms
- Depends on: Prisma (API), Supabase client, utilities
- Used by: Controllers (API), UI (mobile)

**Data Persistence Layer:**
- Purpose: Database abstraction and ORM
- Location: `apps/api/src/prisma/`, `apps/api/prisma/schema.prisma`
- Contains: PrismaService, schema definitions, migrations
- Depends on: PostgreSQL, connection string
- Used by: All services that query data

**Authentication Layer:**
- Purpose: Token validation, session management
- Location: `apps/api/src/auth/`, `apps/mobile/src/auth/`
- Contains: Supabase client integration, JWT verification, auth guards
- Depends on: Supabase (external), environment variables
- Used by: All protected routes/screens

## Data Flow

### Primary Request Path: Get Career Graph

1. Mobile app calls `GET /career-graph` with `Authorization: Bearer <jwt>` (`apps/mobile/src/api/career-graph.ts`)
2. AuthGuard validates token via Supabase (`apps/api/src/auth/auth.guard.ts`)
3. CareerGraphController receives authenticated request (`apps/api/src/career-graph/career-graph.controller.ts:28-40`)
4. CareerGraphService queries entire user graph with stable ordering (`apps/api/src/career-graph/career-graph.service.ts:44-310`)
   - Includes: User profile, educations, experiences (with nested skills/projects/achievements), projects, skills, evidence, goals
   - Deterministic ordering: dated collections DESC NULLS LAST, unique tiebreaker columns
   - Join tables ordered by stable FK
5. Prisma executes query against PostgreSQL (`apps/api/src/prisma/prisma.service.ts`)
6. Response returned to mobile app
7. Mobile app's graph model processes response into visual nodes/edges (`apps/mobile/src/career/graph-model.ts`)

### Resume Import Workflow

1. **Initiate**: Mobile calls `POST /resume-imports` with fileName (`apps/mobile/src/screens/ResumeImportScreen.tsx`)
2. **Upload URL Creation**: ResumeImportService creates signed upload URL via Supabase Storage (`apps/api/src/resume-import/resume-import.service.ts:26-98`)
   - Record created in `ResumeImport` table with status `PENDING`
   - Supabase returns signed upload token/path
3. **Upload**: Mobile uploads file directly to Supabase Storage with signed URL
4. **Review**: Mobile calls `GET /resume-imports/:id` to retrieve extraction result
5. **Confirm**: Mobile calls `PATCH /resume-imports/:id` with user-edited extraction, then `POST /resume-imports/:id/confirm`
   - Status transitions to `CONFIRMED`
   - CareerGraphIngestionService called to ingest data
6. **Ingestion**: CareerGraphIngestionService processes extraction into career graph tables
   - Creates/updates Experience, Project, Skill, Achievement, Education, Evidence records
   - Tracks ingestion in `CareerGraphIngestion` table
7. **Graph Update**: Next mobile `GET /career-graph` includes newly ingested data

### State Management: Career Graph (Mobile)

1. Mobile fetches career graph via API: `getCareerGraph()` (`apps/mobile/src/api/career-graph.ts`)
2. Response cached in state (`apps/mobile/src/career/career-state.test.ts`)
3. Graph model built from cached state: `buildGraphModel()` (`apps/mobile/src/career/graph-model.ts`)
   - Pure function, testable, deterministic
   - Slices data per GRAPH_CAPS (capped nodes per type)
   - Builds node and edge arrays with emphasis computation
4. UI renders from graph model nodes/edges

## Key Abstractions

**Career Graph Model:**
- Purpose: Deterministic, testable graph representation of career data
- Examples: `apps/mobile/src/career/graph-model.ts`, `graph-fields.ts`, `relations.ts`
- Pattern: Pure functions that accept normalized career data, return visual graph structure
- Why: Decouples graph visualization from React, enables deterministic testing

**Resume Import Lifecycle:**
- Purpose: Manages stateful progress of resume file through extraction pipeline
- Examples: `apps/api/src/resume-import/resume-import.service.ts`
- States: PENDING → PROCESSING → NEEDS_REVIEW → CONFIRMED → (ingested)
- Pattern: Status column + idempotent operations (claim-for-processing)

**Evidence System:**
- Purpose: Track provenance of career data (what source, when captured)
- Examples: `apps/api/prisma/schema.prisma` Evidence model
- Sources: MANUAL, RESUME, GITHUB, PORTFOLIO, LINKEDIN, CERTIFICATION, DOCUMENT, OTHER
- Pattern: Evidence records link to career entities via join tables

**Ordered Collections Contract:**
- Purpose: Ensure deterministic pagination for capped graph display
- Examples: `apps/api/src/career-graph/career-graph.service.ts:14-43`
- Pattern: Dated collections ordered DESC NULLS LAST, all ordered by stable ID column
- Why: Mobile graph shows fixed-size slices; unstable order would change which records display

## Entry Points

**API Entry Point:**
- Location: `apps/api/src/main.ts`
- Triggers: Application startup (`npm run start` or `npm run start:dev`)
- Responsibilities: 
  - Bootstrap NestJS app
  - Configure validation pipe, versioning, Swagger docs
  - Initialize database connection
  - Listen on PORT (default 3000)

**Mobile Entry Point:**
- Location: `apps/mobile/index.ts`
- Triggers: Expo app launch
- Responsibilities:
  - Export App component
  - Initialize Supabase client
  - Set up auth provider
  - Render root navigator

**Health Check Endpoint:**
- Location: `apps/api/src/health.controller.ts`
- Route: `GET /health`
- Purpose: Readiness check for infrastructure

## Architectural Constraints

- **Authentication Model:** Stateless JWT via Supabase; no session storage. All API calls require valid Bearer token in Authorization header.
- **Database Connections:** Single PostgreSQL adapter via Prisma; connection pooling managed by PrismaPg. Cannot exceed connection limits under high concurrency.
- **Resume Storage:** All resume files stored in Supabase Storage (not database). Signed URLs allow direct browser/app uploads without proxying through API.
- **Graph Determinism:** Mobile graph model must produce identical output for identical input; no randomization in node positioning or ordering. This enables stable pagination.
- **Foreign Key Cascades:** User deletion cascades to all owned entities (experiences, projects, evidence, etc.). Careful when testing user deletion.
- **Type Safety:** Full TypeScript strict mode across API and mobile; Prisma generates types from schema. Breaking schema changes require type updates everywhere.

## Anti-Patterns

### N+1 Query Problem in Career Graph

**What happens:** Career graph service could fetch user first, then loop to fetch nested relationships.

**Why it's wrong:** Would execute hundreds of queries instead of one; kills performance on large careers.

**Do this instead:** Use Prisma's `.include()` to fetch entire graph in single query with all nested relations. See `apps/api/src/career-graph/career-graph.service.ts:48-300` for correct pattern: one top-level `findUnique()` with recursive `.include()` blocks.

### Ordering by Display Name Instead of ID

**What happens:** Sorting evidence/skills by title or name instead of stable database ID.

**Why it's wrong:** Same career data could display different records between API calls (name ties resolved differently by database). Breaks deterministic pagination in mobile graph.

**Do this instead:** Always end sort order with unique column (ID). If sorting by date, tiebreak with ID. See `career-graph.service.ts:56-70` for correct pattern.

### Mutating Graph Model State

**What happens:** Graph model in mobile app modifies arrays or objects returned from API.

**Why it's wrong:** Pure functions are not testable; state becomes unpredictable; makes determinism impossible.

**Do this instead:** Keep graph-model.ts functions pure. Accept input, return new structure, no mutations. Pass data through to rebuild graph. See `apps/mobile/src/career/graph-model.ts` for correct pattern.

### Storing Resume Upload Responses Without Validation

**What happens:** Accepting extraction result from client without checking auth/ownership.

**Why it's wrong:** User could edit another user's import or skip confirmation flow.

**Do this instead:** Always validate `userId` matches request user. See `apps/api/src/resume-import/resume-import.service.ts` pattern: check ownership before update.

## Error Handling

**Strategy:** Layered error handling with clear HTTP status codes.

**Patterns:**
- **Auth errors:** Throw `UnauthorizedException` (401) from guards and auth service
- **Validation errors:** NestJS `ValidationPipe` throws `BadRequestException` (400) with field details
- **Not found:** Throw `NotFoundException` (404) from services when entity not found
- **Conflict:** Throw `ConflictException` (409) when concurrent updates fail (e.g., resume claimed by another worker)
- **Database errors:** Catch Prisma errors, transform to appropriate HTTP errors
- **Mobile**: Handle API errors, retry on network failures, surface user-friendly messages

## Cross-Cutting Concerns

**Logging:** 
- API: NestJS logging via `Logger` injectable
- Mobile: Console-based for now, structured for Expo debugging

**Validation:** 
- API: class-validator decorators on DTOs, global ValidationPipe transforms and validates all requests
- Mobile: Manual validation for user input before API calls

**Authentication:** 
- API: AuthGuard on all protected controllers, checks Bearer token via Supabase
- Mobile: AuthProvider wraps entire app, redirects to signin if no session

**Rate Limiting:**
- Not currently implemented; consider for production API

---

*Architecture analysis: 2026-09-10*
