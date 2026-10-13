/**
 * The vault, against a real filesystem and against a `Map`.
 *
 * Two tests here are the reason the package exists, and they are both about the **index**:
 *
 * - a corrupted index is rebuilt, and the store answers correctly afterwards
 * - `list` reads **no records at all** — which is the only way to prove an index is doing
 *   anything, and the thing the previous filestorage could not do
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "@hsfs/adapter-memory";
import { NodeFileSystem } from "@hsfs/adapter-node";
import type { IFileSystem } from "@hsfs/core";
import { VAULT_FILENAME, Vault, VaultRecord } from "../src/index.js";

let root: string;
let disk: NodeFileSystem;
let memory: MemoryFileSystem;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hsfs-vault-"));
  disk = new NodeFileSystem({ root });
  memory = new MemoryFileSystem();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Open, or fail loudly — a test that cannot open has nothing to say. */
async function open<T>(fs: IFileSystem, name?: string): Promise<Vault<T>> {
  const opened = await Vault.open<T>({ fs, ...(name === undefined ? {} : { name }) });

  if (opened.isFailure) {
    throw new Error(`could not open: ${opened.error.kind}`);
  }

  return opened.value;
}

/** Record files only — the descriptor is a file too, and must not be counted. */
async function recordFiles(): Promise<string[]> {
  return (await readdir(root)).filter(
    (name) => name.endsWith(".vault.json") && name !== VAULT_FILENAME,
  );
}

/**
 * Break a record's checksum **without** breaking its shape — so its id and metadata survive.
 *
 * This is the interesting corruption: `unparseable` tells you nothing about which record was
 * lost, while a checksum failure leaves you with a name for it.
 */
async function tamper(filename: string): Promise<void> {
  const path = join(root, filename);
  const record = JSON.parse(await readFile(path, "utf8")) as { data: { n: number } };

  record.data.n = 999;

  await writeFile(path, JSON.stringify(record), "utf8");
}

/** Write a record file by hand — how a store acquires one the index has never seen. */
async function plant(filename: string, id: string, n: number): Promise<void> {
  const record = VaultRecord.create({ id, data: { n }, metadata: { type: "identity" } });

  await writeFile(join(root, filename), record.toJSON(), "utf8");
}

describe("opening", () => {
  it("creates a store, and describes it", async () => {
    const vault = await open<{ n: number }>(disk, "identities");

    expect(vault.name).toBe("identities");
    expect(vault.metadata.encryption).toBe(false);
    expect(vault.metadata.format).toBe("json");
    expect(await recordFiles()).toEqual([]);
  });

  it("loads an existing store and keeps its identity", async () => {
    await open<{ n: number }>(disk, "identities");

    const reopened = await open<{ n: number }>(disk, "something else");

    // The descriptor wins: a store knows its own name, not the one it was called by.
    expect(reopened.name).toBe("identities");
  });

  it("reports a corrupt descriptor rather than inventing one", async () => {
    await open<{ n: number }>(disk);
    await writeFile(join(root, VAULT_FILENAME), "{}", "utf8");

    const reopened = await Vault.open({ fs: disk });

    expect(reopened.isFailure).toBe(true);
    expect(reopened.error).toMatchObject({ kind: "corrupt", reason: "shape" });
  });

  it("refuses to open without a store", async () => {
    const opened = await Vault.open({} as never);

    expect(opened.error).toMatchObject({ kind: "invalid" });
  });
});

describe("save and get", () => {
  it("round-trips through an id, with metadata alongside", async () => {
    const vault = await open<{ did: string }>(memory);

    await vault.save("alice", { did: "did:key:z6Mk" }, { type: "identity" });

    const found = await vault.get<{ did: string }>("alice");

    expect(found.value).toEqual({ did: "did:key:z6Mk" });
  });

  it("says `absent` for an id it has never seen", async () => {
    const vault = await open<{ n: number }>(memory);

    expect((await vault.get("nobody")).error).toMatchObject({ kind: "absent" });
  });

  it("replaces a record, and leaves no orphan behind", async () => {
    const vault = await open<{ n: number }>(disk);

    await vault.save("alice", { n: 1 });
    await vault.save("alice", { n: 2 });

    expect((await vault.get<{ n: number }>("alice")).value).toEqual({ n: 2 });
    expect(await recordFiles()).toHaveLength(1);
    expect((await vault.list()).value).toHaveLength(1);
  });

  it("says `invalid` when the caller's own data cannot be stored", async () => {
    const vault = await open<unknown>(memory);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const saved = await vault.save("alice", circular);

    expect(saved.error).toMatchObject({ kind: "invalid" });
  });

  it("refuses an empty id", async () => {
    const vault = await open<{ n: number }>(memory);

    expect((await vault.save("", { n: 1 })).error).toMatchObject({ kind: "invalid" });
  });
});

