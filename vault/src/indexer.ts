/**
 * The indexer — the bridge between an **id** and a **file**.
 *
 * Two jobs, and both of them exist because the record's filename is *not* its id:
 *
 * 1. **Resolution.** `id → filename`, so `get` is one read rather than a scan of the folder.
 * 2. **Search.** Metadata and record types, so `find` answers from the index instead of
 *    opening hundreds of files.
 *
 * ### The index is a hint, not the truth
 *
 * The records are the truth. The index is a derived cache, and that is what stops its
 * corruption from being data loss: a missing, stale or torn index is a **cache miss**, and
 * the answer is to rebuild it from the records — which works because every record carries
 * its own id and metadata and validates itself.
 *
 * So the index is never *trusted* on the way in. `open` reads it, and if anything about it is
 * wrong — absent, unreadable, unparseable — it rebuilds and says so
 * rather than failing. The worst case of a bad index is a slow first call.
 *
 * ### What a rebuild keeps
 *
 * A record it could not read is **recorded, not skipped**. Skipping would leave the index
 * describing a smaller store than the one on disk, and nothing would say so. So damage is
 * carried in the index, which is what lets `list`, `stats` and `get` stay honest about a
 * record that is present and broken — and what lets `Vault.verify` report it later without a
 * second full sweep.
 *
 * ### What a rebuild cannot recover
 *
 * `created` and `updated` are index bookkeeping that the records do not carry. A rebuild
 * takes them from the file's `stat` where the store has one (the port's optional `stat`),
 * and leaves them absent otherwise. App metadata — `type`, and everything else the caller
 * stored — *is* in the record, so search survives a rebuild intact.
 *
 * ### Known gap: no locking
 *
 * Two processes writing the index at once can lose an update. The damage is bounded (the
 * index is derived, so a rebuild fixes it), but it is not prevented. `proper-lockfile` is the
 * obvious fix on a local disk and cannot work over an object store, which makes it a decision
 * rather than a detail.
 */

import { basename } from "node:path";
import type { IFileSystem } from "@hsfs/core";
import type { VaultError } from "./errors.js";
import {
  INDEX_VERSION,
  parseIndex,
  type DamagedRecord,
  type IndexDocument,
  type IndexRecord,
} from "./index-document.js";
import { VAULT_FILENAME } from "./metadata.js";
import { RECORD_SUFFIX, VaultRecord, salvageRecord } from "./record.js";
import { Result } from "./result.js";

export const INDEX_FILENAME = ".index.json";

export interface IndexerOptions {
  fs: IFileSystem;
  /** The vault's folder, as a path the store understands. Usually `""` — the store *is* the folder. */
  path?: string;
}

export interface OpenReport {
  document: IndexDocument;
  /** `"loaded"` when the file was good; the rebuild reason when it was not. */
  source: "loaded" | "rebuilt";
  /** Why a rebuild happened. Absent when `source` is `"loaded"`. */
  reason?: string;
}

export class Indexer {
  readonly #fs: IFileSystem;
  readonly #path: string;
  #document: IndexDocument | undefined;

  constructor(options: IndexerOptions) {
    if (options?.fs === undefined) {
      throw new TypeError("a filesystem is required");
    }

    this.#fs = options.fs;
    this.#path = options.path ?? "";
  }

  /** The loaded index. Throws if `open` has not run — a programming error, not a condition. */
  get document(): IndexDocument {
    if (this.#document === undefined) {
      throw new Error("the index has not been opened");
    }
    return this.#document;
  }

  /**
   * Load the index, or build one. **Never fails because the index is bad** — a bad index is
   * the normal reason to rebuild, not a reason to refuse.
   */
  async open(): Promise<Result<OpenReport, VaultError>> {
    const json = await this.#readQuietly(INDEX_FILENAME);

    if (json !== undefined) {
      const parsed = parseIndex(json);

      if (parsed.isSuccess) {
        this.#document = parsed.value;
        return Result.success({ document: parsed.value, source: "loaded" });
      }

      const rebuilt = await this.rebuild();
      if (rebuilt.isFailure) return Result.failure(rebuilt.error);

      return Result.success({
        document: rebuilt.value,
        source: "rebuilt",
        reason: `the index was ${parsed.error.reason}: ${parsed.error.detail}`,
      });
    }

    const rebuilt = await this.rebuild();
    if (rebuilt.isFailure) return Result.failure(rebuilt.error);

    return Result.success({
      document: rebuilt.value,
      source: "rebuilt",
      reason: "there was no index",
    });
  }

