# Codebase Concerns

**Analysis Date:** 2026-09-10

## Tech Debt

**Monolithic Screen Component:**
- Issue: `CareerScreen.tsx` contains 3,013 lines of mixed business logic, rendering, and state management in a single file
- Files: `apps/mobile/src/screens/main/CareerScreen.tsx`
- Impact: Extremely difficult to test, debug, or modify; any change risks breaking the entire career visualization feature; component reusability is impossible
- Fix approach: Break into smaller, focused components (NodeRenderer, EdgeRenderer, DetailPanel, LensSelector) with clear responsibilities. Extract graph rendering logic into custom hooks. Move graph model computation outside component.

**Complex Nested Query Logic:**
- Issue: `CareerGraphService.getGraph()` constructs a single massive query with 20+ levels of nesting, explicitly ordering relationships by UUID as a stability workaround
- Files: `apps/api/src/career-graph/career-graph.service.ts` (lines 44-310)
- Impact: Query is fragile to schema changes; the 20+ nested orderBy clauses are performance-risky; if a relationship gets added or removed, the entire query must be audited; any future developer unfamiliar with the stability contract will refactor and break it
- Fix approach: Create a query builder or repository pattern to encapsulate ordering logic. Document the stability contract explicitly. Consider breaking into separate queries or a query service layer. Add tests that verify ordering stability across multiple calls.

**Unvalidated Type Casting:**
- Issue: Resume extraction results are cast directly to `ResumeExtraction` type without runtime validation: `const result = resumeImport.extractionResult as ResumeExtraction;`
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (line 113)
- Impact: If the extraction JSON structure changes (from API updates, schema migrations, or upstream bugs), the code will silently accept invalid data and crash during property access; no clear error message
- Fix approach: Add Zod or class-validator schema for ResumeExtraction. Validate at ingestion boundary before casting. Return clear error if validation fails.

**Data Normalization Scattered Across Codebase:**
- Issue: Name normalization (`normalizeNme`, `normalizeName`) logic appears in multiple places; skill deduplication logic is in ingestion service only
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (skill normalization), resume-import logic
- Impact: Duplicate logic is hard to maintain; normalization rules can diverge; database can accumulate duplicate skills with slightly different normalizations
- Fix approach: Create a shared `NormalizationService` in `apps/api/src/common/normalization.service.ts`. Use consistently for skills, companies, roles. Add tests for edge cases (case, punctuation, spacing).

**Complex State Logic Without Comprehensive Tests:**
- Issue: Career state representation (`CareerState`, `CareerStateBasis`) in `data-quality.ts` has 5 different state variants and complex inference rules, but test coverage is incomplete
- Files: `apps/mobile/src/career/data-quality.ts`, `apps/mobile/src/career/data-quality.test.ts`
- Impact: State transitions can be broken by refactoring; edge cases (conflicting dates, missing signals) may not behave as expected; mobile UI may display incorrect status
- Fix approach: Add exhaustive test cases for all state combinations. Create state machine tests. Add regression tests for known edge cases found during review.

---

## Known Bugs

**Optional Date Fields Enable Incorrect Sorting:**
- Symptoms: Career timeline order becomes unstable when start_date or endDate is null
- Files: `apps/api/prisma/schema.prisma` (startDate, endDate marked as optional), `apps/api/src/career-graph/career-graph.service.ts` (relies on NULLS LAST behavior)
- Trigger: When a resume import has a role or project without dates, the sorting query assumes Postgres behavior; if nulls handling changes, order becomes non-deterministic
- Workaround: Currently relies on explicit `nulls: 'last'` directive in orderBy; this is database-specific and fragile

**Race Condition in Resume Ingestion:**
- Symptoms: If two ingestion requests arrive simultaneously for the same resume, both may pass the initial uniqueness check and both insert career graph records
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (lines 97-110, 123-143)
- Trigger: Concurrent POST requests to ingest the same resume at the same second
- Workaround: Double-check inside transaction mitigates but doesn't eliminate risk if transaction isolation level is READ_COMMITTED

**Silent Extraction Failures:**
- Symptoms: If resume extraction worker fails to extract data, `extractionResult` is null, but ingestion endpoint returns a generic 409 error without clear debugging info
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (line 91-95)
- Trigger: Extraction service fails, but status remains CONFIRMED
- Workaround: User must manually check resume import status in database

---

## Security Considerations