describe("find, list, exists, stats, delete", () => {
  it("finds by record type", async () => {
    const vault = await open<{ n: number }>(memory);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    expect((await vault.find("identity")).value).toEqual([{ n: 1 }]);
    expect((await vault.find("credential")).value).toEqual([{ n: 2 }]);
  });

  it("searches metadata only — not ids, exactly as the previous implementation did", async () => {
    const vault = await open<{ n: number }>(memory);
    const id = "urn:synet:IdentityCredential:aaa";
    await vault.save(id, { n: 1 }, { type: "identity", alias: "bob" });

    expect((await vault.find("bob")).value).toEqual([{ n: 1 }]);
    expect((await vault.find("identity")).value).toEqual([{ n: 1 }]);

    // The old indexer searched *only* metadata, and so does this. An id is a handle you
    // already have: you call `get` with it, you do not search for it. Matching it as a
    // fragment would make `find("identity")` return every `urn:synet:IdentityCredential:…`.
    expect((await vault.find(id)).value).toEqual([]);
    expect((await vault.find("aaa")).value).toEqual([]);
    expect((await vault.find("nothing")).value).toEqual([]);
  });

  it("searches nested metadata", async () => {
    const vault = await open<{ n: number }>(memory);
    await vault.save("a", { n: 1 }, { type: "identity", holder: { name: "alice" } });

    expect((await vault.find("alice")).value).toEqual([{ n: 1 }]);
  });

  it("lists ids and metadata without opening a record", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const listed = await vault.list();

    expect(listed.value).toEqual([{ id: "a", metadata: expect.objectContaining({ type: "identity" }) }]);
  });

  it("**list reads no records at all** — which is what an index is for", async () => {
    const { fs, reads } = counting(disk);
    const vault = await open<{ n: number }>(fs);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    reads.length = 0;
    await vault.list();

    // `list` answers entirely from the index: not one record is opened.
    expect(reads).toEqual([]);

    await vault.find("identity");

    // `find` opens exactly the one file that matched, and no more.
    expect(reads.filter((path) => path.endsWith(".vault.json"))).toHaveLength(1);
  });

  it("exists and stats answer from the index", async () => {
    const vault = await open<{ n: number }>(memory);
    await vault.save("a", { n: 1 });

    expect((await vault.exists("a")).value).toBe(true);
    expect((await vault.exists("b")).value).toBe(false);

    const stats = await vault.stats();
    expect(stats.value.totalRecords).toBe(1);
    expect(stats.value.name).toBe("vault");
  });

  it("deletes, and says `false` for what was never there", async () => {
    const vault = await open<{ n: number }>(memory);
    await vault.save("a", { n: 1 });

    expect((await vault.delete("a")).value).toBe(true);
    expect((await vault.delete("a")).value).toBe(false);
    expect((await vault.get("a")).error).toMatchObject({ kind: "absent" });
  });
});

describe("corruption", () => {
  it("reports a rotted record as `corrupt`, never as `absent`", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    await writeFile(join(root, file as string), "{ nope", "utf8");

    expect((await vault.get("a")).error).toMatchObject({ kind: "corrupt", reason: "unparseable" });
  });

  it("one rotted record does not hide the others", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    const files = await recordFiles();
    const rotten = files.find((name) => name.includes("identity")) as string;
    await writeFile(join(root, rotten), "{ nope", "utf8");

    expect((await vault.get<{ n: number }>("b")).value).toEqual({ n: 2 });
    expect((await vault.find("credential")).value).toEqual([{ n: 2 }]);
  });
});

describe("the index is a hint, not the truth", () => {
  it("**rebuilds a corrupted index and answers correctly**", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    await writeFile(join(root, ".index.json"), "{ not an index", "utf8");

    const reopened = await open<{ n: number }>(disk);

    expect((await reopened.get<{ n: number }>("b")).value).toEqual({ n: 2 });
    expect(reopened.searchIndexes).toEqual(["credential", "identity"]);
    expect((await reopened.list()).value).toHaveLength(2);
  });

  it("builds an index that is simply missing", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    await rm(join(root, ".index.json"));

    const reopened = await open<{ n: number }>(disk);

    expect((await reopened.get<{ n: number }>("a")).value).toEqual({ n: 1 });
  });

  it("rebuilds on demand, from the records", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    expect((await vault.rebuild()).isSuccess).toBe(true);
    expect((await vault.get<{ n: number }>("a")).value).toEqual({ n: 1 });
  });

  it("survives a rebuild when one record has rotted", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    const files = await recordFiles();
    await writeFile(join(root, files.find((n) => n.includes("identity")) as string), "!!!", "utf8");

    // The index still describes everything that verifies. The torn record cannot be *listed* —
    // nothing in it survived to list it by — but it is not forgotten either: `stats` counts it
    // and `verify` reports it by name.
    expect((await vault.rebuild()).isSuccess).toBe(true);
    expect((await vault.list()).value.map((entry) => entry.id)).toEqual(["b"]);
    expect((await vault.stats()).value.damaged).toBe(1);

    const report = (await vault.verify()).value;

    expect(report.totals).toEqual({ files: 2, intact: 1, damaged: 1 });
    expect(report.records.find((record) => record.state === "damaged")?.filename).toBe(
      files.find((name) => name.includes("identity")),
    );
  });
});