  /**
   * Rebuild the index from the records themselves.
   *
   * This is the method that makes the index disposable. It reads every record, verifies each
   * one, and **records** — rather than skips — anything that does not verify. A rotted record
   * is still a record that is *there*, and a rebuild must not be the thing that makes it
   * disappear.
   *
   * If two files claim the same id — which is what a write that completed followed by an index
   * update that did not leaves behind — the **newer file wins** and the older is left alone on
   * disk. `.index.json` is keyed by id and cannot hold both; `Vault.verify` is what reports the
   * loser, because an index is not the place to record an ambiguity it can only resolve.
   */
  async rebuild(): Promise<Result<IndexDocument, VaultError>> {
    const paths = await this.recordFiles();
    if (paths.isFailure) return Result.failure(paths.error);

    const found: Array<{
      id: string;
      filename: string;
      metadata: Record<string, unknown>;
    }> = [];
    const damaged: DamagedRecord[] = [];

    for (const path of paths.value) {
      const json = await this.#readQuietly(path);

      if (json === undefined) {
        damaged.push({
          filename: path,
          reason: "unreadable",
          detail: "the store could not read it",
        });
        continue;
      }

      const parsed = VaultRecord.parse<unknown>(json);

      if (parsed.isFailure) {
        const salvage = salvageRecord(json);

        damaged.push({
          filename: path,
          // Salvaged when it could be — a checksum failure leaves the id and the metadata
          // perfectly readable, and an id is what lets `get` answer `corrupt` instead of
          // `absent`.
          ...(salvage.id === undefined ? {} : { id: salvage.id }),
          ...(salvage.metadata === undefined
            ? {}
            : { metadata: salvage.metadata }),
          reason: parsed.error.reason,
          detail: parsed.error.detail,
        });
        continue;
      }

      found.push({
        id: parsed.value.id,
        filename: path,
        metadata: parsed.value.metadata,
      });
    }

    // One entry per id. Every filename starts with the epoch it was written at, so "newest" is
    // read off the name the store already gave the file — no clock of ours, and nothing that an
    // object store without `stat` can take away.
    const winners = new Map<string, (typeof found)[number]>();

    for (const record of found) {
      const held = winners.get(record.id);
      if (held === undefined || record.filename > held.filename)
        winners.set(record.id, record);
    }

    const records: IndexRecord[] = [];
    const types = new Set<string>();

    for (const record of winners.values()) {
      const stamp = await this.#modifiedAt(record.filename);

      records.push({
        id: record.id,
        filename: record.filename,
        metadata: record.metadata,
        ...(stamp === undefined ? {} : { created: stamp, updated: stamp }),
      });

      const type = record.metadata.type;
      if (typeof type === "string") types.add(type);
    }

    this.#document = {
      records,
      damaged,
      searchIndexes: [...types].sort(),
      version: INDEX_VERSION,
      updated: new Date().toISOString(),
    };

    return Result.success(this.#document);
  }

  /** Record that an id now lives at a filename. Replaces any previous entry for that id. */
  async add(record: IndexRecord): Promise<Result<void, VaultError>> {
    const document = this.document;

    const next: IndexDocument = {
      records: [
        ...document.records.filter((entry) => entry.id !== record.id),
        record,
      ],
      // Saving over a damaged record repairs it as far as the index is concerned: the id now
      // points at a file that verifies, and an id has one current record. Whatever was on disk
      // before is still on disk, and still `verify`'s to report.
      damaged: document.damaged.filter((entry) => entry.id !== record.id),
      searchIndexes: mergeTypes(document.searchIndexes, record.metadata.type),
      version: INDEX_VERSION,
      updated: new Date().toISOString(),
    };

    return this.#write(next);
  }

