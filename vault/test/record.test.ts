/**
 * The value object, and the only thing it claims to do: **decide whether a string is a
 * record.**
 *
 * Every corruption reason gets a test here, because the difference between them is the
 * difference between "your write was torn" and "somebody edited this" — and whoever is
 * recovering a store needs to tell those apart.
 */

import { describe, expect, it } from "vitest";
import { stableStringify, VaultRecord } from "../src/index.js";

describe("VaultRecord.create", () => {
  it("computes a real checksum — SHA-256, hex", () => {
    const record = VaultRecord.create({ id: "a", data: { x: 1 } });

    expect(record.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", () => {
    const one = VaultRecord.create({ id: "a", data: { x: 1, y: 2 } });
    const other = VaultRecord.create({ id: "a", data: { y: 2, x: 1 } });

    expect(one.checksum).toBe(other.checksum);
  });

  it("changes when any part of the record changes", () => {
    const base = VaultRecord.create({ id: "a", data: { x: 1 }, metadata: { type: "t" } });

    const otherId = VaultRecord.create({ id: "b", data: { x: 1 }, metadata: { type: "t" } });
    const otherData = VaultRecord.create({ id: "a", data: { x: 2 }, metadata: { type: "t" } });
    const otherMeta = VaultRecord.create({ id: "a", data: { x: 1 }, metadata: { type: "u" } });
    const otherVersion = VaultRecord.create({
      id: "a",
      data: { x: 1 },
      metadata: { type: "t" },
      version: "9.9.9",
    });

    for (const other of [otherId, otherData, otherMeta, otherVersion]) {
      expect(other.checksum).not.toBe(base.checksum);
    }
  });

  it("refuses data it cannot serialise, rather than writing null", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => VaultRecord.create({ id: "a", data: circular })).toThrow(/circular/);
    expect(() => VaultRecord.create({ id: "a", data: { big: 1n } })).toThrow(/bigint/);
  });

  it("refuses a record with no data", () => {
    expect(() => VaultRecord.create({ id: "a", data: undefined })).toThrow(/needs data/);
  });
});

describe("VaultRecord.parse", () => {
  it("round-trips", () => {
    const record = VaultRecord.create({ id: "a", data: { x: 1 }, metadata: { type: "t" } });

    const parsed = VaultRecord.parse<{ x: number }>(record.toJSON());

    expect(parsed.isSuccess).toBe(true);
    expect(parsed.value.id).toBe("a");
    expect(parsed.value.data).toEqual({ x: 1 });
    expect(parsed.value.metadata).toEqual({ type: "t" });
    expect(parsed.value.checksum).toBe(record.checksum);
  });

  it("survives being reformatted by hand", () => {
    // Recovering a record by hand *is* a reformat. It must not invalidate the record.
    const record = VaultRecord.create({ id: "a", data: { x: 1, y: 2 } });
    const minified = JSON.stringify(JSON.parse(record.toJSON()));

    expect(VaultRecord.parse(minified).isSuccess).toBe(true);
  });

  it("reports `unparseable` when the bytes are not JSON", () => {
    const failure = VaultRecord.parse("{ half a record");

    expect(failure.isFailure).toBe(true);
    expect(failure.error?.reason).toBe("unparseable");
  });

  it("reports `unparseable` when the JSON is only unparseable *now*", () => {
    // The classic torn write: valid JSON, cut in the middle.
    const record = VaultRecord.create({ id: "a", data: { x: 1 } });
    const json = record.toJSON();
    const torn = `${json.slice(0, Math.floor(json.length / 2))}`;

    const failure = VaultRecord.parse(torn);

    expect(failure.isFailure).toBe(true);
    expect(failure.error?.reason).toBe("unparseable");
  });

  it("reports `shape` for JSON that is not a record", () => {
    for (const json of ["null", "[]", '"a string"', "{}", '{"id":"a"}', '{"id":"a","data":1}']) {
      const failure = VaultRecord.parse(json);

      expect(failure.isFailure).toBe(true);
      expect(failure.error?.reason).toBe("shape");
    }
  });

  it("reports `checksum` when the record was edited", () => {
    const record = VaultRecord.create({ id: "a", data: { x: 1 } });
    const tampered = JSON.parse(record.toJSON()) as { data: { x: number } };
    tampered.data.x = 2;

    const failure = VaultRecord.parse(JSON.stringify(tampered));

    expect(failure.error?.reason).toBe("checksum");
    expect(failure.error?.detail).toContain("expected");
  });

  it("covers the id and the metadata, not just the payload", () => {
    const record = VaultRecord.create({ id: "a", data: { x: 1 }, metadata: { type: "t" } });

    const idEdited = JSON.parse(record.toJSON()) as { id: string };
    idEdited.id = "b";
    expect(VaultRecord.parse(JSON.stringify(idEdited)).error?.reason).toBe("checksum");

    const metaEdited = JSON.parse(record.toJSON()) as { metadata: { type: string } };
    metaEdited.metadata.type = "u";
    expect(VaultRecord.parse(JSON.stringify(metaEdited)).error?.reason).toBe("checksum");
  });

  it("never throws, whatever it is handed", () => {
    for (const json of ["", " ", "undefined", "\u0000", "{}", "[]"]) {
      expect(() => VaultRecord.parse(json)).not.toThrow();
    }
  });
});

describe("stableStringify", () => {
  it("sorts keys, keeps array order, and drops undefined members", () => {
    expect(stableStringify({ b: 1, a: [3, 1, 2], c: undefined })).toBe('{"a":[3,1,2],"b":1}');
  });

  it("allows the same object twice, but not a cycle", () => {
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');

    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    expect(() => stableStringify(loop)).toThrow(/circular/);
  });
});
