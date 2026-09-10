# Testing Patterns

**Analysis Date:** 2026-09-10

## Test Framework

**Runner:**
- Vitest (both `apps/api` and `apps/mobile`)
- Configuration files:
  - `apps/api/vitest.config.ts` — Main test config
  - `apps/api/vitest.config.e2e.ts` — End-to-end tests
  - `apps/mobile/vitest.config.mts` — Mobile-specific config (Node environment only)

**Assertion Library:**
- Vitest's built-in assertions (expect)
- Methods: `.toBe()`, `.toEqual()`, `.rejects.toThrow()`, `.toContain()`, `.toBeNull()`

**Run Commands:**
```bash
npm run test              # Run all tests once
npm run test:watch       # Run tests in watch mode (re-run on file change)
npm run test:cov         # Run tests with coverage report
npm run test:debug       # Debug mode with inspector
npm run test:e2e         # Run end-to-end tests only (API)
```

## Test File Organization

**Location and Naming:**
- Co-located with source files
- API tests: `.spec.ts` extension — `auth.service.spec.ts`
- Mobile tests: `.test.ts` extension — `career-state.test.ts`
- Both patterns are valid; extension signals test type

**Directory Pattern:**
```
apps/api/
├── src/
│   ├── auth/
│   │   ├── auth.service.ts
│   │   └── auth.service.spec.ts
│   ├── resume-import/
│   │   ├── resume-import.service.ts
│   │   └── resume-import.service.spec.ts
│   └── ...

apps/mobile/
├── src/
│   ├── career/
│   │   ├── career-state.ts
│   │   └── career-state.test.ts
│   ├── ui/
│   │   ├── Button.tsx
│   │   └── Button.test.tsx (if tested)
│   └── ...
```

**Vitest Configuration:**
- `apps/api`: Includes `**/*.spec.ts` files globally
- `apps/mobile`: Scoped to `src/career/**/*.test.ts` only (pure TS modules without React Native)
  - Reason: Career modules are pure logic; UI screens tested separately

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it, beforeEach } from 'vitest';

describe('ComponentName', () => {
  let service: ServiceType;
  let mockDependency: MockType;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDependency = { /* setup */ };
    service = new ServiceClass(mockDependency);
  });

  describe('specific behavior group', () => {
    it('does something specific', () => {
      expect(service.method()).toBe(expected);
    });

    it.each([...])('parameterized test', (param) => {
      expect(service.method(param)).toBe(expected);
    });
  });

  describe('error cases', () => {
    it('throws when invalid', async () => {
      await expect(service.method()).rejects.toThrow('Error message');
    });
  });
});
```

**Patterns:**

Setup in `beforeEach`:
```typescript
beforeEach(() => {
  vi.clearAllMocks();  // Clear any mock state from previous test
  service = new AuthService(mockSupabase);
});
```

Grouped test suites by functionality:
```typescript
describe('AuthService', () => {
  describe('the happy path', () => {
    // Success cases
  });

  describe('error cases', () => {
    // Error handling
  });

  describe('concurrent operations', () => {
    // Race conditions, state conflicts
  });
});
```

Parameterized tests for exhaustive coverage:
```typescript
it.each([
  'present',
  'current',
  'currently',
  'now',
])(
  'treats %j as a stated ongoing marker',
  (marker) => {
    expect(getCareerState({ endDateText: marker }).basis).toBe('stated-current');
  },
);
```

## Mocking

**Framework:** Vitest's built-in `vi` object

**Patterns:**

Manual mock objects (preferred over jest.mock):
```typescript
const mockSupabase = {
  auth: {
    getUser: vi.fn(),
  },
};

supabase.auth.getUser.mockResolvedValue({
  data: { user },
  error: null,
});
```

In-memory implementations for testing behavior:
```typescript
function makeStore(rows: Row[]) {
  return {
    rows,
    writes: [],
    resumeImport: {
      findFirst: async ({ where }) => 
        rows.find(row => row.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        // Compare-and-swap logic
        if (row.status === where.status) {
          Object.assign(row, data);
          store.writes.push({ id, data });
          return { count: 1 };
        }
        return { count: 0 };
      }
    },
  };
}
```

Mock reset per test:
```typescript
beforeEach(() => {
  vi.clearAllMocks();  // Clears all mocks and call history
});
```

**What to Mock:**
- External services (Supabase, AWS, APIs)
- Database operations (via Prisma mocks)
- Filesystem operations
- HTTP requests

**What NOT to Mock:**
- Pure utility functions
- Domain logic (test the actual business logic)
- Type helpers or type guards
- Core framework features (NestJS services under test)

## Fixtures and Factories

**Test Data Builders:**

Factory functions for common test objects:
```typescript
function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'import-1',
    userId: 'user-1',
    fileName: 'cv.pdf',
    status: 'NEEDS_REVIEW',
    errorMessage: null,
    ...overrides,
  };
}

