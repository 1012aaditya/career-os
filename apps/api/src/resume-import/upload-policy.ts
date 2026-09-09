/*
 * What the server will accept as a resume, and how often.
 *
 * Pure: no clock, no database, no network. Every rule here is a function
 * of its arguments, which is what lets the limits be asserted directly
 * rather than inferred from an endpoint's behaviour.
 *
 * THE RULE THIS FILE EXISTS FOR: never trust the client. The mobile app
 * already checks for a `.pdf` extension before it uploads, and that check
 * is a courtesy to the user - it is not a control. Anything holding a
 * bearer token can call the API directly, so every limit that matters has
 * to be re-decided here.
 *
 * WHAT THE SERVER CAN AND CANNOT SEE, which is what shapes the design.
 * The API never receives the file. It mints a signed upload URL and the
 * client uploads straight to storage, which is a deliberate property worth
 * keeping - the API is not a resume-byte proxy and does not want to be.
 * The consequence is that at CREATE time the server knows only a filename,
 * so filename rules are all it can enforce there. The real size and the
 * real content type are checked later, against storage's own metadata,
 * before the worker is allowed to read the file. See
 * `resume-processing.service.ts`.
 */

/**
 * The only extension accepted.
 *
 * One format, deliberately. The extraction worker is built for PDFs, and
 * accepting a .docx we cannot parse converts a clear rejection at upload
 * into a confusing failure several minutes later, after the user has been
 * told their resume was received.
 */
export const ALLOWED_EXTENSIONS = ['.pdf'] as const;

/**
 * Content types accepted when the stored object is checked.
 *
 * `application/octet-stream` is included and it is the uncomfortable one:
 * it is what a client sends when it does not know, and rejecting it would
 * fail legitimate uploads from HTTP clients that never set a type. It is
 * safe here only because it is not load-bearing - the worker parses the
 * bytes and a non-PDF fails there. This list stops casual mistakes; it is
 * not a defence against a determined uploader, and pretending otherwise
 * would be worse than saying so.
 */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/octet-stream',
] as const;

/**
 * 10 MB.
 *
 * A text-based resume is tens of kilobytes; a scanned one with embedded
 * images is a few megabytes. 10 MB is comfortably above any real resume
 * and far below what would make the extraction worker or the storage bill
 * uncomfortable.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** An empty object is a failed upload, not a resume. */
export const MIN_FILE_BYTES = 1;

/**
 * Filenames are stored, displayed back to the user, and sanitised into a
 * storage path. 200 characters is longer than any real resume filename and
 * short enough to keep a path well inside every limit that matters.
 */
export const MAX_FILE_NAME_LENGTH = 200;

/**
 * How many imports a user may have in flight at once.
 *
 * Three, not one: a user is allowed to retry after a failure and to upload
 * a second version while the first is still being reviewed, and a limit of
 * one would make both of those feel broken. Three is enough for every
 * honest pattern and small enough that nobody can queue a thousand jobs.
 *
 * "In flight" means a status that is still going somewhere. CONFIRMED and
 * FAILED are terminal and are not counted - otherwise a user would hit the
 * cap permanently after three uploads, which is a bug that looks like a
 * policy.
 */
export const MAX_ACTIVE_IMPORTS = 3;

export const ACTIVE_IMPORT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'NEEDS_REVIEW',
] as const;

/**
 * A rolling ceiling on creations, independent of how many are active.
 *
 * The active-import cap alone does not bound work: a client that creates
 * an import and abandons it, repeatedly, never accumulates active rows but
 * does accumulate database rows and storage objects. Twenty per hour is
 * roughly one every three minutes sustained, which no real person
 * approaches and which caps the damage from a loop.
 */
export const MAX_IMPORTS_PER_WINDOW = 20;
export const IMPORT_WINDOW_MS = 60 * 60 * 1000;

/** Short, stable codes. Safe to log, safe to return, never provider text. */
export type UploadRejection =
  | 'file_name_required'
  | 'file_name_too_long'
  | 'file_type_not_allowed'
  | 'file_name_unusable';

const REJECTION_MESSAGES: Record<UploadRejection, string> = {
  file_name_required: 'A file name is required',
  file_name_too_long: `File name must be ${MAX_FILE_NAME_LENGTH} characters or fewer`,
  file_type_not_allowed: 'Only PDF resumes are supported',
  file_name_unusable: 'File name must contain letters, numbers or dashes',
};

