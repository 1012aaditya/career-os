# Codebase Structure

**Analysis Date:** 2026-09-10

## Directory Layout

```
career-os/                          # Monorepo root (pnpm workspaces)
├── apps/
│   ├── api/                        # NestJS HTTP API backend
│   │   ├── src/
│   │   │   ├── main.ts             # App bootstrap, Swagger setup
│   │   │   ├── app.module.ts       # Root module, imports all feature modules
│   │   │   ├── health.controller.ts # Health check endpoint
│   │   │   ├── auth/               # Authentication module
│   │   │   │   ├── auth.module.ts
│   │   │   │   ├── auth.service.ts # Supabase JWT verification
│   │   │   │   ├── auth.guard.ts   # Bearer token validation guard
│   │   │   │   ├── supabase.client.ts # Supabase client wrapper
│   │   │   │   └── auth.service.spec.ts
│   │   │   ├── career-graph/       # Career graph retrieval & ingestion
│   │   │   │   ├── career-graph.module.ts
│   │   │   │   ├── career-graph.controller.ts # GET /career-graph endpoint
│   │   │   │   ├── career-graph.service.ts    # Query entire graph with ordering
│   │   │   │   └── career-graph-ingestion.service.ts # Ingest resume into graph
│   │   │   ├── resume-import/      # Resume upload workflow
│   │   │   │   ├── resume-import.module.ts
│   │   │   │   ├── resume-import.controller.ts # Upload URLs, confirmation, ingestion
│   │   │   │   └── resume-import.service.ts
│   │   │   ├── resume-processing/  # Worker for extracting resume text
│   │   │   │   ├── resume-processing.module.ts
│   │   │   │   ├── resume-processing.controller.ts
│   │   │   │   └── resume-processing.service.ts
│   │   │   └── prisma/             # Database abstraction
│   │   │       ├── prisma.module.ts
│   │   │       └── prisma.service.ts # PrismaClient wrapper with lifecycle
│   │   ├── prisma/
│   │   │   └── schema.prisma       # Data model (User, Experience, Skill, Evidence, etc.)
│   │   ├── test/                   # E2E tests
│   │   ├── dist/                   # Compiled output (generated)
│   │   ├── package.json            # API dependencies (NestJS, Prisma, Vitest)
│   │   ├── tsconfig.json           # TypeScript config
│   │   ├── tsconfig.build.json     # Build-specific config
│   │   ├── vitest.config.ts        # Unit test runner config
│   │   ├── vitest.config.e2e.ts    # E2E test runner config
│   │   └── prisma.config.ts        # Prisma skills config
│   │
│   └── mobile/                     # React Native (Expo) app
│       ├── src/
│       │   ├── index.ts            # Expo app entry
│       │   ├── api/                # API client functions
│       │   │   ├── client.ts       # Axios/fetch base client with auth
│       │   │   ├── career-graph.ts # getCareerGraph() calls
│       │   │   ├── resume-import.ts # Resume import endpoints
│       │   │   └── resume-upload.ts # Resume file upload
│       │   ├── auth/               # Authentication & session
│       │   │   └── AuthProvider.tsx # Supabase session provider
│       │   ├── career/             # Career graph logic (pure, testable)
│       │   │   ├── graph-model.ts      # Deterministic graph rendering
│       │   │   ├── graph-fields.ts     # Field extraction utilities
│       │   │   ├── relations.ts        # Relationship types
│       │   │   ├── evidence.ts         # Evidence data manipulation
│       │   │   ├── story.ts            # Career narrative generation
│       │   │   ├── timeline.ts         # Temporal organization
│       │   │   ├── projections.ts      # Data projections
│       │   │   ├── data-quality.ts     # Data validation/cleaning
│       │   │   ├── test-fixtures.ts    # Test data factories
│       │   │   ├── graph-model.test.ts
│       │   │   ├── career-state.test.ts
│       │   │   ├── determinism.test.ts
│       │   │   ├── evidence.test.ts
│       │   │   ├── projections.test.ts
│       │   │   └── (other .test.ts files)
│       │   ├── lib/                # Shared utilities
│       │   │   └── supabase.ts     # Supabase client initialization
│       │   ├── navigation/         # React Navigation setup
│       │   │   ├── RootNavigator.tsx # Auth/Main stack switcher
│       │   │   ├── MainStackNavigator.tsx # Main app navigation
│       │   │   └── MainNavigator.tsx # Bottom tab navigator
│       │   ├── screens/            # Screen components
│       │   │   ├── auth/
│       │   │   │   └── SignInScreen.tsx # Supabase login
│       │   │   ├── main/
│       │   │   │   ├── HomeScreen.tsx # Dashboard/overview
│       │   │   │   ├── CareerScreen.tsx # Career graph visualization
│       │   │   │   ├── OpportunitiesScreen.tsx # Opportunities/goals
│       │   │   │   ├── ProfileScreen.tsx # User profile
│       │   │   │   └── ResumeImportScreen.tsx # Upload & review workflow
│       │   │   └── ResumeReviewScreen.tsx # Extracted data review
│       │   └── ui/                 # Shared UI components
│       │       ├── theme.ts        # Colors, typography, spacing
│       │       ├── index.ts        # Barrel exports
│       │       ├── AppText.tsx     # Text component with theme
│       │       ├── Button.tsx      # Button component
│       │       ├── Card.tsx        # Card container
│       │       ├── Screen.tsx      # Screen wrapper with safe area
│       │       └── states/
│       │           └── ErrorState.tsx # Error UI component
│       ├── assets/                 # Images, fonts, icons
│       ├── ios/                    # iOS build artifacts (Xcode)
│       ├── package.json            # Mobile dependencies (React Native, Expo, Supabase)
│       ├── tsconfig.json           # TypeScript config
│       └── index.ts                # Expo app export
│
├── packages/                       # Shared packages (empty/future)
│
├── docs/                           # Documentation
│   ├── career-graph/               # Career graph design docs
│   └── database/                   # Database schema docs
│
├── infrastructure/                 # Deployment & infrastructure config
│
├── package.json                    # Root workspace config (scripts: dev, build, etc.)
├── pnpm-workspace.yaml             # Workspace definition (apps/*, packages/*)
├── pnpm-lock.yaml                  # Locked dependency versions
└── .planning/                      # GSD planning documents
    └── codebase/
        ├── ARCHITECTURE.md
        └── STRUCTURE.md
```