  /**
   * Forget an id — its record, and any damage recorded under it. Succeeds whether or not the
   * id was known.
   */
  async remove(id: string): Promise<Result<boolean, VaultError>> {
    const document = this.document;
    const records = document.records.filter((entry) => entry.id !== id);
    const damaged = document.damaged.filter((entry) => entry.id !== id);

    const removed =
      records.length !== document.records.length ||
      damaged.length !== document.damaged.length;

    if (!removed) {
      return Result.success(false);
    }

    const types = new Set(
      records.flatMap((entry) =>
        typeof entry.metadata.type === "string"
          ? [entry.metadata.type as string]
          : [],
      ),
    );

    const written = await this.#write({
      records,
      damaged,
      searchIndexes: [...types].sort(),
      version: INDEX_VERSION,
      updated: new Date().toISOString(),
    });

    return written.isSuccess
      ? Result.success(true)
      : Result.failure(written.error);
  }

  /** The filename for an id, or `undefined` if the index does not know it. */
  resolve(id: string): string | undefined {
    return this.document.records.find((entry) => entry.id === id)?.filename;
  }

  /** The index entry for an id. */
  entry(id: string): IndexRecord | undefined {
    return this.document.records.find((entry) => entry.id === id);
  }

  /**
   * Entries matching a keyword.
   *
   * Matches the record's **metadata** — "Search only in this record's metadata", as the
   * previous implementation put it — so a record's `type` is matched because the type is
   * part of its metadata. The **id is not searched**: an id is a handle you already have, and
   * you call `get` with it.
   *
   * Answers from the index alone, without opening a single file.
   */
  find(keyword: string): IndexRecord[] {
    const needle = keyword.toLowerCase();

    return this.document.records.filter((entry) =>
      metadataContains(entry.metadata, needle),
    );
  }

  /** Every entry, for `list` and `stats`. */
  query(): IndexRecord[] {
    return [...this.document.records];
  }

  /** The distinct record types the index knows about. */
  get searchIndexes(): string[] {
    return [...this.document.searchIndexes];
  }

  /** Records the index knows are broken — found, not usable, and not forgotten. */
  get damaged(): DamagedRecord[] {
    return this.document.damaged.map((entry) => ({ ...entry }));
  }

  /** The damage recorded against an id, when the index knows that record is broken. */
  damagedFor(id: string): DamagedRecord[] {
    return this.document.damaged
      .filter((entry) => entry.id === id)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Every file in the store that claims to be a record — everything but the descriptor.
   *
   * Public because `Vault.verify` asks the same question of the same store, and two answers to
   * "which files are ours" would eventually differ.
   */
  async recordFiles(): Promise<Result<string[], VaultError>> {
    try {
      const files = await this.#fs.list(this.#path);

      return Result.success(
        files
          .filter(
            (path) =>
              path.endsWith(RECORD_SUFFIX) && basename(path) !== VAULT_FILENAME,
          )
          .sort(),
      );
    } catch (error) {
      return Result.failure({
        kind: "unreadable",
        id: this.#path,
        cause: messageOf(error),
      });
    }
  }

  // -------------------------------------------------------------------------

  async #write(next: IndexDocument): Promise<Result<void, VaultError>> {
    try {
      await this.#fs.write(
        INDEX_FILENAME,
        `${JSON.stringify(next, null, 2)}\n`,
      );
    } catch (error) {
      return Result.failure({
        kind: "unreadable",
        id: INDEX_FILENAME,
        cause: messageOf(error),
      });
    }

    this.#document = next;
    return Result.success(undefined);
  }

  async #readQuietly(path: string): Promise<string | undefined> {
    try {
      return await this.#fs.read(path);
    } catch {
      return undefined;
    }
  }

  /** The store's own idea of when a record was written, where it has one. */
  async #modifiedAt(path: string): Promise<string | undefined> {
    if (this.#fs.stat === undefined) return undefined;

    try {
      return (await this.#fs.stat(path))?.modified.toISOString();
    } catch {
      return undefined;
    }
  }
}

function mergeTypes(existing: string[], type: unknown): string[] {
  const types = new Set(existing);
  if (typeof type === "string") types.add(type);
  return [...types].sort();
}

/**
 * Does any string anywhere in this metadata contain the needle?
 *
 * Recursive, because metadata is the caller's — nested objects and arrays are theirs to shape.
 * The type is matched this way too, since `type` is a metadata value like any other.
 */
function metadataContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(needle);
  if (Array.isArray(value))
    return value.some((item) => metadataContains(item, needle));

  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => metadataContains(item, needle));
  }

  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
