import { apiRequest } from './client';


export type ResumeImportStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'FAILED';


export type ResumeImport = {
  id: string;
  fileName: string;
  storagePath: string;
  status: ResumeImportStatus;
  extractionResult: unknown | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};


export type CreateResumeImportResponse = {
  id: string;
  fileName: string;
  storagePath: string;
  status: ResumeImportStatus;
  uploadToken: string;
  uploadPath: string;
};


export async function createResumeImport(
  fileName: string,
): Promise<CreateResumeImportResponse> {
  return apiRequest<CreateResumeImportResponse>(
    '/resume-imports',
    {
      method: 'POST',
      body: {
        fileName,
      },
    },
  );
}


export async function getResumeImports(): Promise<
  ResumeImport[]
> {
  return apiRequest<ResumeImport[]>(
    '/resume-imports',
  );
}


export async function getResumeImport(
  id: string,
): Promise<ResumeImport> {
  return apiRequest<ResumeImport>(
    `/resume-imports/${id}`,
  );
}


export async function updateResumeImport(
  id: string,
  extractionResult: unknown,
): Promise<ResumeImport> {
  return apiRequest<ResumeImport>(
    `/resume-imports/${id}`,
    {
      method: 'PATCH',
      body: {
        extractionResult,
      },
    },
  );
}


/*
 * What confirm and ingest both return. Confirming ends in the ingestion,
 * so the two share a shape.
 *
 * `careerGraph.status` distinguishes an import this call ingested from one
 * a previous call already had — both are successes, and the client must
 * not read the second as a failure.
 */
export type ResumeIngestionResult = {
  resumeImport: ResumeImport;
  careerGraph: {
    resumeImportId: string;
    ingestionId: string;
    evidenceId?: string;
    status: string;
  };
};

export async function confirmResumeImport(
  id: string,
): Promise<ResumeIngestionResult> {
  return apiRequest<ResumeIngestionResult>(
    `/resume-imports/${id}/confirm`,
    {
      method: 'POST',
    },
  );
}

/*
 * Retry for an import that was confirmed but never reached the graph.
 * Idempotent: calling it on an already-ingested import reports
 * ALREADY_INGESTED rather than duplicating anything.
 *
 * No screen calls this, and that is deliberate rather than an omission.
 * The review screen's own retry works through confirm() — which now ends
 * in the same ingestion — so the ordinary path needs nothing extra. This
 * covers the case the user never sees: a crash between the confirmation
 * and the ingestion strands the import with no error to react to, and
 * without a typed client for the recovery route the only way to reach one
 * of those would be a database script.
 */
export async function ingestResumeImport(
  id: string,
): Promise<ResumeIngestionResult> {
  return apiRequest<ResumeIngestionResult>(
    `/resume-imports/${id}/ingest`,
    {
      method: 'POST',
    },
  );
}

/*
 * What deleting one import actually removes.
 *
 * The shape mirrors the server's response, and `careerGraphRetained` is
 * the field that matters to the UI: the server deletes the import, its
 * stored file and the evidence provably derived from it, and it KEEPS
 * experiences, projects, education and skills - because nothing in the
 * schema attributes those to a particular resume. The screen shows
 * `careerGraphNote` rather than inventing its own sentence, so the copy a
 * user reads and the behaviour the server implements cannot drift apart.
 */
export type ResumeImportDeletionResult = {
  id: string;
  deleted: boolean;
  fileDeleted: boolean;
  evidenceDeleted: number;
  careerGraphRetained: boolean;
  careerGraphNote: string;
};

/**
 * Deletes one imported resume.
 *
 * Scoped by the server to the authenticated user: an id belonging to
 * somebody else answers 404, exactly as an id that never existed does.
 * Never retried automatically - a destructive call that timed out may
 * already have succeeded.
 */
export async function deleteResumeImport(
  id: string,
): Promise<ResumeImportDeletionResult> {
  return apiRequest<ResumeImportDeletionResult>(
    `/resume-imports/${id}`,
    {
      method: 'DELETE',
    },
  );
}
