/**
 * `@hsfs/adapter-memory` — a `Map`.
 *
 * Two jobs: the test double that lets a store be exercised without touching a disk, and a
 * genuine scratch store for work that should not outlive the process.
 *
 * Containment is the one place this adapter deliberately differs. `adapter-node` refuses
 * paths containing `..` because it has a real root to escape from; a `Map` has none, so a
 * path here is an opaque key. Documented rather than faked.
 */

import type { FileStats, IFileSystem } from "@hsfs/core";

export class MemoryFileSystem implements IFileSystem {
  readonly #objects = new Map<string, string>();
  readonly #modes = new Map<string, number>();
  readonly #modified = new Map<string, Date>();

  async read(path: string): Promise<string | undefined> {
    return this.#objects.get(key(path));
  }

  async write(path: string, data: string): Promise<void> {
    if (typeof data !== "string") {
      throw new TypeError("data must be a string");
    }

    const name = key(path);

    // One assignment. There is no window in which the key exists but the value does not.
    this.#objects.set(name, data);
    this.#modified.set(name, new Date());
  }

  async delete(path: string): Promise<void> {
    const name = key(path);

    this.#objects.delete(name);
    this.#modes.delete(name);
    this.#modified.delete(name);
  }

  async exists(path: string): Promise<boolean> {
    return this.#objects.has(key(path));
  }

  async list(prefix: string): Promise<string[]> {
    const clean = normalise(prefix);

    return [...this.#objects.keys()]
      .filter((name) => name.startsWith(clean))
      .sort();
  }

  async ensure(_prefix: string): Promise<void> {
    // Namespaces are implicit here — `list` filters by prefix, so there is nothing to
    // create and nothing to fail. Present for contract parity.
  }

  async stat(path: string): Promise<FileStats | undefined> {
    const name = key(path);
    const value = this.#objects.get(name);
    if (value === undefined) return undefined;

    const mode = this.#modes.get(name);

    return {
      size: Buffer.byteLength(value, "utf8"),
      modified: this.#modified.get(name) ?? new Date(0),
      ...(mode === undefined ? {} : { mode }),
    };
  }

  async chmod(path: string, mode: number): Promise<void> {
    const name = key(path);

    if (!this.#objects.has(name)) {
      throw new Error(`no such object: ${JSON.stringify(path)}`);
    }

    this.#modes.set(name, mode);
  }

  /** How many objects are held. Not part of the port — a convenience for assertions. */
  get size(): number {
    return this.#objects.size;
  }
}

/** A path as a key: POSIX separators, no leading or trailing slash. */
function normalise(path: string): string {
  if (typeof path !== "string") {
    throw new TypeError("a path is required");
  }

  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** As above, but refuses the empty path where an object must be named. */
function key(path: string): string {
  const clean = normalise(path);

  if (clean === "") {
    throw new Error("a path is required");
  }

  return clean;
}
