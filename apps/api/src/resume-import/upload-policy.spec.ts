import { describe, expect, it } from 'vitest';

import {
  ACTIVE_IMPORT_STATUSES,
  ALLOWED_CONTENT_TYPES,
  checkFileName,
  checkStoredFile,
  MAX_ACTIVE_IMPORTS,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_IMPORTS_PER_WINDOW,
  rejectionMessage,
  sanitizeFileName,
  storedRejectionMessage,
} from './upload-policy.js';

/*
 * The upload rules, tested as a function rather than through an endpoint.
 *
 * Every one of these is a rule the mobile app also enforces, and the point
 * of the file under test is that the app's version does not count. So the
 * cases below are written from the position of a caller that has a bearer
 * token and is not the app.
 */

describe('what the server accepts as a file name', () => {
  it('accepts an ordinary resume', () => {
    expect(checkFileName('Jane Doe Resume.pdf')).toBeNull();
  });

  it('accepts an uppercase extension, because real uploads have them', () => {
    expect(checkFileName('RESUME.PDF')).toBeNull();
  });

  it.each([undefined, null, 42, {}, [], '', '   '])(
    'refuses %j as a file name',
    (value) => {
      expect(checkFileName(value)).toBe('file_name_required');
    },
  );

  it('refuses a name longer than the storage path should carry', () => {
    expect(checkFileName(`${'a'.repeat(MAX_FILE_NAME_LENGTH)}.pdf`)).toBe(
      'file_name_too_long',
    );
  });

  it.each(['resume.docx', 'resume.txt', 'resume', 'resume.pdf.exe'])(
    'refuses %s, which the worker cannot parse',
    (name) => {
      expect(checkFileName(name)).toBe('file_type_not_allowed');
    },
  );

  /*
   * The one that matters for the storage path. A name made only of
   * characters the sanitiser strips becomes a run of underscores - a path
   * nobody can read back to a human and a filename the user will not
   * recognise as theirs.
   */
  it('refuses a name that sanitises away to nothing recognisable', () => {
    expect(checkFileName('???? ????.pdf')).toBe('file_name_unusable');
    expect(checkFileName('日本語.pdf')).toBe('file_name_unusable');
  });

  it('reports the format complaint before the character one', () => {
    /* A user uploading a .docx is told about the format, not about characters. */
    expect(checkFileName('????.docx')).toBe('file_type_not_allowed');
  });

  it('gives every rejection a sentence a person could act on', () => {
    for (const code of [
      'file_name_required',
      'file_name_too_long',
      'file_type_not_allowed',
      'file_name_unusable',
    ] as const) {
      expect(rejectionMessage(code).length).toBeGreaterThan(10);
    }
  });
});

describe('sanitising a name into a storage path', () => {
  /*
   * The path-traversal case. Separators are not in the allowlist, so they
   * become underscores and the name cannot climb out of its prefix.
   */
  it('cannot escape its prefix', () => {
    const sanitized = sanitizeFileName('../../../etc/passwd.pdf');

    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('\\');
    expect(sanitized).toBe('.._.._.._etc_passwd.pdf');
  });

  it('removes every character outside the allowlist', () => {
    expect(sanitizeFileName('a b;c&d|e$f.pdf')).toBe('a_b_c_d_e_f.pdf');
  });

  it('is idempotent, so re-sanitising a path never changes it', () => {
    const once = sanitizeFileName('Jane Doe (final).pdf');

    expect(sanitizeFileName(once)).toBe(once);
  });

  it('caps the length', () => {
    expect(sanitizeFileName('a'.repeat(500)).length).toBe(MAX_FILE_NAME_LENGTH);
  });
});

