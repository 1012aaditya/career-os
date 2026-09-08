import { describe, expect, it } from 'vitest';

import { redactContactText, redactPayload } from './redaction.js';

/*
 * Regression cover for the legacy sanitizer.
 *
 * Every fixture is synthetic: addresses use the RFC 2606 reserved
 * .invalid TLD and numbers use documentation ranges, because a test for a
 * privacy control must not itself become a place personal data is stored.
 * The proof that the LIVE corpus is clean is a count-of-zero query, not a
 * fixture.
 */

const LEGACY = {
  structuredFields: [
    'application_contacts',
    'employer.email',
    'employer.phone_number',
    'application_details.email',
  ],
  nationalPhone: /\b07[02369][-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b/,
};

describe('sanitizing legacy evidence', () => {
  it('removes an address the pre-persistence sanitizer never saw', () => {
    expect(
      redactContactText('Kontakta ada.lovelace@example.invalid', LEGACY),
    ).toBe('Kontakta [redacted:email]');
  });

  it('removes the payload field the original strip list missed', () => {
    /*
     * application_details.email accounted for 442 distinct addresses
     * across 639 rows, 380 of which appeared in no other column - so a
     * body-only audit reported clean while they sat in the payload.
     */
    const out = redactPayload(
      {
        application_details: {
          email: 'a@example.invalid',
          url: 'https://e.invalid',
        },
      },
      LEGACY,
    );

    expect(JSON.stringify(out)).not.toContain('@example.invalid');
    expect(JSON.stringify(out)).toContain('e.invalid');
  });

  it('is idempotent, so re-running the cleanup rewrites nothing', () => {
    const once = redactContactText('mail a@example.invalid', LEGACY);

    expect(redactContactText(once, LEGACY)).toBe(once);
  });

  /*
   * The cleanup must not become a content shredder. These are the shapes
   * a loose pattern would eat, and they are legitimate market evidence.
   */
  it.each([
    ['a Swedish postcode', 'Stockholm 113 30'],
    ['a salary band', 'Lon 45 000 - 55 000 SEK'],
    ['a version string', 'react@18.2.0'],
  ])('leaves %s intact', (_label, text) => {
    expect(redactContactText(text, LEGACY)).toBe(text);
  });

  it('detects a planted address, so the checks above are not vacuous', () => {
    expect(redactContactText('x a@example.invalid', LEGACY)).not.toBe(
      'x a@example.invalid',
    );
  });
});
