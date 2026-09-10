# Coding Conventions

**Analysis Date:** 2026-09-10

## Naming Patterns

**Files:**
- Components (React/React Native): PascalCase — `Button.tsx`, `AppText.tsx`, `Card.tsx`
- Services and modules: camelCase with descriptive suffix — `auth.service.ts`, `prisma.service.ts`, `career-graph-ingestion.service.ts`
- Configuration and utilities: camelCase — `theme.ts`, `health.controller.ts`, `graph-fields.ts`

**Functions:**
- camelCase for all functions — `verifyAccessToken()`, `getCareerState()`, `buildDataQualityReport()`, `claimNext()`
- Verb-first naming convention for actions — `get`, `build`, `collect`, `make`, `read`, `is`
- Factory/creation functions prefixed with `make` — `makeExperience()`, `makeGraph()`, `makeStore()`
- Query/reader functions prefixed with `get` or `read` — `getCareerState()`, `readSkillId()`, `getStringField()`
- Collection functions prefixed with `collect` or `find` — `collectReversedDates()`, `findLookalikes()`

**Variables:**
- camelCase for all local variables and parameters
- Descriptive names over abbreviations — `extractionResult` not `result`, `storagePath` not `path`
- Boolean variables prefixed with `is` or `has` — `isCurrent`, `hasEndDate`, `isClean`
- Singular nouns for single items, plural for collections — `user` vs `users`, `issue` vs `issues`

**Types and Interfaces:**
- PascalCase for all types — `AuthenticatedUser`, `CareerState`, `CareerStateBasis`, `DataQualityReport`
- Type suffixes optional but descriptive — `ButtonProps`, `AuthenticatedRequest`
- Union types named descriptively — `CareerState = 'current' | 'ended' | 'unknown'`
- Record types with descriptive naming — `DataQualityEntity`, `DataQualityIssue`

**Constants:**
- camelCase for configuration objects — `colors`, `spacing`, `typography`, `radius`
- SCREAMING_SNAKE_CASE for true constants (rare) — used for KIND_ORDER in enums
- Semantic naming for theme values — `colors.primary`, `spacing.lg`, `radius.md`

## Code Style

**Formatting:**
- Tool: Prettier
- Single quotes: `'string'` not `"string"`
- Trailing commas: Always on multi-line — `{ a, b, }` in arrays and objects
- Line length: No explicit limit; follows Prettier defaults

**Linting:**
- Tool: Oxlint (in `apps/api`)
- Environment: Node.js for server code
- Notable rules:
  - `@typescript-eslint/no-explicit-any` disabled (off)
  - `@typescript-eslint/no-floating-promises` set to warn
  - Floating promises must be awaited or explicitly ignored

**TypeScript:**
- Strict mode enabled
- Module syntax: ESM with `.js` extensions in imports — `import { AuthService } from './auth.service.js'`
- Import types explicitly — `import type { AuthenticatedUser } from './types'`
- No implicit `any`

## Import Organization

**Order:**
1. Node.js built-in modules — `import { readFileSync } from 'node:fs'`
2. External packages — `import { Injectable } from '@nestjs/common'`, `import { Pressable } from 'react-native'`
3. Internal modules — `import { AuthService } from './auth.service.js'`
4. Type imports — `import type { CareerGraph } from '../api/career-graph'`

**Path Aliases:**
- Used in both `apps/api` and `apps/mobile` via `tsconfig.json`
- Prefer absolute imports over relative paths when aliases are available
- Example pattern: `@/services/*` or relative `./` for same-directory imports

**Barrel Files:**
- Used for component/utility exports — `src/ui/index.ts` exports all UI components
- Example: `export { Button } from './Button'` in `src/ui/index.ts`

## Error Handling

**Patterns:**
- NestJS exceptions for API errors:
  - `UnauthorizedException` — Invalid auth (401)
  - `ConflictException` — State conflict or constraint violation (409)
  - `NotFoundException` — Resource not found (404)
- Error messages are descriptive and actionable — `'Invalid or expired access token'` not `'Auth failed'`
- Errors are thrown with context — Include what resource failed and why
- Compare-and-swap pattern for concurrent safety:
  ```typescript
  const result = await prisma.table.updateMany({
    where: { id, status: 'EXPECTED_STATUS' },
    data: { status: 'NEW_STATUS' }
  });
  
  if (result.count !== 1) {
    throw new ConflictException('Status changed by another worker');
  }
  ```

**Error Context:**
- Database operations include the entity type and id when throwing
- Validation errors reference the field that failed
- Concurrent operations check result counts and throw if expectations unmet

## Logging

**Framework:** console (built-in)

**Patterns:**
- Minimal logging in production code
- Startup messages for diagnostics — `console.log('[startup] DATABASE_URL present: ...')`
- Bracketed prefixes for log categorization — `[startup]`, `[database]`
- No structured logging framework configured; uses plain console.log/error

## Comments

**When to Comment:**
- Explain WHY, not WHAT
- Document contract expectations and invariants
- Clarify non-obvious algorithm choices
- Explain concurrency/async behavior concerns

**Example Patterns:**

Complex logic with deep explanation:
```typescript
/*
 * rawExtractionResult is written here and nowhere else. The user's
 * review overwrites extractionResult in place, so without a pristine
 * copy taken at delivery there is no way to answer what the AI
 * originally produced.
 */
```

Contract expectations:
```typescript
/*
 * MIRRORS the list in apps/api/src/career-graph/career-graph-ingestion.service.ts
 * (ONGOING_MARKERS). Ingestion uses it to decide isCurrent; this uses it to
 * decide whether that decision was stated by the source or assumed from a
 * missing date. No shared package spans the two apps, so they must be kept
 * in step by hand.
 */
```

**JSDoc/TSDoc:**
- Not heavily used; prefer inline comments
- When used, documents parameters and return types
- Example: `/** Stable render key and test handle. */ id: string`

## Function Design

**Size:**
- Keep functions under 50 lines when possible
- Break logic into smaller, testable units
- Pure functions preferred over side effects

**Parameters:**
- Destructured parameters for objects — `{ id, status }` not `options`
- Type annotations required for all parameters
- Optional parameters with defaults — `disabled = false`
- Use of function overloads for complex signatures

**Return Values:**
- Explicit return types required
- Avoid implicit undefined returns
- Return objects for multiple values rather than tuples
- Example: `{ state: 'current', basis: 'stated-current' }`

## Module Design

**Exports:**
- Named exports preferred over default exports
- Type exports marked with `export type`
- Example: `export type CareerState = 'current' | 'ended' | 'unknown'`

**Barrel Files:**
- Used to aggregate related exports
- Keep barrel files focused on a logical grouping
- Example from `src/ui/index.ts`:
  ```typescript
  export { Button } from './Button'
  export { AppText } from './AppText'
  export { Card } from './Card'
  ```

**NestJS Patterns:**
- Decorators for dependency injection — `@Injectable()`, `@Module()`
- Module metadata declarative — imports, providers, exports clear
- Controllers declare HTTP methods with decorators — `@Get()`, `@Post()`
- Guards for cross-cutting concerns — `@UseGuards(AuthGuard)`

---

*Convention analysis: 2026-09-10*