describe('what storage turned out to be holding', () => {
  const ok = { exists: true, size: 120_000, contentType: 'application/pdf' };

  it('accepts a real PDF', () => {
    expect(checkStoredFile(ok)).toBeNull();
  });

  /*
   * Fail-closed. An object we cannot describe is one we do not hand to a
   * worker - most often because the user never actually uploaded.
   */
  it('refuses a file that is not there', () => {
    expect(checkStoredFile({ exists: false })).toBe('file_missing');
  });

  it('refuses an empty object, which is a failed upload not a resume', () => {
    expect(checkStoredFile({ ...ok, size: 0 })).toBe('file_empty');
  });

  it('refuses a file over the ceiling', () => {
    expect(checkStoredFile({ ...ok, size: MAX_FILE_BYTES + 1 })).toBe(
      'file_too_large',
    );
    /* And accepts one exactly at it, so the boundary is not off by one. */
    expect(checkStoredFile({ ...ok, size: MAX_FILE_BYTES })).toBeNull();
  });

  it('refuses a content type the worker cannot read', () => {
    expect(checkStoredFile({ ...ok, contentType: 'image/png' })).toBe(
      'content_type_not_allowed',
    );
    expect(checkStoredFile({ ...ok, contentType: 'text/html' })).toBe(
      'content_type_not_allowed',
    );
  });

  it('reads a content type with parameters as its base type', () => {
    expect(
      checkStoredFile({ ...ok, contentType: 'application/pdf; charset=binary' }),
    ).toBeNull();
  });

  /*
   * Narrowed in PR-3 once the bucket's real policy was verified: storage
   * declares allowed_mime_types ["application/pdf"], so an octet-stream
   * upload never lands and the previous allowance could only ever widen
   * this check without helping anybody.
   */
  it('refuses an unknown content type, matching the bucket policy', () => {
    expect(
      checkStoredFile({ ...ok, contentType: 'application/octet-stream' }),
    ).toBe('content_type_not_allowed');
  });

  /*
   * The two layers are configured in different places - this constant, and
   * the bucket's file_size_limit in Supabase - and they were verified
   * equal on 2026-09-09. Pinned so that changing one without the other is
   * a failing test rather than a silent disagreement in which the
   * application accepts what storage has already refused.
   */
  it('matches the verified bucket limits exactly', () => {
    expect(MAX_FILE_BYTES).toBe(10_485_760);
    expect([...ALLOWED_CONTENT_TYPES]).toEqual(['application/pdf']);
  });

  /*
   * Missing metadata is not a failure. Refusing every upload whose size we
   * could not read would turn a storage metadata gap into an outage.
   */
  it('accepts a file whose metadata storage did not report', () => {
    expect(checkStoredFile({ exists: true })).toBeNull();
    expect(checkStoredFile({ exists: true, size: null, contentType: null })).toBeNull();
    expect(checkStoredFile({ exists: true, contentType: '  ' })).toBeNull();
  });

  it('gives every stored rejection a sentence a person could act on', () => {
    for (const code of [
      'file_missing',
      'file_empty',
      'file_too_large',
      'content_type_not_allowed',
    ] as const) {
      expect(storedRejectionMessage(code).length).toBeGreaterThan(10);
    }
  });
});

describe('the import limits themselves', () => {
  /*
   * Pinned as values, because these are the numbers a user actually feels
   * and changing one should be a visible decision rather than a tweak.
   */
  it('allows retries and a second version in flight, but not a queue', () => {
    expect(MAX_ACTIVE_IMPORTS).toBe(3);
  });

  it('counts only statuses that are still going somewhere', () => {
    expect([...ACTIVE_IMPORT_STATUSES].sort()).toEqual([
      'NEEDS_REVIEW',
      'PENDING',
      'PROCESSING',
    ]);

    /*
     * The bug this prevents: counting terminal statuses would mean a user
     * hits the cap permanently after three uploads, which looks like a
     * policy and is a defect.
     */
    expect(ACTIVE_IMPORT_STATUSES).not.toContain('CONFIRMED');
    expect(ACTIVE_IMPORT_STATUSES).not.toContain('FAILED');
  });

  it('bounds abandoned imports, which the active cap alone does not', () => {
    expect(MAX_IMPORTS_PER_WINDOW).toBeGreaterThan(MAX_ACTIVE_IMPORTS);
  });
});
