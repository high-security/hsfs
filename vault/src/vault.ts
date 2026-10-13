/**
 * `Vault<T>` — records, indexed, over any `IFileSystem`.
 *
 * The names are the previous implementation's on purpose — `save`, `get`, `find`, `list`,
 * `delete`, `exists`, `stats` — so this is a rework rather than a different product.
 *
 * Three pieces, three jobs, and the vault does none of them itself:
 *
 * | | |
 * |---|---|
 * | `VaultRecord` | the **format** — what a record is, and whether a string is one |
 * | `Indexer` | **resolution and search** — `id → filename`, metadata, rebuild |
 * | `IFileSystem` | **bytes** |
 *
 * The vault owns the *order* those happen in, which is the only thing that is really its own:
 * the record is written **before** the index is updated, so a failed index write can never
 * cost a record, and the index can always be rebuilt from what is on disk.
 *
 * It also owns the one question none of those three can answer: **what is actually in the
 * store.** `list`, `find` and `get` answer from the index; `verify` reads the files.
 */

import type { IFileSystem } from "@hsfs/core";
import type { CorruptReason, VaultError } from "./errors.js";
import type { DamagedRecord } from "./index-document.js";
import { Indexer } from "./indexer.js";
import {
  VAULT_FILENAME,
  createVaultMetadata,
  parseVaultMetadata,
  type VaultEncoding,
  type VaultFormat,
  type VaultMetadata,
} from "./metadata.js";
import { RECORD_SUFFIX, VaultRecord, salvageRecord } from "./record.js";
import { Result } from "./result.js";

export interface VaultOptions {
  /** The store. The vault asks it for the six port methods and nothing else. */
  fs: IFileSystem;
  name?: string;
  encryption?: boolean;
  compression?: boolean;
  encoding?: VaultEncoding;
  format?: VaultFormat;
}

/**
 * An entry as `list` reports it — from the index, without opening a single record.
 *
 * A record that did not verify still appears, with `damage` set. It is present, and being
 * present and broken is not the same as being gone. Only records the index could *name* can be
 * listed — a torn write leaves no id behind — which is part of why `verify` exists.
 */
export interface ListEntry {
  id: string;
  metadata: Record<string, unknown>;
  /** Present when the record is known and broken. Absent when it verifies. */
  damage?: { reason: CorruptReason; detail: string };
}

export interface VaultStats {
  name: string;
  totalRecords: number;
  /** Records the index knows are broken. **Not** part of `totalRecords` — they are not usable. */
  damaged: number;
  created: string;
  metadata: VaultMetadata;
}

/**
 * What `open` had to do.
 *
 * A rebuild is routine — the index is a hint, after all. But routine is not the same as
 * silent. A store that quietly rebuilt itself is a store that quietly changed what it knows,
 * and the caller is entitled to be told which happened and why.
 */
export interface VaultOpening {
  source: "loaded" | "rebuilt";
  /** Why the index had to be rebuilt. Absent when it did not. */
  reason?: string;
  /** Whether this call created the store. */
  created: boolean;
  /** Records already known to be broken at the moment it opened. */
  damaged: number;
}

/** One file in the store, judged on its own — by `verify`, which reads files and not the index. */
export interface VerifiedRecord {
  /** The file. Always known: `verify` finds records by name, not by id. */
  filename: string;
  /** The id the file claims, when it was readable enough to say. */
  id?: string;
  state: "intact" | "damaged";
  /** Why, when it is not intact. */
  damage?: { reason: CorruptReason; detail: string };
}

/** Where the index and the store disagree. Each one is a wrong answer waiting to be given. */
export type IndexDisagreement =
  /** The index points at a file that is not there. A stale hint, not damage. */
  | { kind: "dangling"; id: string; filename: string }
  /** The index holds this file under a different id than the one inside it. */
  | { kind: "misindexed"; filename: string; indexed: string; stored: string }
  /** A record file the index has never heard of — the index is behind the store. */
  | { kind: "unknown"; filename: string }
  /** Two files claim the same id, so whichever the index did not pick is unreachable. */
  | { kind: "duplicate"; id: string; filenames: string[] };

