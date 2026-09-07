import {
  connectionTokenAad,
  oauthCodeVerifierAad,
} from './aad.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('AAD builders', () => {
  it('is deterministic for the same inputs', () => {
    expect(
      connectionTokenAad(USER_A, 'GITHUB'),
    ).toEqual(
      connectionTokenAad(USER_A, 'GITHUB'),
    );
  });

  it('differs by user', () => {
    expect(
      connectionTokenAad(USER_A, 'GITHUB'),
    ).not.toEqual(
      connectionTokenAad(USER_B, 'GITHUB'),
    );
  });

  it('differs by provider', () => {
    expect(
      connectionTokenAad(USER_A, 'GITHUB'),
    ).not.toEqual(
      connectionTokenAad(USER_A, 'PORTFOLIO'),
    );
  });

  it('differs by domain for identical inputs', () => {
    expect(
      connectionTokenAad(USER_A, 'GITHUB'),
    ).not.toEqual(
      oauthCodeVerifierAad(USER_A, 'GITHUB'),
    );
  });

  /*
   * The encoding must be injective. If a crafted value could carry the
   * separator, then ("a|b", "c") and ("a", "b|c") would join to the same
   * bytes and one row's AAD would satisfy another's.
   */
  it('rejects a component containing the separator', () => {
    expect(() =>
      connectionTokenAad(
        `${USER_A}|GITHUB`,
        'PORTFOLIO',
      ),
    ).toThrow(
      'AAD components must not contain the separator',
    );
  });

  it('rejects an empty component', () => {
    expect(() =>
      connectionTokenAad('', 'GITHUB'),
    ).toThrow(
      'AAD components must not be empty',
    );

    expect(() =>
      connectionTokenAad(USER_A, ''),
    ).toThrow(
      'AAD components must not be empty',
    );
  });

  it('contains the owning user id, so a copied row cannot match', () => {
    expect(
      connectionTokenAad(
        USER_A,
        'GITHUB',
      ).toString('utf8'),
    ).toContain(USER_A);
  });
});
