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


export async function confirmResumeImport(
  id: string,
): Promise<ResumeImport> {
  return apiRequest<ResumeImport>(
    `/resume-imports/${id}/confirm`,
    {
      method: 'POST',
    },
  );
}