/** What `verify` found. */
export interface VaultReport {
  name: string;
  verifiedAt: string;
  /** Every record file in the store, each judged on its own. */
  records: VerifiedRecord[];
  totals: { files: number; intact: number; damaged: number };
  /** Where the index disagrees with what is on disk. */
  index: IndexDisagreement[];
  /**
   * Every record verifies **and** the index matches the store.
   *
   * `false` with nothing damaged means the records are fine and the **index** needs a
   * `rebuild()` — a cheap fix, and worth telling apart from a broken record.
   */
  healthy: boolean;
}

export class Vault<T = unknown> {
  readonly #fs: IFileSystem;
  readonly #indexer: Indexer;
  readonly #opening: VaultOpening;
  #metadata: VaultMetadata;

  private constructor(
    fs: IFileSystem,
    indexer: Indexer,
    metadata: VaultMetadata,
    opening: VaultOpening,
  ) {
    this.#fs = fs;
    this.#indexer = indexer;
    this.#metadata = metadata;
    this.#opening = opening;
  }

  /**
   * Open a store, creating it if it is not there.
   *
   * Reads `.vault.json` first, because the descriptor is what says **how** the records are
   * encoded and encrypted. That is the whole reason it exists: a reader has to learn how to
   * read the records before it reads one.
   *
   * This replaces the old `create()` + `init()` pair. Without a Unit there is no lifecycle to
   * split in two, and a vault that can exist in an unusable state is a trap — one `open`, one
   * result.
   */
  static async open<T = unknown>(
    options: VaultOptions,
  ): Promise<Result<Vault<T>, VaultError>> {
    if (options?.fs === undefined) {
      return Result.failure({
        kind: "invalid",
        id: "",
        detail: "a filesystem is required",
      });
    }

    const fs = options.fs;

    const descriptor = await readDescriptor(fs);
    if (descriptor.isFailure) return Result.failure(descriptor.error);

    // Captured before the descriptor is created, because that is the moment the store stops
    // being new — and a caller that has just made a store usually wants to know.
    const created = descriptor.value === undefined;
    let metadata = descriptor.value;

    if (metadata === undefined) {
      metadata = createVaultMetadata({
        name: options.name,
        encryption: options.encryption,
        compression: options.compression,
        encoding: options.encoding,
        format: options.format,
      });
    } else {
      // Touched on open rather than on every write. The descriptor is the second most
      // mutable file here, and the fewer times it is rewritten the fewer chances it has to
      // tear — the same reasoning that keeps the index out of every read path.
      metadata = { ...metadata, lastAccessed: new Date().toISOString() };
    }

    const written = await writeDescriptor(fs, metadata);
    if (written.isFailure) return Result.failure(written.error);

    const indexer = new Indexer({ fs });
    const opened = await indexer.open();
    if (opened.isFailure) return Result.failure(opened.error);

    return Result.success(
      new Vault<T>(fs, indexer, metadata, {
        source: opened.value.source,
        ...(opened.value.reason === undefined
          ? {}
          : { reason: opened.value.reason }),
        created,
        damaged: indexer.damaged.length,
      }),
    );
  }

  /**
   * What opening this store had to do — whether the index was read or **rebuilt**, why, and how
   * much was already broken. A rebuild is normal; a silent one is how a store quietly becomes a
   * different store.
   */
  get opening(): VaultOpening {
    return { ...this.#opening };
  }

  /** The store's descriptor. */
  get metadata(): VaultMetadata {
    return { ...this.#metadata };
  }

  get name(): string {
    return this.#metadata.name;
  }

  /** The distinct record types the index knows. */
  get searchIndexes(): string[] {
    return this.#indexer.searchIndexes;
  }

  /**
   * Store a record under an id, replacing any previous record for it.
   *
   * The record gets a **new filename** every time — `<epoch>-<random>-<type>.vault.json` — so
   * an id is never welded to a path. Once the index has been updated the previous file is
   * removed, so saving the same id a hundred times leaves one record rather than a hundred
   * orphans, and a rebuild finds exactly one record per id.
   */
  async save(
    id: string,
    data: T,
    metadata: Record<string, unknown> = {},
  ): Promise<Result<void, VaultError>> {
    if (typeof id !== "string" || id.trim() === "") {
      return Result.failure({
        kind: "invalid",
        id: String(id),
        detail: "an id is required",
      });
    }

    let record: VaultRecord<T>;

    try {
      record = VaultRecord.create<T>({ id, data, metadata });
    } catch (error) {
      return Result.failure({ kind: "invalid", id, detail: messageOf(error) });
    }

    const previous = this.#indexer.entry(id)?.filename;
    const filename = generateFilename(metadata);
    const now = new Date().toISOString();

    // The record first: the index is a hint, and a hint is never allowed to cost a record.
    try {
      await this.#fs.write(filename, record.toJSON());
    } catch (error) {
      return Result.failure({
        kind: "unreadable",
        id,
        cause: messageOf(error),
      });
    }

    const added = await this.#indexer.add({
      id,
      filename,
      // The caller's metadata — not a copy with our bookkeeping mixed in. `find` searches this,
      // so folding `created`/`updated` in here would make a keyword match the store before a
      // rebuild and stop matching after one: one query, two answers, depending on when it ran.
      metadata,
      created: now,
      updated: now,
    });

    if (added.isFailure) return Result.failure(added.error);

    if (previous !== undefined && previous !== filename) {
      // Best effort. Failing to tidy up costs disk, never correctness — the index already
      // points at the new file.
      try {
        await this.#fs.delete(previous);
      } catch {
        // Intentionally ignored.
      }
    }

    return Result.success(undefined);
  }