## Directory Purposes

**`apps/api/src/`:**
- Purpose: NestJS backend API source code
- Contains: Controllers, services, modules, database integration
- Key files: `main.ts` (bootstrap), `app.module.ts` (root), `*.module.ts`, `*.service.ts`, `*.controller.ts`

**`apps/api/prisma/`:**
- Purpose: Database schema and migrations
- Contains: `schema.prisma` (full data model)
- Generated: `prisma-client` types

**`apps/mobile/src/`:**
- Purpose: React Native mobile application source code
- Contains: Screens, navigation, UI components, API clients, business logic

**`apps/mobile/src/career/`:**
- Purpose: Pure, testable career graph logic
- Contains: Graph model, field extraction, data validation
- Pattern: No React imports; 100% deterministic; fully tested

**`apps/mobile/src/screens/`:**
- Purpose: Screen components (pages/routes)
- Contains: Auth screens, main app screens
- Pattern: React components using navigation, auth, and career state

**`docs/`:**
- Purpose: High-level design documentation
- Contains: Architecture notes, database schema explanations

## Key File Locations

**Entry Points:**
- API: `apps/api/src/main.ts` - NestJS bootstrap
- Mobile: `apps/mobile/index.ts` - Expo entry
- Root: `package.json` - Workspace scripts

**Configuration:**
- Workspace: `pnpm-workspace.yaml` - Defines `apps/*` and `packages/*` as workspaces
- TypeScript: `apps/api/tsconfig.json`, `apps/mobile/tsconfig.json`
- Testing: `apps/api/vitest.config.ts`, `apps/mobile/vitest.config.ts`
- Database: `apps/api/prisma/schema.prisma`

**Core Logic:**
- Career Graph Query: `apps/api/src/career-graph/career-graph.service.ts`
- Graph Model (Mobile): `apps/mobile/src/career/graph-model.ts`
- Resume Import: `apps/api/src/resume-import/resume-import.service.ts`
- Auth: `apps/api/src/auth/auth.service.ts`, `apps/mobile/src/auth/AuthProvider.tsx`

**Testing:**
- API specs: `apps/api/src/**/*.spec.ts`
- Mobile tests: `apps/mobile/src/**/*.test.ts`
- Test fixtures: `apps/mobile/src/career/test-fixtures.ts`

## Naming Conventions