describe("verify — the truth is the store, not the index", () => {
  it("reports a healthy store", async () => {
    const vault = await open<{ n: number }>(memory);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    const report = (await vault.verify()).value;

    expect(report.healthy).toBe(true);
    expect(report.totals).toEqual({ files: 2, intact: 2, damaged: 0 });
    expect(report.index).toEqual([]);
    expect(report.name).toBe("vault");
  });

  it("**finds a record the index has never heard of** — the case `get` cannot answer", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    await plant("9999999999999-planted-identity.vault.json", "ghost", 9);

    // Everything that answers from the index says the store holds one record.
    expect((await vault.list()).value.map((entry) => entry.id)).toEqual(["a"]);

    // `verify` reads the files, and there are two.
    const report = (await vault.verify()).value;

    expect(report.totals).toEqual({ files: 2, intact: 2, damaged: 0 });
    expect(report.index).toEqual([
      { kind: "unknown", filename: "9999999999999-planted-identity.vault.json" },
    ]);

    // Nothing is damaged, and it is still not healthy: the *index* is wrong, which is the
    // cheap kind of wrong. A rebuild is the whole repair.
    expect(report.healthy).toBe(false);

    await vault.rebuild();

    expect((await vault.get<{ n: number }>("ghost")).value).toEqual({ n: 9 });
    expect((await vault.verify()).value.healthy).toBe(true);
  });

  it("reports a rotted record by name, with the reason", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    await writeFile(join(root, file as string), "{ nope", "utf8");

    const report = (await vault.verify()).value;

    expect(report.totals).toEqual({ files: 1, intact: 0, damaged: 1 });
    expect(report.records[0]).toMatchObject({
      filename: file,
      state: "damaged",
      damage: { reason: "unparseable" },
    });
    expect(report.healthy).toBe(false);
  });

  it("reports an index that points at a file that is not there", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    await rm(join(root, file as string));

    const report = (await vault.verify()).value;

    expect(report.totals).toEqual({ files: 0, intact: 0, damaged: 0 });
    expect(report.index).toEqual([{ kind: "dangling", id: "a", filename: file }]);

    // A stale hint reads as `absent`, which is honest — and a rebuild clears it without
    // touching anything else.
    expect((await vault.get("a")).error).toMatchObject({ kind: "absent" });

    await vault.rebuild();

    expect((await vault.verify()).value.healthy).toBe(true);
  });

  it("reports two files claiming one id, and rebuilds to the newer one", async () => {
    const vault = await open<{ n: number }>(disk);

    await plant("1000000000000-first.vault.json", "a", 1);
    await plant("2000000000000-second.vault.json", "a", 2);

    const report = (await vault.verify()).value;

    expect(report.totals).toEqual({ files: 2, intact: 2, damaged: 0 });
    expect(report.index).toContainEqual({
      kind: "duplicate",
      id: "a",
      filenames: ["1000000000000-first.vault.json", "2000000000000-second.vault.json"],
    });

    // An index is keyed by id and cannot hold both, so the newer file wins — decided by the
    // epoch the store already put in the name, not by a clock of ours.
    await vault.rebuild();

    expect((await vault.get<{ n: number }>("a")).value).toEqual({ n: 2 });
    expect((await vault.list()).value).toHaveLength(1);
  });

  it("changes nothing — repair is `rebuild`'s job", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    const path = join(root, file as string);
    await writeFile(path, "{ nope", "utf8");

    expect((await vault.verify()).value.totals.damaged).toBe(1);

    // Byte for byte where it was. A corrupt record is evidence, and evidence is not tidied up.
    expect(await readFile(path, "utf8")).toBe("{ nope");
  });
});

