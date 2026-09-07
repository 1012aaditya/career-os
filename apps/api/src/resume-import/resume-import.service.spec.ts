import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { ResumeImportService } from './resume-import.service.js';

/*
 * Lifecycle tests for confirm() and ingest().
 *
 * The service under test is the real one. Its two collaborators are
 * substituted because neither is what is being tested: the ingestion is a
 * long transaction across a dozen tables (exercised end to end against a
 * real database separately), and Supabase storage is untouched by these
 * methods.
 *
 * What IS under test is the part that carries the correctness argument —
 * which status transitions are allowed, what happens when an ingestion
 * fails, and whether a success can ever be reported as a failure. Those
 * are pure control flow over a handful of writes, and every one of them is
 * asserted here against a store that records exactly what was written.
 */

type Row = {
  id: string;
  userId: string;
  fileName: string;
  storagePath: string;
  status: string;
  extractionResult: unknown;
  errorMessage: string | null;
};

/*
 * An in-memory stand-in for the Prisma calls these two methods make. It
 * enforces the one thing that matters for the compare-and-swap: updateMany
 * only writes rows whose current status still matches the where clause.
 */
function makeStore(rows: Row[]) {
  const ledger = new Set<string>();

  const failures: {
    updateOn?: (
      row: Row,
      data: Record<string, unknown>,
    ) => boolean;
  } = {};

  const store = {
    rows,
    ledger,
    failures,
    writes: [] as {
      id: string;
      data: Record<string, unknown>;
    }[],
    resumeImport: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; userId: string };
      }) =>
        rows.find(
          (row) =>
            row.id === where.id &&
            row.userId === where.userId,
        ) ?? null,

      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find(
          (candidate) =>
            candidate.id === where.id &&
            (where.status === undefined ||
              candidate.status ===
                where.status),
        );

        if (!row) {
          return { count: 0 };
        }

        Object.assign(row, data);
        store.writes.push({
          id: row.id,
          data,
        });

        return { count: 1 };
      },

      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find(
          (candidate) =>
            candidate.id === where.id,
        );

        if (!row) {
          throw new Error('row missing');
        }

        if (failures.updateOn?.(row, data)) {
          throw new Error(
            'connection reset',
          );
        }

        Object.assign(row, data);
        store.writes.push({
          id: row.id,
          data,
        });

        return { ...row };
      },
    },
    careerGraphIngestion: {
      findUnique: async ({
        where,
      }: {
        where: { resumeImportId: string };
      }) =>
        ledger.has(where.resumeImportId)
          ? {
              id: `ing-${where.resumeImportId}`,
              resumeImportId:
                where.resumeImportId,
            }
          : null,
    },
  };

  return store;
}

function makeRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: 'import-1',
    userId: 'user-1',
    fileName: 'cv.pdf',
    storagePath: 'user-1/cv.pdf',
    status: 'NEEDS_REVIEW',
    extractionResult: {
      extraction: { skills: ['React'] },
    },
    errorMessage: null,
    ...overrides,
  };
}

