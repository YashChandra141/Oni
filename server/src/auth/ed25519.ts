// Ed25519 signature verification for SIWS sign-in (Req 45.4; design Decision A11).
//
// Decision (task 18.2): verification stays on WebCrypto (`crypto.subtle`, Ed25519). No crypto
// dependency is added. The RFC 8032 TEST 1–3 vectors in ed25519.test.ts prove the path on Bun 1.4.4.
// If those vectors fail on Bun 1.4.4, Bun's WebCrypto lacks Ed25519 there. Then swap in exact-pinned
// @noble/curves behind this same function and record that here (design Decision A11).
//
// Argument order is (publicKey, signature, message). Design Decision A11 lists the message before the
// signature. This module follows the task's order, and the call sites must match it.
// Every function here is total: bad input of any kind (wrong type, wrong length, a key WebCrypto
// rejects) yields false or null and never throws.

import { tryDecodeBase58 } from "../../../shared/base58.ts";

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/** Longest base58 text of 32 bytes. Longer input is rejected before decoding. */
const MAX_ADDRESS_LENGTH = 44;

/**
 * Decodes a Wallet_Address (base58) into its 32-byte Ed25519 public key. Returns null when the text
 * is not base58 or does not decode to exactly 32 bytes.
 */
export function decodePublicKey(address: string): Uint8Array | null {
  if (typeof address !== "string" || address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  const bytes = tryDecodeBase58(address);
  return bytes !== null && bytes.length === ED25519_PUBLIC_KEY_BYTES ? bytes : null;
}

/**
 * Verifies an Ed25519 signature over `message`. Returns true only for a 64-byte signature that is
 * valid for the 32-byte public key. Returns false for any other input, including wrong lengths, a
 * public key that is not a valid curve point, and arguments that are not Uint8Arrays.
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  try {
    if (!(publicKey instanceof Uint8Array) || !(signature instanceof Uint8Array) || !(message instanceof Uint8Array)) {
      return false;
    }
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    // Copy into fresh buffers: the inputs may be views into a larger buffer, and WebCrypto takes
    // ArrayBuffer-backed data.
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, new Uint8Array(signature), new Uint8Array(message));
  } catch {
    return false;
  }
}
