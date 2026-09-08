import { describe, expect, it } from 'vitest';

import {
  redactContactText,
  redactPayload,
  redactRecord,
  REDACTION_VERSION,
  type ContactRedaction,
} from './redaction.js';

/*
 * Every fixture here is synthetic by construction.
 *
 * Addresses use the RFC 2606 reserved TLD `.invalid`, which can never be
 * registered, and numbers use documentation ranges. A test for a privacy
 * control must not itself be a place personal data is stored - and the
 * corpus invariant that proves the control worked on REAL data lives in
 * the database tier, where it asserts a count of zero and prints a posting
 * id rather than a match.
 */

const NONE: ContactRedaction = { structuredFields: [], nationalPhone: null };

const SWEDISH: ContactRedaction = {
  structuredFields: ['application_details.email'],
  nationalPhone: /\b07[02369][-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b/,
};

describe('redacting a body', () => {
  it('removes an address and leaves the sentence around it', () => {
    expect(
      redactContactText('Ansök via ada.lovelace@example.invalid idag.', NONE),
    ).toBe('Ansök via [redacted:email] idag.');
  });

  it('removes a mailto link whole, not just the address inside it', () => {
    const out = redactContactText(
      'Write to <a href="mailto:ada@example.invalid">Ada</a>',
      NONE,
    );

    /* `mailto:[redacted:email]` would still say "write to somebody". */
    expect(out).not.toContain('mailto:');
    expect(out).toContain('[redacted:email]');
  });

  it('removes an international number on any source', () => {
    expect(redactContactText('Ring +46 70 123 45 67 idag', NONE)).toBe(
      'Ring [redacted:phone] idag',
    );
  });

  it('removes a national number only where the source declared the form', () => {
    const text = 'Ring 070-123 45 67';

    expect(redactContactText(text, SWEDISH)).toBe('Ring [redacted:phone]');
    /*
     * Not a gap. A bare run of digits is a postcode, a salary or a year in
     * every other market, and a generic pattern over this corpus matched
     * 1085 strings against 777 real numbers. The market is the adapter's
     * knowledge, so the pattern is declared there.
     */
    expect(redactContactText(text, NONE)).toBe(text);
  });

  /*
   * The over-matching this design refuses. A redactor that eats these
   * would quietly corrupt the market data it exists to protect.
   */
  it.each([
    ['a Swedish postcode', 'Stockholm 113 30, Sweden'],
    ['a salary range', 'Salary 45 000 - 55 000 SEK'],
    ['a version string', 'Requires react@18.2.0 or newer'],
    ['a year and a headcount', 'Founded 2019, now 250 people'],
  ])('leaves %s alone', (_label, text) => {
    expect(redactContactText(text, SWEDISH)).toBe(text);
  });

  it('is idempotent, so the pipeline and an adapter may both apply it', () => {
    const once = redactContactText('mail ada@example.invalid', SWEDISH);
    const twice = redactContactText(once, SWEDISH);

    expect(twice).toBe(once);
  });

  it('returns null for an absent body rather than an empty string', () => {
    expect(redactContactText(null, NONE)).toBeNull();
  });
});

describe('redacting a payload', () => {
  it('removes a declared field by its dotted path', () => {
    const out = redactPayload(
      {
        application_details: {
          email: 'ada@example.invalid',
          url: 'https://e.invalid',
        },
      },
      SWEDISH,
    );

    expect(out).toEqual({ application_details: { url: 'https://e.invalid' } });
  });

  /*
   * The half that makes this a control rather than a checklist: a source
   * that moves an address into a field nobody listed still has it removed.
   */
  it('removes an address from a field nobody declared', () => {
    const out = redactPayload({ notes: 'reach ada@example.invalid' }, SWEDISH);

    expect(out).toEqual({ notes: 'reach [redacted:email]' });
  });

  it('reaches inside arrays and nested objects', () => {
    const out = redactPayload(
      { contacts: [{ deep: { note: 'ada@example.invalid' } }] },
      NONE,
    );

    expect(out).toEqual({
      contacts: [{ deep: { note: '[redacted:email]' } }],
    });
  });

  it('does not mutate the object the adapter passed in', () => {
    const input = { employer: { email: 'ada@example.invalid' } };

    redactPayload(input, {
      structuredFields: ['employer.email'],
      nationalPhone: null,
    });

    expect(input.employer.email).toBe('ada@example.invalid');
  });

  it('leaves a path alone when a segment is not an object', () => {
    expect(redactPayload({ employer: 'Acme' }, SWEDISH)).toEqual({
      employer: 'Acme',
    });
  });
});

describe('redacting a whole record', () => {
  const record = {
    titleRaw: 'Engineer',
    companyRaw: 'Acme',
    locationRaw: 'Stockholm',
    descriptionRaw: 'Contact ada@example.invalid',
    applyUrlRaw: 'https://example.invalid/apply?utm_source=x',
    payload: { description: { text: 'Contact ada@example.invalid' } },
  };

  it('cleans the body and the payload together', () => {
    const out = redactRecord(record, SWEDISH);

    expect(out.descriptionRaw).toBe('Contact [redacted:email]');
    expect(JSON.stringify(out.payload)).not.toContain('@example.invalid');
  });

  /*
   * The apply URL is a link to a page, not a way to reach a person -
   * neither source has an address in one - and running an email pattern
   * over a query string would mangle legitimate parameters.
   */
  it('leaves the apply URL untouched', () => {
    expect(redactRecord(record, SWEDISH).applyUrlRaw).toBe(record.applyUrlRaw);
  });

  it('detects a planted address, so the assertions above are not vacuous', () => {
    const out = redactRecord(
      { ...record, descriptionRaw: 'no contact here' },
      SWEDISH,
    );

    expect(out.descriptionRaw).toBe('no contact here');
    expect(redactRecord(record, SWEDISH).descriptionRaw).not.toBe(
      record.descriptionRaw,
    );
  });
});

describe('the redaction version', () => {
  /*
   * Folded into the content-hash preimage, so what a version row commits
   * to is the redacted text. Changing what is removed must be a labelled
   * split, not a silent rewrite of every hash.
   */
  it('is a whole number that the content hash can commit to', () => {
    expect(Number.isInteger(REDACTION_VERSION)).toBe(true);
    expect(REDACTION_VERSION).toBeGreaterThan(0);
  });
});