**No Runtime Validation of External Data:**
- Risk: Untrusted extraction results from external API/LLM are used directly without validation; malformed JSON could cause crashes; extremely long strings could cause performance issues
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (entire ingestion logic)
- Current mitigation: TypeScript types provide compile-time safety only; Prisma prevents SQL injection; no string length limits enforced at ingestion
- Recommendations: 
  - Add Zod schemas to validate and sanitize extraction results
  - Add field length limits (institution name max 200 chars, etc.)
  - Add rate limiting on ingestion endpoint
  - Log all validation failures for auditing

**Resume Upload Path Traversal Prevention:**
- Risk: Resume filenames are sanitized with `replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)` but uploaded to storage at `${userId}/${id}/${safeFileName}`
- Files: `apps/api/src/resume-import/resume-import.service.ts` (lines 40-50)
- Current mitigation: Filename sanitization prevents obvious attacks; UUID in path provides isolation per import
- Recommendations: Consider using UUID as filename entirely; validate uploaded file MIME type on server-side before accepting; add virus scan if handling untrusted uploads

**Supabase Client Exposed in Service:**
- Risk: `SupabaseClientService` is injected into resume import service; no role-based access control verified at service level
- Files: `apps/api/src/resume-import/resume-import.service.ts` (line 22)
- Current mitigation: NestJS guards presumably check auth at controller level
- Recommendations: Verify JWT validation guards are present on all resume endpoints; add service-level auth checks as defense-in-depth

---

## Performance Bottlenecks

**Unbounded Graph Query Fetches Entire User Career:**
- Problem: `CareerGraphService.getGraph()` fetches ALL experiences, projects, skills, evidence, achievements, educations for a user without pagination or filtering
- Files: `apps/api/src/career-graph/career-graph.service.ts` (lines 44-301)
- Cause: Mobile graph caps rendering in UI, but server still fetches everything; a user with thousands of historical records will get slow response; no connection pooling visible
- Improvement path: 
  - Add optional `limit` parameter to API
  - Implement cursor-based pagination for nested collections
  - Add database query caching (Redis) for career graphs that don't change frequently
  - Profile current query performance; consider breaking into multiple endpoints (user profile + experience + skills separately)

**Repeated Database Lookups in Ingestion Loop:**
- Problem: For each skill extracted, the code looks up or creates the skill, then upserts the user-skill relationship; this happens in a loop over potentially 100+ skills
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (lines 206-251)
- Cause: No batch upsert; N queries instead of 1
- Improvement path: Use Prisma batch operations or raw SQL to upsert all skills in one query; benchmark impact

**Inefficient Component Re-renders:**
- Problem: `CareerScreen` component re-renders the entire SVG graph on every state change; no memoization of node/edge rendering
- Files: `apps/mobile/src/screens/main/CareerScreen.tsx` (entire component)
- Cause: 3,000-line component makes optimization invisible; every lens change, selection change causes full re-render
- Improvement path: Break into smaller memoized components; memoize graph model computation; use `useMemo` for node/edge filtering

---

## Fragile Areas

**Graph Model Depends on Rendering Constants:**
- Files: `apps/mobile/src/career/graph-model.ts` (lines 101-123, NODE_RADIUS, GRAPH_WIDTH, etc.)
- Why fragile: Node positioning math is baked into the model layer and depends on exact pixel values; if the mobile screen size changes or a design tweak adjusts GRAPH_WIDTH, node positions shift and all database IDs must be re-correlated; any typo in a constant breaks the layout
- Safe modification: Wrap all layout constants in a single immutable config object; add tests that verify node positions stay within canvas bounds; consider moving to CSS/theme layer instead of code constants
- Test coverage: `graph-model.test.ts` exists but may not cover boundary conditions (nodes at edge of canvas, overlapping nodes)

**Data Quality Report Has Implicit State Assumptions:**
- Files: `apps/mobile/src/career/data-quality.ts` (lines 58-93, CareerState logic)
- Why fragile: State derivation logic is fragmented across multiple basis types; adding a new basis type requires changes in 3+ places; test doesn't cover all transitions
- Safe modification: Use a state machine library or explicit transition table; add comprehensive fixtures for each state type
- Test coverage: `career-state.test.ts` may not cover all transitions between states

