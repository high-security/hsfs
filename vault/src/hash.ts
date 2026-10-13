/**
 * Hashing, kept in one file.
 *
 * SHA-256, hex. Hex rather than base64url purely because a checksum ends up **inside
 * filenames** next to `-` separators, and a base64url digest can itself contain `-`.
 */

import { createHash } from "node:crypto";

/** SHA-256 of a string, lowercase hex. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
