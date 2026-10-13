/**
 * `VaultRecord<T>` — the **value object**.
 *
 * It knows its own shape and nothing else. No filesystem, no capability strings, no
 * `teach()`, no I/O: it can tell you what a valid record looks like, build one, serialise
 * one, and — the part that matters — **decide whether a string of bytes is one.**
 *
 * That last job is why this is a value object rather than a wrapper. Corruption is a
 * question about *format*, and the format is the only thing that can answer it. The vault
 * moves bytes; the record judges them.
 *
 * ### The checksum covers the whole record
 *
 * `checksum` is a hash of `{ id, data, metadata, version }` — everything except itself. So
 * editing the `id`, or the metadata, or the payload all break it. A checksum over just the
 * payload would leave the rest of the record unguarded, which is most of a record.
 *
 * It is computed over a **stable** serialisation (sorted keys, no whitespace) while the file
 * itself is written pretty-printed. That means reformatting a record by hand — which is what
 * you do when you are recovering one — does **not** invalidate it.
 */

import type { Corrupt } from "./errors.js";
import { sha256 } from "./hash.js";
import { Result } from "./result.js";

/** Written into every record. Bumped when the shape changes in a way a reader must know about. */
export const RECORD_VERSION = "1.0.0";

/** The suffix that marks a file as a record. Anything else in the store is not ours. */
export const RECORD_SUFFIX = ".vault.json";

/** The record, as it is stored. */
export interface RecordFields<T> {
  id: string;
  data: T;
  metadata: Record<string, unknown>;
  checksum: string;
  version: string;
}

export interface CreateRecordArgs<T> {
  id: string;
  data: T;
  metadata?: Record<string, unknown>;
  version?: string;
}

export class VaultRecord<T> {
  readonly id: string;
  readonly data: T;
  readonly metadata: Record<string, unknown>;
  readonly checksum: string;
  readonly version: string;

  private constructor(fields: RecordFields<T>) {
    this.id = fields.id;
    this.data = fields.data;
    this.metadata = fields.metadata;
    this.checksum = fields.checksum;
    this.version = fields.version;
  }

  /**
   * Build a record, computing its checksum.
   *
   * @throws {TypeError} if the payload cannot be serialised at all — circular, or holding a
   * `bigint`/function/symbol. `Vault.put` turns that into `invalid`, because it is the
   * caller's data rather than the store's failure.
   */
  static create<T>(args: CreateRecordArgs<T>): VaultRecord<T> {
    const fields = {
      id: args.id,
      data: args.data,
      metadata: args.metadata ?? {},
      version: args.version ?? RECORD_VERSION,
    };

    if (fields.data === undefined) {
      throw new TypeError("a record needs data");
    }

    return new VaultRecord<T>({ ...fields, checksum: checksumOf(fields) });
  }

  /**
   * Decide whether a string is a record. **Never throws** — a bad string is a result.
   *
   * The reasons are distinct on purpose: `unparseable` means the bytes are not JSON,
   * `shape` means they are JSON of the wrong form, `checksum` means the record is intact
   * but does not match its own hash. Whoever is recovering a store needs to know which.
   */
  static parse<T>(json: string): Result<VaultRecord<T>, Corrupt> {
    let raw: unknown;

    try {
      raw = JSON.parse(json);
    } catch (error) {
      return Result.failure({
        reason: "unparseable",
        detail: messageOf(error),
      });
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return Result.failure({ reason: "shape", detail: "not an object" });
    }

    const fields = raw as Record<string, unknown>;
    const problems: string[] = [];

    if (typeof fields.id !== "string" || fields.id === "") problems.push("id");
    if (!Object.hasOwn(fields, "data")) problems.push("data");
    if (!isPlainObject(fields.metadata)) problems.push("metadata");
    if (typeof fields.checksum !== "string" || fields.checksum === "") {
      problems.push("checksum");
    }
    if (typeof fields.version !== "string" || fields.version === "") {
      problems.push("version");
    }

    if (problems.length > 0) {
      return Result.failure({
        reason: "shape",
        detail: `missing or malformed: ${problems.join(", ")}`,
      });
    }

    const record = fields as unknown as RecordFields<T>;
    const expected = checksumOf(record);

    if (expected !== record.checksum) {
      return Result.failure({
        reason: "checksum",
        detail: `expected ${expected}, found ${record.checksum}`,
      });
    }

    return Result.success(new VaultRecord<T>(record));
  }

  /** The record as stored: pretty-printed, stable field order, greppable and diffable. */
  toJSON(): string {
    return `${JSON.stringify(
      {
        id: this.id,
        data: this.data,
        metadata: this.metadata,
        checksum: this.checksum,
        version: this.version,
      },
      null,
      2,
    )}\n`;
  }
}

/** The checksum of a record's contents — everything except `checksum` itself. */
export function checksumOf(fields: {
  id: string;
  data: unknown;
  metadata: Record<string, unknown>;
  version: string;
}): string {
  return sha256(
    stableStringify({
      id: fields.id,
      data: fields.data,
      metadata: fields.metadata,
      version: fields.version,
    }),
  );
}

/**
 * JSON with sorted keys and no whitespace, so the same logical record always hashes the
 * same. Objects are sorted, arrays keep their order (order is meaning there), and
 * `undefined` members are dropped, as `JSON.stringify` would.
 *
 * @throws {TypeError} on a cycle or an unserialisable value, rather than overflowing the
 * stack or silently writing `null`.
 */
export function stableStringify(
  value: unknown,
  seen: Set<object> = new Set(),
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "undefined":
      return "null";
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`cannot serialise a ${typeof value}`);
    default:
      break;
  }

  const object = value as object;

  if (seen.has(object)) {
    throw new TypeError("cannot serialise a circular structure");
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => stableStringify(item, seen)).join(",")}]`;
    }

    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableStringify(item, seen)}`,
      )
      .join(",")}}`;
  } finally {
    // Removed, not merely marked: the same object appearing twice in different branches is
    // duplication, not a cycle.
    seen.delete(object);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What a damaged record can still tell us.
 *
 * Best effort, and only ever run on a file that has **already failed** to parse — so it is not
 * allowed to be fussy about what it finds.
 *
 * It exists for one reason: a checksum failure leaves the id and the metadata perfectly
 * readable. Without this, `rebuild` would have nothing to file the record under and would
 * have to drop it — turning *a broken record* into *no record at all*, which is the one
 * outcome worth avoiding.
 */
export function salvageRecord(json: string): {
  id?: string;
  metadata?: Record<string, unknown>;
} {
  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch {
    // A torn write is the classic case, and it is precisely the one with nothing to salvage.
    return {};
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};

  const fields = raw as Record<string, unknown>;

  return {
    ...(typeof fields.id === "string" && fields.id !== ""
      ? { id: fields.id }
      : {}),
    ...(isPlainObject(fields.metadata) ? { metadata: fields.metadata } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
