/**
 * `@hsfs/core` has no behaviour to test, which is exactly why the tests here are about the
 * **type**. The product of this package is a contract, and two claims are worth defending:
 *
 * 1. it is a **leaf** — nothing exists at runtime, so an adapter can depend on it and ship
 *    with no dependency at all;
 * 2. it asks for the six required methods and *only* those — the optional two are genuinely
 *    optional, which is what keeps the port implementable by an object store.
 *
 * Half of these assertions are enforced by `tsc` rather than by vitest: `@ts-expect-error`
 * *fails the build* when the error it expects does not occur. So if the types ever loosen,
 * the typecheck breaks instead of the tests passing quietly.
 */

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import type { IFileSystem } from "../src/index.js";

/** The six required methods, and nothing else. */
function minimal(): IFileSystem {
  return {
    read: async () => undefined,
    write: async () => {},
    delete: async () => {},
    exists: async () => false,
    list: async () => [],
    ensure: async () => {},
  };
}

describe("core is a leaf", () => {
  it("has no runtime exports at all", () => {
    expect(Object.keys(core)).toEqual([]);
  });
});

describe("the port", () => {
  it("is satisfied by the six required methods", () => {
    const fs = minimal();

    expect(Object.keys(fs).sort()).toEqual([
      "delete",
      "ensure",
      "exists",
      "list",
      "read",
      "write",
    ]);
  });

  it("does not require the optional members", () => {
    const fs = minimal();

    expect(fs.stat).toBeUndefined();
    expect(fs.chmod).toBeUndefined();
  });

  it("rejects an object missing a required method", () => {
    // @ts-expect-error — `list` is required: five of six is not an IFileSystem
    const incomplete: IFileSystem = {
      read: async () => undefined,
      write: async () => {},
      delete: async () => {},
      exists: async () => false,
      ensure: async () => {},
    };

    expect(incomplete).toBeDefined();
  });

  it("rejects a `read` that cannot express absence", () => {
    const wrong: IFileSystem = {
      // @ts-expect-error — `read` yields text or nothing, never a number
      read: async () => 42,
      write: async () => {},
      delete: async () => {},
      exists: async () => false,
      list: async () => [],
      ensure: async () => {},
    };

    expect(wrong).toBeDefined();
  });
});