// Usage in tests
const row = makeRow({ status: 'CONFIRMED' });
```

Minimal factories for test graphs:
```typescript
function makeExperience(props: Partial<Experience> = {}) {
  return {
    id: 'x',
    title: 'Engineer',
    startDate: iso(2024, 3),
    ...props,
  };
}
```

Helper for date creation:
```typescript
function iso(year: number, month: number) {
  return new Date(year, month - 1, 1);
}
```

**Location:**
- `src/career/test-fixtures.ts` — Shared fixtures for mobile tests
- Inline in test files for API tests

## Coverage

**Requirements:**
- No explicit coverage target enforced in config
- View coverage: `npm run test:cov` generates HTML report

**Coverage Exclusions:**
- Bootstrap/entry point code
- Type definitions (not runtime)
- Framework boilerplate

## Test Types

**Unit Tests (Primary):**
- Scope: Single function or service method
- Approach: Isolated, with mocked dependencies
- Example: `AuthService.verifyAccessToken()` with mocked Supabase
- Location: `apps/api/src/**/*.spec.ts`

**Integration Tests:**
- Scope: Multiple modules working together
- Approach: Real database, mocked external services
- Example: Resume import lifecycle (status transitions, guard conditions)
- Run as part of main test suite with `vitest run`

**End-to-End Tests:**
- Scope: Full request/response cycle
- Framework: None explicitly configured; would use `vitest.config.e2e.ts`
- Command: `npm run test:e2e`
- Status: Config present but not heavily used

**Career Graph Tests (Mobile):**
- Scope: Pure logic in `src/career/` modules
- Approach: Node environment, no React Native
- Example: `career-state.test.ts` tests state machine + data quality detection
- Rationale: These modules are pure TS; UI screens tested separately if at all

## Common Patterns

**Async Testing:**
```typescript
it('should return the authenticated user for a valid token', async () => {
  supabaseClient.auth.getUser.mockResolvedValue({
    data: { user },
    error: null,
  });

  await expect(service.verifyAccessToken('valid-token')).resolves.toEqual(user);
});
```

**Error Testing:**
```typescript
it('should reject an invalid token', async () => {
  supabaseClient.auth.getUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Invalid JWT' },
  });

  await expect(
    service.verifyAccessToken('invalid-token'),
  ).rejects.toThrow('Invalid or expired access token');
});
```

**State Transition Testing:**
```typescript
describe('which statuses may be confirmed', () => {
  it.each(['PENDING', 'PROCESSING', 'FAILED'])(
    'refuses to confirm a %s import',
    async (status) => {
      row.status = status;
      await expect(
        service.confirm('user-1', 'import-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );
});
```

**Concurrency Testing:**
```typescript
describe('when the ingestion succeeds but the bookkeeping write fails', () => {
  it('does not report a completed ingestion as a failure', async () => {
    /*
     * The regression this ordering exists to prevent. The graph is
     * built and the ledger row is written; only the errorMessage clear
     * fails. Recording "ingestion failed" here would be false.
     */
    store.failures.updateOn = (_row, data) =>
      data.errorMessage === null;

    await expect(
      service.confirm('user-1', 'import-1'),
    ).rejects.toThrow('connection reset');

    expect(store.ledger.has('import-1')).toBe(true);
  });
});
```

**Data Quality Cross-System Testing:**
```typescript
describe('ONGOING_MARKERS parity with ingestion', () => {
  it('reads every marker the API writes isCurrent from as a stated fact', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../api/src/career-graph/career-graph-ingestion.service.ts'),
      'utf8',
    );

    const apiMarkers = [/* extract from source */];

    for (const marker of apiMarkers) {
      expect(
        getCareerState({ endDateText: marker, isCurrent: true }).basis,
      ).toBe('stated-current');
    }
  });
});
```

**Mobile Test Example Structure:**
```typescript
describe('getCareerState', () => {
  it('reports a stated ongoing marker as fact', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2024, 3),
          endDateText: 'Present',
          isCurrent: true,
        }),
      ),
    ).toEqual({
      state: 'current',
      basis: 'stated-current',
    });
  });

  it('does not crash on null or malformed records', () => {
    for (const value of [null, undefined, 42, 'nonsense', {}]) {
      expect(getCareerState(value).state).toBe('unknown');
    }
  });
});
```

---

*Testing analysis: 2026-09-10*