**Files:**
- Services: `*.service.ts` (e.g., `career-graph.service.ts`)
- Controllers: `*.controller.ts` (e.g., `career-graph.controller.ts`)
- Modules: `*.module.ts` (e.g., `career-graph.module.ts`)
- Tests: `*.spec.ts` (API/NestJS) or `*.test.ts` (mobile)
- Components (React): `PascalCase.tsx` (e.g., `SignInScreen.tsx`)
- Utilities: `camelCase.ts` (e.g., `graph-fields.ts`)

**Directories:**
- Feature modules: `kebab-case` (e.g., `career-graph/`, `resume-import/`)
- UI components: `ui/`
- Screens: `screens/` with subdirectories `auth/`, `main/`
- Utilities: `lib/`, `career/`

**TypeScript/Classes:**
- Classes: `PascalCase` (e.g., `CareerGraphService`, `PrismaService`)
- Functions: `camelCase` (e.g., `buildGraphModel`, `getCareerGraph`)
- Interfaces/Types: `PascalCase` (e.g., `GraphNode`, `AuthenticatedRequest`)
- Enums: `PascalCase` (e.g., `ExperienceType`, `ResumeImportStatus`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `GRAPH_CAPS`)

## Where to Add New Code

**New Feature (API):**
- Primary code: `apps/api/src/{feature-name}/`
- Structure: Create `{feature}.module.ts`, `{feature}.service.ts`, `{feature}.controller.ts`
- Example: For "goals", create `apps/api/src/goals/goals.module.ts`, etc.
- Import module in `apps/api/src/app.module.ts`
- Tests: `apps/api/src/{feature}/*.spec.ts` co-located with code

**New Screen (Mobile):**
- Implementation: `apps/mobile/src/screens/{category}/{ScreenName}.tsx`
- Categories: `auth/` for auth screens, `main/` for main app screens
- Update navigation: Register in `apps/mobile/src/navigation/`
- Tests: `apps/mobile/src/screens/{category}/{ScreenName}.test.ts` (if complex logic)

**New UI Component:**
- Shared components: `apps/mobile/src/ui/{ComponentName}.tsx`
- Theme-aware: Import from `ui/theme.ts` for colors/spacing
- Export from: `apps/mobile/src/ui/index.ts` barrel file

**New Utility Function:**
- Mobile utilities: `apps/mobile/src/lib/{feature}.ts` or `apps/mobile/src/career/{feature}.ts`
- API utilities: Create `apps/api/src/common/` directory for shared utilities
- Make testable: Avoid side effects, export pure functions

**Database Schema Change:**
- Edit: `apps/api/prisma/schema.prisma`
- Generate types: `npx prisma generate`
- Run migration: `npx prisma migrate dev --name description`
- Update services: Reflect new schema in queries/includes

## Special Directories

**`dist/` (API):**
- Purpose: Compiled TypeScript output
- Generated: `npm run build` (NestJS build)
- Committed: No (in `.gitignore`)
- Contains: Compiled `.js` files ready for Node.js execution

**`node_modules/`:**
- Purpose: Installed dependencies
- Generated: `pnpm install`
- Committed: No (in `.gitignore`)

**`.planning/codebase/`:**
- Purpose: Architecture and structure analysis documents
- Contents: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md
- Generated: By gsd-map-codebase
- Committed: Yes (serves as reference for future phases)

**`docs/`:**
- Purpose: High-level design and explanatory documentation
- Committed: Yes (human-authored design docs)

**`ios/`, `assets/` (Mobile):**
- Purpose: Native iOS build files and app assets
- Generated: Partially (ios/ by Expo/Xcode)
- Committed: Depends on project policy

## Code Organization Patterns

**NestJS Module Pattern:**
```
{feature}/
├── {feature}.module.ts        # Imports, declares controllers/providers
├── {feature}.controller.ts     # HTTP routes
├── {feature}.service.ts        # Business logic
└── {feature}.service.spec.ts   # Unit tests
```

**Mobile Component Pattern:**
```
{component name}.tsx            # Component implementation
{component name}.test.ts        # Unit/integration tests (if complex)
```

**Career Graph Logic Pattern (Mobile):**
```
career/
├── {domain}.ts                 # Pure functions, logic
├── {domain}.test.ts            # Deterministic tests
└── test-fixtures.ts            # Test data factories
```

---

*Structure analysis: 2026-09-10*
