/**
 * The store descriptor — `.vault.json`.
 *
 * It lives beside the records and says what the store *is*: its name, its version, and how
 * its contents are encoded, compressed and encrypted. That last part is the reason it exists
 * at all: **a reader must be able to learn how to read the records before reading one.**
 *
 * It **records** the encryption; it does not implement it. Actually encrypting is a different
 * package's job — this one only has to be honest about what it is looking at, so that the
 * layer above can decide what to do about it.
 */

import type { Corrupt } from "./errors.js";
import { Result } from "./result.js";

/** The store descriptor's filename. Also the one file in the folder that is not a record. */
export const VAULT_FILENAME = ".vault.json";

export const VAULT_VERSION = "1.0.0";

export type VaultEncoding = "utf8" | "base64" | "hex";
export type VaultFormat = "json" | "binary" | "text";

export interface VaultMetadata {
  name: string;
  version: string;
  /** ISO 8601. */
  created: string;
  /** ISO 8601. Updated when the store is opened, not on every write — see `Vault.open`. */
  lastAccessed: string;
  /** Whether the records are encrypted. **How** is the layer's business; that they **are** is ours to say. */
  encryption: boolean;
  compression: boolean;
  encoding: VaultEncoding;
  format: VaultFormat;
}

export interface CreateVaultMetadataArgs {
  name?: string;
  encryption?: boolean;
  compression?: boolean;
  encoding?: VaultEncoding;
  format?: VaultFormat;
  now?: Date;
}

/** A descriptor for a new store. */
export function createVaultMetadata(
  args: CreateVaultMetadataArgs = {},
): VaultMetadata {
  const now = (args.now ?? new Date()).toISOString();

  return {
    name: args.name ?? "vault",
    version: VAULT_VERSION,
    created: now,
    lastAccessed: now,
    encryption: args.encryption ?? false,
    compression: args.compression ?? false,
    encoding: args.encoding ?? "utf8",
    format: args.format ?? "json",
  };
}

/**
 * Read a descriptor. Never throws, and validates every field rather than trusting the file:
 * a descriptor that silently defaulted would tell the layer above the wrong thing about
 * encryption, which is the one mistake this file exists to prevent.
 */
export function parseVaultMetadata(
  json: string,
): Result<VaultMetadata, Corrupt> {
  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch (error) {
    return Result.failure({ reason: "unparseable", detail: messageOf(error) });
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Result.failure({ reason: "shape", detail: "not an object" });
  }

  const fields = raw as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of ["name", "version", "created", "lastAccessed"] as const) {
    if (typeof fields[key] !== "string" || (fields[key] as string) === "")
      problems.push(key);
  }

  if (typeof fields.encryption !== "boolean") problems.push("encryption");
  if (typeof fields.compression !== "boolean") problems.push("compression");
  if (!isOneOf(fields.encoding, ["utf8", "base64", "hex"]))
    problems.push("encoding");
  if (!isOneOf(fields.format, ["json", "binary", "text"]))
    problems.push("format");

  if (problems.length > 0) {
    return Result.failure({
      reason: "shape",
      detail: `missing or malformed: ${problems.join(", ")}`,
    });
  }

  return Result.success(fields as unknown as VaultMetadata);
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