**Career Graph Ingestion Assumes Specific Extraction Schema:**
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts` (entire file, especially lines 12-59)
- Why fragile: The `ResumeExtraction` type is deeply nested with many optional fields; if extraction API changes (adds new fields, renames existing ones, changes nesting), the entire ingestion breaks silently
- Safe modification: Add versioning to extraction schema; add migration layer if schema changes; add comprehensive schema tests
- Test coverage: No tests for resume ingestion; impossible to verify backward compatibility

**Mobile Navigation State Not Persisted:**
- Files: `apps/mobile/src/screens/main/CareerScreen.tsx` (state management visible but not in detail)
- Why fragile: Detail panel selection (which node is shown) is likely in component state only; if user navigates away and back, selection is lost; if app crashes mid-selection, data could be lost
- Safe modification: Move selection state to persistent store (AsyncStorage); implement recovery on app resume
- Test coverage: No tests for navigation state recovery

---

## Scaling Limits

**Database Query Complexity Scales Poorly:**
- Current capacity: Handles single user with <1000 entities reasonably
- Limit: When a user has 1000+ career items, the monolithic query becomes a single massive transaction; if two users request graphs simultaneously, connection pool exhaustion possible
- Scaling path: 
  - Implement query pagination for nested relationships
  - Add read replicas for graph queries
  - Consider denormalizing user graph data into a cached snapshot table
  - Add pagination to API responses

**Mobile SVG Rendering Hits Performance Wall:**
- Current capacity: 100-150 nodes renderable without lag
- Limit: Beyond 200 nodes, mobile frame rate drops; SVG diffing becomes expensive
- Scaling path: 
  - Implement node culling (don't render off-screen nodes)
  - Use canvas instead of SVG for large graphs
  - Implement WebGL rendering for very large graphs
  - Add virtual scrolling for detail panels with many relationships

**Resume Storage Without Size Limits:**
- Current capacity: No enforced limit on resume file size
- Limit: Large PDF resumes (50MB+) will consume storage quota; no cleanup policy for failed imports
- Scaling path: 
  - Enforce max file size (e.g., 10MB) at upload
  - Implement automatic cleanup of failed imports after 30 days
  - Monitor storage quota and alert when threshold is crossed

---

## Dependencies at Risk

**Prisma Adapter Dependency on pg Driver:**
- Risk: Direct dependency on `@prisma/adapter-pg` and `pg` driver; if Prisma changes adapter API, upgrade could be breaking
- Impact: Type casting in generated client could change; edge cases in date handling might shift
- Migration plan: Keep adapter version pinned; add integration tests that verify date ordering behavior; monitor Prisma changelog closely

**Supabase Client Auth Coupled to Service Layer:**
- Risk: `SupabaseClientService` is injected directly; if Supabase client API changes, multiple services must be updated
- Impact: Auth token refresh logic could break; file upload signing logic could change
- Migration plan: Create abstraction layer (AuthAdapter) that wraps Supabase; add integration tests; monitor Supabase changelog

**React Native SVG Performance Unknown:**
- Risk: Using `react-native-svg` for large graphs; library may not optimize for very large node counts
- Impact: If rendering becomes bottleneck, migration to Canvas or WebGL would be very expensive
- Migration plan: Add performance benchmarks now; consider evaluating D3.js or Three.js for large graphs; add virtualization early

---

## Missing Critical Features

**No Resume Import Progress Tracking:**
- Problem: User uploads resume, status changes to PROCESSING, but client has no way to poll progress or get updates; endpoint returns entire graph on success, no incremental data
- Blocks: Users can't see what's happening; if import takes >5 seconds, they think it failed
- Solution: Add polling endpoint for import status; consider WebSocket for real-time updates

**No Data Export/Backup:**
- Problem: All career data is stored only in Supabase; user has no way to export or backup their graph
- Blocks: Vendor lock-in; if data is deleted, no recovery; no way to migrate to another service
- Solution: Add export-to-JSON endpoint; add scheduled backup exports; implement deletion confirmation with recovery window

**No Duplicate Detection UI:**
- Problem: Data quality report detects duplicate experiences (same title at same company) but mobile UI has no way to merge or hide them
- Blocks: Duplicate resumes create duplicate data; no clean-up mechanism; graph shows same role twice
- Solution: Add merge UI in detail panel; allow user to select records to combine; log merge operations

**No Conflict Resolution for Career State:**
- Problem: When a role has conflicting dates (endDate exists but isCurrent is true), data quality report flags it but UI has no resolution flow
- Blocks: User sees error but can't fix it in app; must edit database directly
- Solution: Add conflict resolution flow in detail panel; let user choose which source is correct

**No Audit Log for Data Changes:**
- Problem: Who ingested which resume? When was a skill added? What changed between versions?
- Blocks: No way to trace data provenance; can't undo accidental changes; compliance audits are impossible
- Solution: Add created_by and updated_by fields to career entities; add change log table; expose change history in UI

---

## Test Coverage Gaps

**Career Graph Ingestion Has No Tests:**
- What's not tested: The entire `career-graph-ingestion.service.ts` (1,157 lines) has zero test coverage; no tests for skill deduplication, education parsing, experience creation, transaction rollback, concurrency
- Files: `apps/api/src/career-graph/career-graph-ingestion.service.ts`
- Risk: The most complex business logic in the codebase is untested; any change could silently corrupt data; edge cases (null dates, malformed extraction) are unknown
- Priority: **Critical** — This service creates all career entities from resume data; bugs here propagate to UI

**Career Graph Service Query Logic Has No Tests:**
- What's not tested: The complex 300-line getGraph query with 20+ nested orderBy clauses; no tests verify ordering stability or relationship inclusion
- Files: `apps/api/src/career-graph/career-graph.service.ts`
- Risk: Query refactoring could silently change which records are returned; ordering contract could break without detection
- Priority: **Critical** — Query powers the entire mobile UI

**Resume Processing Service Has No Tests:**
- What's not tested: Resume extraction, parsing, and processing workflow; no tests for error cases
- Files: `apps/api/src/resume-processing/resume-processing.service.ts`
- Risk: Unknown; service is only 198 lines but purpose and error handling unknown from code inspection
- Priority: **High**

**Mobile Graph Model Tests Are Incomplete:**
- What's not tested: Node positioning edge cases; nodes at canvas boundaries; overlapping nodes; lens filtering correctness; determinism across repeated calls
- Files: `apps/mobile/src/career/graph-model.test.ts` (461 lines) — tests exist but may not be exhaustive
- Risk: UI could fail on edge cases (user with 1000 skills, very old dates, etc.)
- Priority: **High**

**Mobile Component Integration Tests Missing:**
- What's not tested: CareerScreen, ResumeImportScreen, ProfileScreen have no integration tests; no e2e tests visible
- Files: `apps/mobile/src/screens/**`
- Risk: UI bugs only discovered in user testing; refactoring breaks unknown dependency chains
- Priority: **Medium** — Unit tests exist for models, but UI tests are absent

**CI Pipeline Does Not Run Tests:**
- What's not tested: GitHub Actions workflow runs typecheck and build but skips `pnpm test`
- Files: `.github/workflows/ci.yml`
- Risk: Failing tests merge to main; no automated enforcement of test pass rate
- Priority: **Critical** — CI should be first gate before merge

---

## Anti-Patterns

### Type Casting Without Validation

**What happens:** JSON fields from Prisma (like `extractionResult`) are cast to specific types (`as ResumeExtraction`) without runtime validation.

**Why it's wrong:** TypeScript types are erased at runtime. A malformed extraction JSON will pass the cast and crash during property access with a cryptic error.

**Do this instead:** Use Zod or class-validator to validate at the boundary. Example in `apps/api/src/career-graph/career-graph-ingestion.service.ts`:

```typescript
import { z } from 'zod';

const ResumeExtractionSchema = z.object({
  extraction: z.object({
    skills: z.array(z.string()).optional(),
    experience: z.array(z.object({
      company: z.string().optional(),
      // ... rest of schema
    })).optional(),
  }).optional(),
});

const extraction = ResumeExtractionSchema.parse(
  resumeImport.extractionResult
);
```

### Scattered Business Logic

**What happens:** Resume extraction, skill normalization, and data deduplication logic is spread across career-graph-ingestion.service.ts without clear separation of concerns.

**Why it's wrong:** Logic is hard to test in isolation; same normalization rules can't be reused elsewhere; adding a new entity type requires editing the giant ingestion function.

**Do this instead:** Create separate service classes for each concern. Inject them into ingestion service. Example:

```typescript
// apps/api/src/career-graph/skill-management.service.ts
async upsertSkill(name: string): Promise<Skill> {
  const normalized = this.normalize(name);
  return this.prisma.skill.upsert(...);
}
```

Then in ingestion service:
```typescript
for (const skill of allSkills) {
  await this.skillService.upsertSkill(skill);
}
```

### Magic Constants in Model Layer

**What happens:** Graph rendering constants (NODE_RADIUS, GRAPH_WIDTH) are defined in `apps/mobile/src/career/graph-model.ts` and used throughout node positioning math.

**Why it's wrong:** Any design change requires updating multiple constants; typos cause layout bugs; constants are separated from rendering logic; no single source of truth.

**Do this instead:** Create a theme/config object that is passed down as a dependency:

```typescript
// apps/mobile/src/career/graph-config.ts
export const GRAPH_CONFIG = {
  width: 390,
  height: 520,
  nodeRadius: {
    person: 42,
    skill: 28,
    // ...
  },
} as const;

// Pass into buildGraphModel as parameter
export function buildGraphModel(graph: CareerGraph, config = GRAPH_CONFIG) {
  // Use config.width, config.nodeRadius, etc.
}
```

---

*Concerns audit: 2026-09-10*