  /**
   * The record's data. `absent` is the old `null`.
   *
   * The type is the vault's own `T` by default; `get<Other>(id)` overrides it when the
   * caller knows more about one record than the vault does.
   */
  async get<U = T>(id: string): Promise<Result<U, VaultError>> {
    const filename = this.#indexer.resolve(id);

    if (filename === undefined) {
      // A record the index knows is broken is `corrupt`, never `absent`. "I never stored this"
      // and "I stored this and it rotted" call for opposite responses — one is routine, the
      // other is an incident — and a store that cannot tell them apart is lying at exactly the
      // moment somebody needs the truth.
      const [damage] = this.#indexer.damagedFor(id);

      if (damage !== undefined) {
        return Result.failure({
          kind: "corrupt",
          id,
          reason: damage.reason,
          detail: damage.detail,
        });
      }

      return Result.failure({ kind: "absent", id });
    }

    return this.#read<U>(id, filename);
  }

  /**
   * Records matching a keyword.
   *
   * The **index** answers the question — by type, by any metadata value, or by id — so this
   * opens only the files that matched, instead of every file, to find out which ones should
   * have. That is the whole reason the index exists.
   */
  async find<U = T>(keyword: string): Promise<Result<U[], VaultError>> {
    const results: U[] = [];

    for (const entry of this.#indexer.find(keyword)) {
      const data = await this.#read<U>(entry.id, entry.filename);

      // A record that has rotted is skipped rather than fatal: one broken file must not hide
      // the rest, and `get`/`verify` are how you find out about it.
      if (data.isSuccess) results.push(data.value);
    }

    return Result.success(results);
  }

  /**
   * Everything the index knows — ids and metadata, **without opening a record**.
   *
   * Records that failed to verify are included and **marked**, not omitted: a record that is
   * there and broken is still there. Ones the index could not name — a torn write leaves no id
   * behind — cannot appear here at all, and that is the case `verify` exists for.
   */
  async list(): Promise<Result<ListEntry[], VaultError>> {
    const intact: ListEntry[] = this.#indexer
      .query()
      .map((entry) => ({ id: entry.id, metadata: entry.metadata }));

    const broken: ListEntry[] = this.#indexer.damaged
      .filter(
        (entry): entry is DamagedRecord & { id: string } =>
          entry.id !== undefined,
      )
      .map((entry) => ({
        id: entry.id,
        metadata: entry.metadata ?? {},
        damage: { reason: entry.reason, detail: entry.detail },
      }));

    return Result.success([...intact, ...broken]);
  }

