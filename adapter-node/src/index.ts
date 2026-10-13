/**
 * `@hsfs/adapter-node` — POSIX, in the ordinary way.
 *
 * Every path is resolved inside the root the adapter was given, and paths that try to
 * leave it are refused rather than normalised. That guard is not a nicety: the root is
 * usually a vault or a key directory, and `../` in a record id would otherwise be a
 * perfectly good way to write outside it.
 *
 * `write` is `mkdir` plus `writeFile`, and that is the whole of it. The platform's
 * `writeFile` truncates and then writes, so a crash mid-write can leave a torn file —
 * **which is not this class's problem to solve.** Durability belongs to whoever owns the
 * data, and a store that needs more than this says so by *being* a different, more expensive
 * store — not by quietly adding an `fsync` to a class named after a platform.
 */

import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod as chmodFile,
  stat as statFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { FileStats, IFileSystem } from "@hsfs/core";

export interface NodeFileSystemOptions {
  /**
   * Every path is resolved inside this directory.
   *
   * Created lazily — the constructor has no side effects, and the first `write` or
   * `ensure` brings the tree into being.
   */
  root: string;
}

export class NodeFileSystem implements IFileSystem {
  /** The absolute root every path is resolved against. */
  readonly root: string;

  constructor(options: NodeFileSystemOptions) {
    if (typeof options?.root !== "string" || options.root.trim() === "") {
      throw new TypeError("a root directory is required");
    }
    this.root = resolve(options.root);
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.resolve(path), "utf8");
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  }

  async write(path: string, data: string): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, "utf8");
  }

  async delete(path: string): Promise<void> {
    // `force` gives idempotence, `recursive` lets a namespace be removed too.
    await rm(this.resolve(path), { force: true, recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await statFile(this.resolve(path))).isFile();
    } catch (error) {
      if (isAbsent(error)) return false;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const target = this.resolve(prefix, true);
    const portablePrefix = this.toPortable(target);

    const base = await this.deepestDirectory(target);
    if (base === undefined) return [];

    const found: string[] = [];
    await collectFiles(base, found);

    return found
      .map((absolute) => this.toPortable(absolute))
      .filter((path) => path.startsWith(portablePrefix))
      .sort();
  }

  async ensure(prefix: string): Promise<void> {
    await mkdir(this.resolve(prefix, true), { recursive: true });
  }

  async stat(path: string): Promise<FileStats | undefined> {
    try {
      const info = await statFile(this.resolve(path));
      return { size: info.size, modified: info.mtime, mode: info.mode & 0o777 };
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmodFile(this.resolve(path), mode);
  }

  // -------------------------------------------------------------------------

  /**
   * Absolute path for a portable one, refusing anything that would leave the root.
   *
   * `allowRoot` is for the two methods where the root itself is a legitimate argument:
   * `list("")` means everything, and `ensure("")` means the root. For `read`, `write` and
   * `delete` an empty path is a mistake, and `delete("")` must never mean "erase the
   * vault".
   */
  private resolve(path: string, allowRoot = false): string {
    if (typeof path !== "string") {
      throw new TypeError("a path is required");
    }

    const clean = path
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    if (clean === "") {
      if (allowRoot) return this.root;
      throw new Error("a path is required");
    }

    if (clean.split("/").includes("..")) {
      throw new Error(`path escapes the root: ${JSON.stringify(path)}`);
    }

    const absolute = resolve(this.root, clean);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new Error(`path escapes the root: ${JSON.stringify(path)}`);
    }

    return absolute;
  }

  /** A portable path: POSIX separators, relative to the root. */
  private toPortable(absolute: string): string {
    const relativePath = relative(this.root, absolute).split(sep).join("/");
    return relativePath === "." ? "" : relativePath;
  }

  /**
   * The deepest existing directory at or above `target`.
   *
   * A `prefix` is a *string* prefix, so it may end mid-name (`1753`) or mid-path. Walking
   * up to the nearest real directory is what makes `list` behave like an object store's
   * listing rather than like a `readdir`.
   */
  private async deepestDirectory(target: string): Promise<string | undefined> {
    let candidate = target;

    while (true) {
      if (await isDirectory(candidate)) return candidate;
      if (candidate === this.root) return undefined;

      const parent = dirname(candidate);
      if (parent === candidate) return undefined;

      candidate = parent;
    }
  }
}

async function collectFiles(directory: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(path, found);
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await statFile(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the error means "there is nothing there", as opposed to a real failure.
 *
 * Three cases, all of them absence: `ENOENT` (no such file), `EISDIR` (it is a directory,
 * so it is not a readable object), and `ENOTDIR` (a path component is a file). All three
 * must become `undefined`, or `read` would disagree with `exists` about the same path.
 */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}