export function rejectionMessage(rejection: UploadRejection): string {
  return REJECTION_MESSAGES[rejection];
}

/**
 * Everything about a filename that can be decided without the file.
 *
 * Returns the rejection code, or null when the name is acceptable. The
 * order matters: the most specific complaint wins, so a user who uploads a
 * `.docx` is told about the format rather than about characters.
 */
export function checkFileName(fileName: unknown): UploadRejection | null {
  if (typeof fileName !== 'string') {
    return 'file_name_required';
  }

  const trimmed = fileName.trim();

  if (trimmed === '') {
    return 'file_name_required';
  }

  if (trimmed.length > MAX_FILE_NAME_LENGTH) {
    return 'file_name_too_long';
  }

  /*
   * Case-insensitive, because a real upload is as likely to be Resume.PDF
   * as resume.pdf. Compared against the END of the name, so
   * "resume.pdf.exe" is refused rather than accepted on a substring match.
   */
  const lower = trimmed.toLowerCase();
  const allowed = ALLOWED_EXTENSIONS.some((extension) =>
    lower.endsWith(extension),
  );

  if (!allowed) {
    return 'file_type_not_allowed';
  }

  /*
   * The name must survive sanitisation as something recognisable. A name
   * made entirely of characters the sanitiser strips - "???????.pdf" -
   * becomes a run of underscores, which is a storage path nobody can read
   * back to a human and a filename the user will not recognise as theirs.
   */
  if (!/[a-zA-Z0-9]/.test(sanitizeFileName(trimmed).replace(/\.pdf$/i, ''))) {
    return 'file_name_unusable';
  }

  return null;
}

/**
 * The filename as it appears in a storage path.
 *
 * Everything outside a conservative allowlist becomes an underscore, which
 * removes path separators, so a name like `../../secrets.pdf` collapses to
 * `.._.._secrets.pdf` and cannot escape its prefix. This behaviour is
 * unchanged from the original implementation and is restated here only so
 * that the rule and the check that depends on it live together.
 */
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, MAX_FILE_NAME_LENGTH);
}

/** Short, stable codes for what storage actually turned out to hold. */
export type StoredFileRejection =
  | 'file_missing'
  | 'file_empty'
  | 'file_too_large'
  | 'content_type_not_allowed';

/**
 * The stored object, judged on storage's own metadata rather than on
 * anything a client said.
 *
 * This is the check that is worth trusting: `size` and `contentType` here
 * come from the storage service after the bytes landed, so they describe
 * what was actually uploaded rather than what was promised.
 */
export function checkStoredFile(file: {
  exists: boolean;
  size?: number | null;
  contentType?: string | null;
}): StoredFileRejection | null {
  if (!file.exists) {
    return 'file_missing';
  }

  const size = file.size;

  /*
   * An unknown size is treated as acceptable rather than as a failure.
   * Storage backends do occasionally omit metadata, and refusing every
   * upload whose size we could not read would turn a metadata gap into an
   * outage. The size ceiling that actually protects the system is the
   * bucket's own, configured alongside it - this is the second line.
   */
  if (typeof size === 'number') {
    if (size < MIN_FILE_BYTES) {
      return 'file_empty';
    }

    if (size > MAX_FILE_BYTES) {
      return 'file_too_large';
    }
  }

  const contentType = file.contentType;

  if (typeof contentType === 'string' && contentType.trim() !== '') {
    /* Parameters are stripped: "application/pdf; charset=binary" is a PDF. */
    const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

    if (!ALLOWED_CONTENT_TYPES.some((allowed) => allowed === base)) {
      return 'content_type_not_allowed';
    }
  }

  return null;
}

const STORED_REJECTION_MESSAGES: Record<StoredFileRejection, string> = {
  file_missing: 'The uploaded file could not be found',
  file_empty: 'The uploaded file is empty',
  file_too_large: 'The uploaded file is larger than 10 MB',
  content_type_not_allowed: 'Only PDF resumes are supported',
};

export function storedRejectionMessage(rejection: StoredFileRejection): string {
  return STORED_REJECTION_MESSAGES[rejection];
}
