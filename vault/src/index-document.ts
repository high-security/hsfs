/**
 * `.index.json` — the index document, as a value object.
 *
 * Same split as everything else here: `Indexer` manages the file, this decides what a valid
 * one *is*. Shape, validation, and nothing about I/O.
 *
 * The shape is the old vault's, so an index written by the previous implementation reads
 * back. Two fields are permissive where the old one was strict — `created` and `updated` are
 * optional, because a rebuild can only supply them when the store has a `stat` to take them
 * from, and it should not have to invent a date to satisfy a type.
 *
 * One field is new: `damaged`. See `DamagedRecord` for why a rebuild is not allowed to forget
 * what it found.
 */

import { isCorruptReason, type Corrupt, type CorruptReason } from "./errors.js";
import { Result } from "./result.js";

/**
 * Which vault wrote this index.
 *
 * **Informational, and deliberately not checked on read.** Comparing it against our own
 * version would rebuild the index every time the package is patched, which is pure waste. If
 * the *shape* ever changes, `parseIndex` is what must reject the old one — not this field.
 *
 * 1.1.0 added `damaged`, which is why the bump: not because a reader must branch, but because
 * an index that forgets what it found is a different index.
 */
export const INDEX_VERSION = "1.1.0";

export interface IndexRecord {
  id: string;
  /** The record's path, as the store understands it. */
  filename: string;
  metadata: Record<string, unknown>;
  /** ISO 8601. Absent when it was rebuilt from a store that has no `stat`. */
  created?: string;
  updated?: string;
}

/**
 * A file that claims to be a record, and does not verify.
 *
 * It is kept in the index for one reason: **a rebuild must not be able to erase what it
 * found.** Skipping what cannot be read looks tidier, and it is a lie — the index would then
 * describe a smaller store than the one on disk, and the only way to learn otherwise would be
 * to go and look yourself.
 *
 * Note what is *not* here: the data. A damaged record is reported, never interpreted.
 */
export interface DamagedRecord {
  /** The file it was found in. Always known — we found it by name. */
  filename: string;
  /**
   * The id the file claims, when it was readable enough to say. Absent on a torn write, which
   * is exactly when it matters most and exactly when nothing can be salvaged.
   */
  id?: string;
  /** The metadata that survived. Absent when it did not — note that this is salvage, not truth. */
  metadata?: Record<string, unknown>;
  reason: CorruptReason;
  detail: string;
}

export interface IndexDocument {
  records: IndexRecord[];
  /**
   * Records that were found and did not verify. They are not searchable — nothing can be read
   * out of them — but they are **known**, so `list` and `stats` can report them and `get` can
   * say `corrupt` instead of `absent`.
   */
  damaged: DamagedRecord[];
  /** The distinct record types present — what `find` searches by. */
  searchIndexes: string[];
  version: string;
  updated: string;
}

/** Read an index. Never throws; anything wrong with it is the normal reason to rebuild. */
export function parseIndex(json: string): Result<IndexDocument, Corrupt> {
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

  if (!Array.isArray(fields.records)) {
    return Result.failure({
      reason: "shape",
      detail: "records must be an array",
    });
  }
  if (!Array.isArray(fields.searchIndexes)) {
    return Result.failure({
      reason: "shape",
      detail: "searchIndexes must be an array",
    });
  }

  const records: IndexRecord[] = [];

  for (const [position, entry] of fields.records.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return Result.failure({
        reason: "shape",
        detail: `records[${position}] is not an object`,
      });
    }

    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.id !== "string" || candidate.id === "") {
      return Result.failure({
        reason: "shape",
        detail: `records[${position}].id`,
      });
    }
    if (typeof candidate.filename !== "string" || candidate.filename === "") {
      return Result.failure({
        reason: "shape",
        detail: `records[${position}].filename`,
      });
    }
    if (candidate.metadata === null || typeof candidate.metadata !== "object") {
      return Result.failure({
        reason: "shape",
        detail: `records[${position}].metadata`,
      });
    }

    records.push(candidate as unknown as IndexRecord);
  }

  const damaged = parseDamaged(fields.damaged);
  if (damaged.isFailure) return Result.failure(damaged.error);

  return Result.success({
    records,
    damaged: damaged.value,
    searchIndexes: fields.searchIndexes.filter(
      (type): type is string => typeof type === "string",
    ),
    version:
      typeof fields.version === "string" ? fields.version : INDEX_VERSION,
    updated:
      typeof fields.updated === "string"
        ? fields.updated
        : new Date().toISOString(),
  });
}

/**
 * Read the damage list. Absent is normal — an index written by an older version has none, and
 * so does a store where nothing has ever gone wrong.
 */
function parseDamaged(raw: unknown): Result<DamagedRecord[], Corrupt> {
  if (raw === undefined) return Result.success([]);

  if (!Array.isArray(raw)) {
    return Result.failure({
      reason: "shape",
      detail: "damaged must be an array",
    });
  }

  const damaged: DamagedRecord[] = [];

  for (const [position, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return Result.failure({
        reason: "shape",
        detail: `damaged[${position}] is not an object`,
      });
    }

    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.filename !== "string" || candidate.filename === "") {
      return Result.failure({
        reason: "shape",
        detail: `damaged[${position}].filename`,
      });
    }
    if (!isCorruptReason(candidate.reason)) {
      return Result.failure({
        reason: "shape",
        detail: `damaged[${position}].reason`,
      });
    }
    if (typeof candidate.detail !== "string") {
      return Result.failure({
        reason: "shape",
        detail: `damaged[${position}].detail`,
      });
    }

    damaged.push({
      filename: candidate.filename,
      ...(typeof candidate.id === "string" && candidate.id !== ""
        ? { id: candidate.id }
        : {}),
      ...(isPlainObject(candidate.metadata)
        ? { metadata: candidate.metadata }
        : {}),
      reason: candidate.reason,
      detail: candidate.detail,
    });
  }

  return Result.success(damaged);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
