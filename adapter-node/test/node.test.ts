/**
 * The port contract, verified against a real filesystem.
 *
 * Half of these are contract tests — the behaviour every adapter must reproduce — and the
 * other half are specific to a *disk*: containment, and the fact that writing is direct and
 * leaves nothing beside its target.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IFileSystem } from "@hsfs/core";
import { NodeFileSystem } from "../src/index.js";

let root: string;
let fs: NodeFileSystem;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hsfs-node-"));
  fs = new NodeFileSystem({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("construction", () => {
  it("requires a root", () => {
    expect(() => new NodeFileSystem({ root: "" })).toThrow(TypeError);
    expect(() => new NodeFileSystem({ root: "   " })).toThrow(TypeError);
    expect(() => new NodeFileSystem({} as never)).toThrow(TypeError);
  });

  it("has no side effects", async () => {
    // Constructing against a directory that does not exist must not create it.
    const lazy = new NodeFileSystem({ root: join(root, "not-there-yet") });

    expect(await lazy.list("")).toEqual([]);
    await expect(lazy.read("anything.json")).resolves.toBeUndefined();
  });
});

describe("the port contract", () => {
  it("is a plain IFileSystem, and claims nothing more", () => {
    const port: IFileSystem = fs;

    expect(port).toBe(fs);
    expect("atomicWrite" in fs).toBe(false);
  });

  it("round-trips text", async () => {
    await fs.write("a/b.json", "hello");

    expect(await fs.read("a/b.json")).toBe("hello");
  });

  it("returns undefined for absence instead of throwing", async () => {
    expect(await fs.read("nope.json")).toBeUndefined();
    expect(await fs.read("deep/nested/nope.json")).toBeUndefined();
  });

  it("creates missing parents on write", async () => {
    await fs.write("x/y/z/file.txt", "content");

    expect(await fs.read("x/y/z/file.txt")).toBe("content");
  });

  it("means read-ability by exists", async () => {
    expect(await fs.exists("a/b.json")).toBe(false);
    await fs.write("a/b.json", "hello");
    expect(await fs.exists("a/b.json")).toBe(true);
    await fs.delete("a/b.json");
    expect(await fs.exists("a/b.json")).toBe(false);
  });

  it("treats a directory as absent, consistently", async () => {
    await fs.ensure("dir");

    // `read` and `exists` must agree about the same path.
    expect(await fs.read("dir")).toBeUndefined();
    expect(await fs.exists("dir")).toBe(false);
  });

  it("deletes idempotently", async () => {
    await fs.write("a/b.json", "x");
    await fs.delete("a/b.json");

    await expect(fs.delete("a/b.json")).resolves.toBeUndefined();
  });

  it("lists recursively, as portable paths", async () => {
    await fs.write("records/one.json", "1");
    await fs.write("records/two.json", "2");
    await fs.write("records/nested/three.json", "3");
    await fs.write("other/four.json", "4");

    expect(await fs.list("records")).toEqual([
      "records/nested/three.json",
      "records/one.json",
      "records/two.json",
    ]);
  });

  it("lists by filename prefix, not only by directory", async () => {
    await fs.write("1753427840015-ez9omy-identity.vault.json", "{}");
    await fs.write("1753427840016-abcd12-identity.vault.json", "{}");
    await fs.write("2000000000000-zzzzzz-credential.vault.json", "{}");

    expect(await fs.list("1753")).toHaveLength(2);
    expect(await fs.list("")).toHaveLength(3);
  });

  it("lists nothing when there is nothing", async () => {
    expect(await fs.list("")).toEqual([]);
    expect(await fs.list("nowhere")).toEqual([]);
  });

  it("ensures a namespace idempotently", async () => {
    await fs.ensure("empty/dir");

    await expect(fs.ensure("empty/dir")).resolves.toBeUndefined();
    expect(await fs.list("empty")).toEqual([]);
  });

  it("exposes the optional capabilities, and they work", async () => {
    await fs.write("a.json", "12345");

    const info = await fs.stat("a.json");
    expect(info?.size).toBe(5);

    await fs.chmod("a.json", 0o600);
    expect((await fs.stat("a.json"))?.mode).toBe(0o600);
  });

  it("returns undefined from stat for what is not there", async () => {
    expect(await fs.stat("nope.json")).toBeUndefined();
  });
});

describe("writing is direct", () => {
  it("leaves nothing beside the target", async () => {
    await fs.write("a.json", "x");
    await fs.write("a.json", "y");

    // A plain `writeFile` creates no temporaries. If this ever fails, somebody has added
    // durability work to a class named after a platform — and that is a decision to make
    // out loud, not to discover here.
    expect(await readdir(root)).toEqual(["a.json"]);
  });

  it("replaces the target with exactly the content it was given", async () => {
    await fs.write("a.json", "a".repeat(5000));
    await fs.write("a.json", "b".repeat(10));

    expect(await fs.read("a.json")).toBe("b".repeat(10));
    expect(await readFile(join(root, "a.json"), "utf8")).toBe("b".repeat(10));
  });
});

describe("containment", () => {
  it("refuses to leave the root", async () => {
    await expect(fs.write("../escape.json", "x")).rejects.toThrow(/escapes the root/);
    await expect(fs.read("../../etc/passwd")).rejects.toThrow(/escapes the root/);
    await expect(fs.delete("a/../../b.json")).rejects.toThrow(/escapes the root/);
  });

  it("refuses an empty path where one is required", async () => {
    await expect(fs.write("", "x")).rejects.toThrow(/a path is required/);
    await expect(fs.delete("")).rejects.toThrow(/a path is required/);
    await expect(fs.read("")).rejects.toThrow(/a path is required/);
  });

  it("takes a leading slash as relative to the root, not as an absolute path", async () => {
    await fs.write("/a.json", "x");

    expect(await fs.read("a.json")).toBe("x");
    expect(await fs.read("/etc/hosts")).toBeUndefined();
  });
});
