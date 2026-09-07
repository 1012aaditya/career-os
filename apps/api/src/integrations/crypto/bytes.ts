/*
 * Conversion between the two byte representations this codebase has to
 * hold at once.
 *
 * node:crypto produces Buffer, and Prisma maps a `Bytes` column to
 * Uint8Array. Buffer is a Uint8Array subclass, so the values are
 * compatible at runtime, but their type parameters are not - Buffer is
 * backed by ArrayBufferLike and Prisma's field is Uint8Array<ArrayBuffer>
 * - and TypeScript is right to object. Converting explicitly at the
 * persistence boundary keeps EncryptionService free of any knowledge of
 * where its output is stored.
 *
 * The copy in toStorageBytes is deliberate, not incidental. Small Buffers
 * are allocated from a shared pool, so a Buffer's underlying ArrayBuffer
 * routinely contains unrelated bytes belonging to other allocations.
 * Copying into a Uint8Array of exactly the right length means only the
 * value itself can ever reach the database.
 */

/** Buffer from node:crypto, ready for a Prisma `Bytes` column. */
export function toStorageBytes(
  value: Buffer,
): Uint8Array<ArrayBuffer> {
  /*
   * The ArrayBuffer is allocated here rather than letting `new
   * Uint8Array(value)` infer one, because that produces
   * Uint8Array<ArrayBufferLike> - Buffer may be backed by a
   * SharedArrayBuffer as far as the type system knows - and Prisma's
   * field is Uint8Array<ArrayBuffer>. Allocating explicitly gives an
   * exactly-sized, unshared buffer holding only this value.
   */
  const copy = new Uint8Array(
    new ArrayBuffer(value.byteLength),
  );

  copy.set(value);

  return copy;
}

/** A Prisma `Bytes` column, ready for node:crypto. */
export function fromStorageBytes(
  value: Uint8Array,
): Buffer {
  return Buffer.from(value);
}