describe("damage is never hidden", () => {
  it("**a rebuild keeps what it could not read**, and `get` says `corrupt` — not `absent`", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    const files = await recordFiles();
    await tamper(files.find((name) => name.includes("identity")) as string);

    await vault.rebuild();

    // Dropping it would have turned *a broken record* into *no record at all* — and the id was
    // readable the whole time; only the checksum was wrong.
    expect((await vault.stats()).value.totalRecords).toBe(1);
    expect((await vault.stats()).value.damaged).toBe(1);
    expect((await vault.get("a")).error).toMatchObject({ kind: "corrupt", reason: "checksum" });

    // Present, and broken. Presence is not usability, and `exists` answers the first question.
    expect((await vault.exists("a")).value).toBe(true);
  });

  it("list marks a damaged record instead of dropping it", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });
    await vault.save("b", { n: 2 }, { type: "credential" });

    const files = await recordFiles();
    await tamper(files.find((name) => name.includes("identity")) as string);
    await vault.rebuild();

    const listed = (await vault.list()).value;
    const damaged = listed.find((entry) => entry.damage !== undefined);

    expect(listed.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(damaged?.id).toBe("a");
    expect(damaged?.damage?.reason).toBe("checksum");

    // The metadata survived the damage, so the entry is still worth something to a human.
    expect(damaged?.metadata).toMatchObject({ type: "identity" });
  });

  it("saving over a damaged record repairs it", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    await tamper(file as string);
    await vault.rebuild();

    await vault.save("a", { n: 7 }, { type: "identity" });

    expect((await vault.get<{ n: number }>("a")).value).toEqual({ n: 7 });
    expect((await vault.stats()).value.damaged).toBe(0);
    expect((await vault.list()).value.every((entry) => entry.damage === undefined)).toBe(true);
  });

  it("delete removes the damaged copy too, not just the record the index points at", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    const [file] = await recordFiles();
    await tamper(file as string);
    await vault.rebuild();

    await vault.delete("a");

    // A delete that left the caller's data on disk would not be a delete — and this is a store
    // for identities.
    expect(await recordFiles()).toEqual([]);
    expect((await vault.exists("a")).value).toBe(false);
  });

  it("`find` answers the same before and after a rebuild", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity", alias: "alice" });

    const before = (await vault.find("alice")).value;

    await vault.rebuild();

    // The index used to fold its own `created`/`updated` bookkeeping into the metadata it
    // searched, so a keyword matched before a rebuild and stopped matching after one. Same
    // query, two answers, depending on when it ran.
    expect((await vault.find("alice")).value).toEqual(before);
    expect((await vault.list()).value[0]?.metadata).toEqual({ type: "identity", alias: "alice" });
  });

  it("opening says when it had to rebuild, and why", async () => {
    const vault = await open<{ n: number }>(disk);
    await vault.save("a", { n: 1 }, { type: "identity" });

    // A store that did not exist had no index to load, so building one is still a rebuild —
    // and `created` is what tells the two apart.
    expect(vault.opening).toMatchObject({ source: "rebuilt", created: true });

    const reopened = await open<{ n: number }>(disk);

    expect(reopened.opening).toEqual({ source: "loaded", created: false, damaged: 0 });

    await writeFile(join(root, ".index.json"), "{ not an index", "utf8");

    const repaired = await open<{ n: number }>(disk);

    expect(repaired.opening.created).toBe(false);
    expect(repaired.opening.source).toBe("rebuilt");
    expect(repaired.opening.reason).toContain("unparseable");
  });
});

describe("parity across adapters", () => {
  it("answers a scripted scenario identically on disk and in memory", async () => {
    expect(await scenario(await open(disk))).toEqual(await scenario(await open(memory)));
  });
});

async function scenario(vault: Vault<{ n: number }>): Promise<unknown[]> {
  const answers: unknown[] = [];

  await vault.save("a", { n: 1 }, { type: "identity" });
  await vault.save("b", { n: 2 }, { type: "credential" });

  answers.push((await vault.get("a")).value);
  answers.push((await vault.get("missing")).error);

  // Ids only: the metadata carries `created`/`updated` from *now*, so comparing it across two
  // runs compares two clocks.
  answers.push((await vault.list()).value.map((entry) => entry.id));

  answers.push((await vault.find("credential")).value);
  answers.push(await vault.exists("b"));
  answers.push((await vault.stats()).value.totalRecords);

  await vault.delete("a");

  answers.push((await vault.delete("a")).value);
  answers.push((await vault.list()).value.map((entry) => entry.id));
  answers.push((await vault.get("a")).error);

  return answers;
}

/** A structural `IFileSystem` that records every read — the port needs no class. */
function counting(inner: IFileSystem): { fs: IFileSystem; reads: string[] } {
  const reads: string[] = [];
  const stat = inner.stat;

  const fs: IFileSystem = {
    read: (path) => {
      reads.push(path);
      return inner.read(path);
    },
    write: (path, data) => inner.write(path, data),
    delete: (path) => inner.delete(path),
    exists: (path) => inner.exists(path),
    list: (prefix) => inner.list(prefix),
    ensure: (prefix) => inner.ensure(prefix),
    ...(stat === undefined ? {} : { stat: (path: string) => stat(path) }),
  };

  return { fs, reads };
}