  /**
   * Remove a record. `false` when the id was unknown — the old `boolean` contract.
   *
   * **Every** file holding this id goes, including ones that failed to verify. Deleting only the
   * record the index points at would leave a torn copy of the caller's data on disk, and this is
   * a store for identities: a delete that does not delete is worse than one that fails.
   */
  async delete(id: string): Promise<Result<boolean, VaultError>> {
    const known = this.#indexer.entry(id);
    const damaged = this.#indexer.damagedFor(id);

    if (known === undefined && damaged.length === 0) {
      return Result.success(false);
    }

    const files = [
      ...(known === undefined ? [] : [known.filename]),
      ...damaged.map((entry) => entry.filename),
    ];

    for (const file of files) {
      try {
        await this.#fs.delete(file);
      } catch (error) {
        return Result.failure({
          kind: "unreadable",
          id,
          cause: messageOf(error),
        });
      }
    }

    // The index goes last. An entry pointing at a missing file reads as `absent`, which is
    // recoverable; a deleted file with a live entry would read as `corrupt`.
    const removed = await this.#indexer.remove(id);
    if (removed.isFailure) return Result.failure(removed.error);

    return Result.success(removed.value);
  }

  /**
   * Whether the store holds anything under this id — **presence, not usability.** A record that
   * is there and broken answers `true`, because it is there; `get` is what tells you it is
   * broken.
   */
  async exists(id: string): Promise<Result<boolean, VaultError>> {
    return Result.success(
      this.#indexer.resolve(id) !== undefined ||
        this.#indexer.damagedFor(id).length > 0,
    );
  }

  /** The store, as the index sees it. */
  async stats(): Promise<Result<VaultStats, VaultError>> {
    return Result.success({
      name: this.#metadata.name,
      totalRecords: this.#indexer.query().length,
      damaged: this.#indexer.damaged.length,
      created: this.#metadata.created,
      metadata: this.metadata,
    });
  }

  /**
   * Rebuild the index from the records — the answer to a corrupted index, and the repair for
   * anything `verify` reported about the index rather than about a record. Whatever it cannot
   * read it now **records** rather than drops, so a rebuild can never shrink what the store
   * admits to holding.
   */
  async rebuild(): Promise<Result<void, VaultError>> {
    const rebuilt = await this.#indexer.rebuild();

    return rebuilt.isSuccess
      ? Result.success(undefined)
      : Result.failure(rebuilt.error);
  }

  /**
   * Read the **store**, and report what is actually in it.
   *
   * `list`, `find` and `get` answer from the index — that is what an index is for, and why they
   * are cheap. This one answers from the **files**, and it is the only thing that can: the index
   * is by construction unable to report a file it could not name, and a torn write leaves nothing
   * to name it with. So `get` on a record that was never indexed has no choice but to say
   * `absent`; this reports it, by filename, with the reason.
   *
   * It reports three things, and they need different responses:
   *
   * - **damaged records** — the file is there and does not read. Only a human, a backup or the
   *   layer above can do anything about that.
   * - **index disagreements** — the records are fine and the *index* is wrong. `rebuild()` fixes
   *   these, and they are listed apart from the damage so that "my index drifted" is never
   *   mistaken for "my data is gone".
   * - nothing, in which case `healthy` is true.
   *
   * It changes nothing. Repair is `rebuild`'s job; this is what you consult to decide whether to
   * ask for it.
   */
  async verify(): Promise<Result<VaultReport, VaultError>> {
    const paths = await this.#indexer.recordFiles();
    if (paths.isFailure) return Result.failure(paths.error);

    const records: VerifiedRecord[] = [];
    const index: IndexDisagreement[] = [];
    const indexed = new Map(
      this.#indexer.query().map((entry) => [entry.filename, entry.id]),
    );
    const byFilename = new Map<string, VerifiedRecord>();
    const byId = new Map<string, string[]>();

    for (const filename of paths.value) {
      const record = await this.#verifyOne(filename);

      records.push(record);
      byFilename.set(filename, record);

      if (record.id !== undefined) {
        byId.set(record.id, [...(byId.get(record.id) ?? []), filename]);
      }

      const known = indexed.get(filename);

      if (known === undefined) {
        index.push({ kind: "unknown", filename });
      } else if (record.id !== undefined && record.id !== known) {
        index.push({
          kind: "misindexed",
          filename,
          indexed: known,
          stored: record.id,
        });
      }
    }

    // The other direction: what the index believes, that the store does not have.
    for (const entry of this.#indexer.query()) {
      if (!byFilename.has(entry.filename)) {
        index.push({
          kind: "dangling",
          id: entry.id,
          filename: entry.filename,
        });
      }
    }

    // Two files, one id: whichever one the index picked, the other is unreachable. Called an
    // ambiguity rather than damage, because both files read perfectly well.
    for (const [id, filenames] of byId) {
      if (filenames.length > 1)
        index.push({ kind: "duplicate", id, filenames });
    }

    const broken = records.filter(
      (record) => record.state === "damaged",
    ).length;

    return Result.success({
      name: this.#metadata.name,
      verifiedAt: new Date().toISOString(),
      records,
      totals: {
        files: records.length,
        intact: records.length - broken,
        damaged: broken,
      },
      index,
      healthy: broken === 0 && index.length === 0,
    });
  }

