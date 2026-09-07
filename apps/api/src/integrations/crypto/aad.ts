/*
 * Additional Authenticated Data for the encrypted columns.
 *
 * AES-GCM authenticates the AAD alongside the ciphertext, so a value can
 * only be decrypted by supplying exactly the AAD it was encrypted under.
 * That turns each ciphertext into something bound to the row that owns it.
 *
 * The attack this exists to stop: without an AAD, anyone able to UPDATE
 * ExternalConnection could copy a victim's tokenCiphertext, tokenIv and
 * tokenTag into their own row. Every column would be internally
 * consistent, decryption would succeed, and their syncs would run against
 * the victim's provider account. With the owner's id inside the AAD, the
 * copied row fails to decrypt.
 *
 * Domains are separated for the same reason one level up: a token
 * ciphertext must not decrypt when presented as a PKCE verifier, even for
 * the same user and provider.
 */

/*
 * Chosen because it cannot occur in any value we join: the parts are
 * uuids (hex and hyphens) and enum members (uppercase and underscore).
 * That makes the encoding unambiguous, so no part can be shifted into
 * another by crafting a value - "a|b" plus "c" must not encode the same
 * as "a" plus "b|c". The guard in build() enforces the property rather
 * than trusting it, because the day a provider id is not a uuid is the
 * day this assumption quietly stops holding.
 */
const SEPARATOR = '|';

const DOMAIN_CONNECTION_TOKEN = 'external-connection:token';

const DOMAIN_OAUTH_CODE_VERIFIER =
  'oauth-authorization-request:code-verifier';

function build(
  domain: string,
  parts: readonly string[],
): Buffer {
  for (const part of parts) {
    /*
     * An empty part would make two different tuples encode identically
     * once joined, which is exactly the ambiguity the separator exists to
     * prevent.
     */
    if (part.length === 0) {
      throw new Error(
        'AAD components must not be empty',
      );
    }

    if (part.includes(SEPARATOR)) {
      throw new Error(
        'AAD components must not contain the separator',
      );
    }
  }

  return Buffer.from(
    [domain, ...parts].join(SEPARATOR),
    'utf8',
  );
}

/** Binds an encrypted provider token to the user and provider that own it. */
export function connectionTokenAad(
  userId: string,
  provider: string,
): Buffer {
  return build(DOMAIN_CONNECTION_TOKEN, [
    userId,
    provider,
  ]);
}

/** Binds an encrypted PKCE verifier to the user and provider that own it. */
export function oauthCodeVerifierAad(
  userId: string,
  provider: string,
): Buffer {
  return build(DOMAIN_OAUTH_CODE_VERIFIER, [
    userId,
    provider,
  ]);
}
