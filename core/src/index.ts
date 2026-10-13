/**
 * `@hsfs/core` — the ports.
 *
 * **Types only: zero runtime, zero dependencies.** That is what lets an adapter depend on
 * this package as a leaf — a `devDependency`, an `import type`, erased at build — so a
 * published adapter carries no dependency on us at all.
 *
 * There is **one** port. Six methods, async only, and nothing a backend could not honour.
 * If a method cannot be honoured by an object store, it does not belong here.
 *
 * There is deliberately **no second tier**. Atomicity was tried and removed: a
 * `readonly atomicWrite: true` label is the wrong shape, and the real need — resilience — is
 * a sibling class that checks every method, not a flag beside one.
 *
 * Paths are POSIX-style (`/`-separated) and **relative to whatever root the adapter was
 * given**. Each backend translates: an S3 key, a GitHub path, a `Map` key.
 *
 * `README.md` has the reasoning. The doctrine that keeps this port small: *the port
 * describes what a store can be asked to do; it never describes how durable the caller's
 * data is.*
 */

/** What a store can tell you about an object — when it can tell you anything at all. */
export interface FileStats {
  /** Size in bytes. */
  size: number;
  /** When it was last modified. */
  modified: Date;
  /**
   * Permission bits, where the backend has any concept of them — `0o600` and friends.
   *
   * Absent for object stores and anything else without modes. This is why `chmod` below
   * is optional, and why permission is a per-store *property* rather than a promise the
   * port makes on every store's behalf.
   */
  mode?: number;
}

/**
 * The port. Six methods, async only, and nothing a backend could not honour.
 *
 * Implementing this is how an adapter joins the ecosystem. Implementing it *structurally*
 * is enough — nothing here requires importing this file at runtime, because nothing here
 * exists at runtime.
 */
export interface IFileSystem {
  /**
   * Read an object as UTF-8 text.
   *
   * **Returns `undefined` when there is nothing at the path.** Absence is a value, not an
   * exception, because it is the one failure every backend spells differently — `ENOENT`,
   * `NoSuchKey`, `404`, an empty `Map` slot. Turning it into `undefined` here is what
   * makes the port portable; every other failure still throws.
   */
  read(path: string): Promise<string | undefined>;

  /**
   * Write an object, replacing whatever was there.
   *
   * **Creates any missing parent namespace.** Object stores have no directories, so
   * demanding `ensure` first would be teaching the caller about the disk underneath.
   *
   * Nothing is promised here about *durability* — see `README.md`. A caller that needs
   * a write it can rely on gets that from the shape of its own writes, not from the port.
   */
  write(path: string, data: string): Promise<void>;

  /**
   * Remove an object.
   *
   * **Idempotent** — deleting what is not there succeeds. S3 is idempotent and POSIX is
   * not; the port takes the forgiving one, because a delete that throws on retry is a
   * delete that makes every caller write the same guard.
   */
  delete(path: string): Promise<void>;

  /**
   * Whether an object is there — precisely, whether `read(path)` would not return
   * `undefined`.
   *
   * Directories are implied and never queried: a store may have no such concept.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Every object under `prefix`, **recursively**, as paths you could pass straight back
   * to `read`.
   *
   * Recursive because "all keys under this prefix" is the native operation of an object
   * store; anything narrower would be a per-backend invention. `prefix` is a *path* prefix
   * and need not be a directory — `list("1753")` matches `1753427840015-ez9omy-….json`.
   */
  list(prefix: string): Promise<string[]>;

  /** Create an empty namespace. Idempotent, and a no-op where namespaces are implicit. */
  ensure(prefix: string): Promise<void>;

  /**
   * Metadata, where the backend has any. **Optional — detect it, never assume it.**
   *
   * ```ts
   * const info = fs.stat ? await fs.stat(path) : undefined;
   * ```
   */
  stat?(path: string): Promise<FileStats | undefined>;

  /**
   * Set permission bits, where the backend has them. **Optional — detect it.**
   *
   * Required of every adapter, this is the method that rots an ecosystem: S3 cannot chmod,
   * GitHub cannot chmod, and both would be forced to stub or throw. Here they simply do
   * not have it.
   */
  chmod?(path: string, mode: number): Promise<void>;
}