  // -------------------------------------------------------------------------

  /** One file, judged on its own — no index, and no id from the caller. */
  async #verifyOne(filename: string): Promise<VerifiedRecord> {
    let json: string | undefined;

    try {
      json = await this.#fs.read(filename);
    } catch (error) {
      return unreadable(filename, messageOf(error));
    }

    if (json === undefined) {
      return unreadable(filename, "the store returned nothing");
    }

    const parsed = VaultRecord.parse<unknown>(json);

    if (parsed.isFailure) {
      const salvage = salvageRecord(json);

      return {
        filename,
        ...(salvage.id === undefined ? {} : { id: salvage.id }),
        state: "damaged",
        damage: { reason: parsed.error.reason, detail: parsed.error.detail },
      };
    }

    return { filename, id: parsed.value.id, state: "intact" };
  }

  async #read<U>(id: string, filename: string): Promise<Result<U, VaultError>> {
    let json: string | undefined;

    try {
      json = await this.#fs.read(filename);
    } catch (error) {
      return Result.failure({
        kind: "unreadable",
        id,
        cause: messageOf(error),
      });
    }

    if (json === undefined) {
      // The index pointed at something that is not there. `absent`, not `corrupt`: nothing is
      // broken, the hint is simply stale.
      return Result.failure({ kind: "absent", id });
    }

    const parsed = VaultRecord.parse<U>(json);

    if (parsed.isFailure) {
      return Result.failure({
        kind: "corrupt",
        id,
        reason: parsed.error.reason,
        detail: parsed.error.detail,
      });
    }

    if (parsed.value.id !== id) {
      return Result.failure({
        kind: "corrupt",
        id,
        reason: "identity",
        detail: `the file holds ${JSON.stringify(parsed.value.id)}`,
      });
    }

    return Result.success(parsed.value.data);
  }
}

/** A file the store could not hand over. The store failed here, not the record. */
function unreadable(filename: string, detail: string): VerifiedRecord {
  return {
    filename,
    state: "damaged",
    damage: { reason: "unreadable", detail },
  };
}

/** The descriptor, or `undefined` when the store does not exist yet. */
async function readDescriptor(
  fs: IFileSystem,
): Promise<Result<VaultMetadata | undefined, VaultError>> {
  let json: string | undefined;

  try {
    json = await fs.read(VAULT_FILENAME);
  } catch (error) {
    return Result.failure({
      kind: "unreadable",
      id: VAULT_FILENAME,
      cause: messageOf(error),
    });
  }

  if (json === undefined) {
    return Result.success(undefined);
  }

  const parsed = parseVaultMetadata(json);

  if (parsed.isFailure) {
    return Result.failure({
      kind: "corrupt",
      id: VAULT_FILENAME,
      reason: parsed.error.reason,
      detail: parsed.error.detail,
    });
  }

  return Result.success(parsed.value);
}

async function writeDescriptor(
  fs: IFileSystem,
  metadata: VaultMetadata,
): Promise<Result<void, VaultError>> {
  try {
    await fs.write(VAULT_FILENAME, `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error) {
    return Result.failure({
      kind: "unreadable",
      id: VAULT_FILENAME,
      cause: messageOf(error),
    });
  }

  return Result.success(undefined);
}

/** `<epoch>-<random>[-<type>].vault.json` — opaque and unique, the type carried for the eye. */
function generateFilename(metadata: Record<string, unknown>): string {
  const type = metadata.type;
  const suffix =
    typeof type === "string" && type !== "" ? `-${slug(type)}` : "";

  return `${Date.now()}-${randomSuffix()}${suffix}${RECORD_SUFFIX}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return cleaned === "" ? "record" : cleaned;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
