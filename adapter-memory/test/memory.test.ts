/**
 * The port contract against the in-memory adapter — and, at the end, the test that matters
 * most: **parity with `adapter-node`**.
 *
 * A port with two implementations is only a port if they answer the same questions the same
 * way. That scenario is run against both, and the results are compared. It is the mechanism
 * that would catch divergence early, which is the whole reason it is here rather than a
 * duplicated set of assertions.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@hsfs/adapter-node";
import type { IFileSystem } from "@hsfs/core";
import { MemoryFileSystem } from "../src/index.js";

let root: string;
let fs: MemoryFileSystem;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hsfs-memory-"));
  fs = new MemoryFileSystem();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the port contract", () => {
  it("is a plain IFileSystem", () => {
    const port: IFileSystem = fs;

    expect(port).toBe(fs);
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

    expect((await fs.stat("a.json"))?.size).toBe(5);

    await fs.chmod("a.json", 0o600);
    expect((await fs.stat("a.json"))?.mode).toBe(0o600);
  });

  it("returns undefined from stat for what is not there", async () => {
    expect(await fs.stat("nope.json")).toBeUndefined();
  });

  it("refuses an empty path where one is required", async () => {
    await expect(fs.write("", "x")).rejects.toThrow(/a path is required/);
    await expect(fs.delete("")).rejects.toThrow(/a path is required/);
    await expect(fs.read("")).rejects.toThrow(/a path is required/);
  });

  it("refuses data that is not text", async () => {
    await expect(fs.write("a.json", undefined as never)).rejects.toThrow(TypeError);
  });

  it("refuses to chmod what is not there", async () => {
    await expect(fs.chmod("nope.json", 0o600)).rejects.toThrow(/no such object/);
  });
});

describe("the documented divergence", () => {
  it("treats a path as an opaque key — there is no root to escape", async () => {
    // `adapter-node` refuses `..` because it has a real root. A Map has none, so this is
    // deliberately *not* an error here. Documented rather than faked.
    await fs.write("../up.json", "x");

    expect(await fs.read("../up.json")).toBe("x");
  });
});

describe("parity with adapter-node", () => {
  it("answers a scripted scenario identically", async () => {
    const memory = new MemoryFileSystem();
    const disk = new NodeFileSystem({ root });

    expect(await scenario(memory)).toEqual(await scenario(disk));
  });
});

/** The scenario: every port method, in an order that exercises the rules. */
async function scenario(fs: IFileSystem): Promise<unknown[]> {
  const answers: unknown[] = [];

  answers.push(await fs.read("a.json"));
  await fs.write("a.json", "1");
  await fs.write("nested/b.json", "2");

  answers.push(await fs.exists("a.json"));
  answers.push(await fs.exists("missing.json"));
  answers.push(await fs.list(""));
  answers.push(await fs.list("nested"));
  answers.push(await fs.list("a"));

  await fs.delete("a.json");
  await fs.delete("a.json");

  answers.push(await fs.list(""));
  answers.push(await fs.read("nested/b.json"));

  await fs.ensure("empty");
  answers.push(await fs.list("empty"));

  answers.push(fs.stat ? (await fs.stat("nested/b.json"))?.size : "no stat");

  return answers;
}