describe('ResumeImportService confirm/ingest lifecycle', () => {
  let store: ReturnType<typeof makeStore>;
  let row: Row;
  let ingestCalls: number;
  let ingestBehaviour: () => unknown;

  const build = () => {
    const ingestion = {
      ingestConfirmedResume: async (
        _userId: string,
        id: string,
      ) => {
        ingestCalls += 1;

        const result = ingestBehaviour();

        store.ledger.add(id);

        return result;
      },
    };

    return new ResumeImportService(
      store as never,
      {} as never,
      ingestion as never,
    );
  };

  beforeEach(() => {
    row = makeRow();
    store = makeStore([row]);
    ingestCalls = 0;
    ingestBehaviour = () => ({
      resumeImportId: row.id,
      ingestionId: 'ing-1',
      status: 'INGESTED',
    });
  });

  describe('the happy path', () => {
    it('confirms and ingests in one call', async () => {
      const result = await build().confirm(
        'user-1',
        'import-1',
      );

      expect(row.status).toBe('CONFIRMED');
      expect(ingestCalls).toBe(1);
      expect(
        result.careerGraph.status,
      ).toBe('INGESTED');
      expect(row.errorMessage).toBeNull();
    });
  });

  describe('which statuses may be confirmed', () => {
    it.each(['PENDING', 'PROCESSING', 'FAILED'])(
      'refuses to confirm a %s import',
      async (status) => {
        row.status = status;

        await expect(
          build().confirm(
            'user-1',
            'import-1',
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(ingestCalls).toBe(0);
      },
    );

    it('accepts a CONFIRMED import as a retry rather than an error', async () => {
      /*
       * The recovery case. A crash between the status write and the
       * ingestion leaves exactly this state, and rejecting it here is what
       * used to make the import unreachable forever.
       */
      row.status = 'CONFIRMED';

      const result = await build().confirm(
        'user-1',
        'import-1',
      );

      expect(ingestCalls).toBe(1);
      expect(
        result.careerGraph.status,
      ).toBe('INGESTED');
    });

    it('does not rewrite the status of an already-confirmed import', async () => {
      row.status = 'CONFIRMED';

      await build().confirm(
        'user-1',
        'import-1',
      );

      expect(
        store.writes.some(
          (write) =>
            write.data.status === 'CONFIRMED',
        ),
      ).toBe(false);
    });

    it('refuses an import with no extraction result', async () => {
      row.extractionResult = null;

      await expect(
        build().confirm(
          'user-1',
          'import-1',
        ),
      ).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('when the ingestion fails', () => {
    beforeEach(() => {
      ingestBehaviour = () => {
        throw new Error('ingestion blew up');
      };
    });

    it('never reverts the confirmation', async () => {
      /*
       * The property the whole design rests on. The user made a decision;
       * a failure that happened afterwards must not throw it away.
       */
      await expect(
        build().confirm(
          'user-1',
          'import-1',
        ),
      ).rejects.toThrow('ingestion blew up');

      expect(row.status).toBe('CONFIRMED');
      expect(
        store.writes.some(
          (write) =>
            write.data.status ===
            'NEEDS_REVIEW',
        ),
      ).toBe(false);
    });

    it('records why, so the state is explainable', async () => {
      await expect(
        build().confirm(
          'user-1',
          'import-1',
        ),
      ).rejects.toThrow();

      expect(row.errorMessage).toContain(
        'ingestion blew up',
      );
    });

    it('leaves the import retryable, and a retry succeeds', async () => {
      const service = build();

      await expect(
        service.confirm('user-1', 'import-1'),
      ).rejects.toThrow();

      ingestBehaviour = () => ({
        resumeImportId: row.id,
        ingestionId: 'ing-1',
        status: 'INGESTED',
      });

      const retry = await service.confirm(
        'user-1',
        'import-1',
      );

      expect(
        retry.careerGraph.status,
      ).toBe('INGESTED');
      expect(row.errorMessage).toBeNull();
    });

    it('does not let the bookkeeping write mask the real error', async () => {
      /*
       * If the database is what broke, the failure-recording write breaks
       * too. Letting that propagate would replace the cause with a
       * bookkeeping error and lose the only useful diagnostic.
       */
      store.failures.updateOn = () => true;

      await expect(
        build().confirm(
          'user-1',
          'import-1',
        ),
      ).rejects.toThrow('ingestion blew up');
    });

    it('does not stamp a failure onto an import that another call ingested', async () => {
      /*
       * Two concurrent ingests: one commits while this one is failing for
       * an unrelated reason. Leaving "ingestion failed" on a row whose
       * graph is live would send the user to retry something already done.
       */
      store.ledger.add('import-1');

      await expect(
        build().ingest('user-1', 'import-1'),
      ).rejects.toThrow();

      expect(row.errorMessage).toBeNull();
    });
  });

  describe('when the ingestion succeeds but the bookkeeping write fails', () => {
    it('does not report a completed ingestion as a failure', async () => {
      /*
       * The regression this ordering exists to prevent. The graph is
       * built and the ledger row is written; only the errorMessage clear
       * fails. Recording "ingestion failed" here would be false, and would
       * send the user to retry work that is already done.
       */
      /*
       * Only the clear fails. A failure-recording write would succeed, so
       * nothing but the ordering stops one being made — which is what
       * makes this assertion discriminating rather than incidental.
       */
      store.failures.updateOn = (_row, data) =>
        data.errorMessage === null;

      await expect(
        build().confirm(
          'user-1',
          'import-1',
        ),
      ).rejects.toThrow('connection reset');

      expect(ingestCalls).toBe(1);
      expect(store.ledger.has('import-1')).toBe(
        true,
      );
      expect(row.errorMessage).toBeNull();
      expect(
        store.writes.some((write) =>
          String(
            write.data.errorMessage ?? '',
          ).includes('failed'),
        ),
      ).toBe(false);
    });
  });

  describe('ingest()', () => {
    it.each([
      'PENDING',
      'PROCESSING',
      'NEEDS_REVIEW',
      'FAILED',
    ])(
      'refuses to ingest a %s import',
      async (status) => {
        row.status = status;

        await expect(
          build().ingest(
            'user-1',
            'import-1',
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(ingestCalls).toBe(0);
      },
    );

    it('is idempotent for the caller', async () => {
      row.status = 'CONFIRMED';
      ingestBehaviour = () => ({
        resumeImportId: row.id,
        ingestionId: 'ing-1',
        status: 'ALREADY_INGESTED',
      });

      const result = await build().ingest(
        'user-1',
        'import-1',
      );

      expect(
        result.careerGraph.status,
      ).toBe('ALREADY_INGESTED');
      expect(row.status).toBe('CONFIRMED');
    });

    it('is scoped to the owner', async () => {
      row.status = 'CONFIRMED';

      await expect(
        build().ingest(
          'someone-else',
          'import-1',
        ),
      ).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(ingestCalls).toBe(0);
    });
  });

  describe('editing across the lifecycle', () => {
    const payload = {
      extraction: { skills: ['Go'] },
    };

    it('allows an edit while the import is awaiting review', async () => {
      await build().updateExtraction(
        'user-1',
        'import-1',
        payload,
      );

      expect(row.extractionResult).toEqual(
        payload,
      );
    });

    it('allows an edit while CONFIRMED but not yet in the graph', async () => {
      /*
       * What makes retry work from the review screen, which saves before
       * it confirms — and the only way a user can fix the bad data that
       * made an ingestion fail.
       */
      row.status = 'CONFIRMED';

      await build().updateExtraction(
        'user-1',
        'import-1',
        payload,
      );

      expect(row.extractionResult).toEqual(
        payload,
      );
    });

    it('refuses an edit once the import is in the graph', async () => {
      /*
       * By now the graph is built from this payload, so an edit would
       * silently disagree with records already there.
       */
      row.status = 'CONFIRMED';
      store.ledger.add('import-1');

      await expect(
        build().updateExtraction(
          'user-1',
          'import-1',
          payload,
        ),
      ).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it.each(['PENDING', 'PROCESSING', 'FAILED'])(
      'refuses an edit to a %s import',
      async (status) => {
        row.status = status;

        await expect(
          build().updateExtraction(
            'user-1',
            'import-1',
            payload,
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );
      },
    );

    it('is scoped to the owner', async () => {
      await expect(
        build().updateExtraction(
          'someone-else',
          'import-1',
          payload,
        ),
      ).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
