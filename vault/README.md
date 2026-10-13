# @hsfs/vault

**Records, indexed.** A store that finds a record by its **meaning** — its id, its type, its
metadata — rather than by its filename. Over any `IFileSystem`.

```bash
npm install @hsfs/vault
```

```ts
import { NodeFileSystem } from "@hsfs/adapter-node";
import { Vault } from "@hsfs/vault";

const opened = await Vault.open({
  fs: new NodeFileSystem({ root: "./store" }),
  name: "identities",
});

const vault = opened.value;   // check `opened.isSuccess` in real code

await vault.save("user:alice", { did: "did:key:z6Mk…" }, {
  type: "identity",
});

const found = await vault.get<{ did: string }>("user:alice");
if (found.isSuccess) found.value.did;   // "did:key:z6Mk…"
```

## On disk

```
store/
  .vault.json                            the descriptor — name, version, format,
                                         and **how it is encrypted**
  .index.json                            id → filename, metadata, types
  <epoch>-<random>-<type>.vault.json     { id, data, metadata: { type }, checksum, version }
```

**The filename is not the id.** An id is the *app's* handle; a filename is the *store's*
private business; the index is the bridge between them. Derive one from the other and you weld
an id to a path — at which point there is nowhere to put a search index, and you have a
filestorage rather than a vault.

## Records are the truth. The index is a hint.

This is the whole answer to "isn't the index just another file that can corrupt?" A **derived**
index cannot lose data, only time. So:

- `open` reads the index, and if anything about it is wrong — absent, unreadable,
  unparseable, missing fields — it **rebuilds from the records and carries on**
- `rebuild()` is a first-class method, for when you want to be sure
- the record is always written **before** the index, so a failed index write can never cost a
  record
- the worst case of a bad index is a slow first call

Two things follow, and both are asserted in the suite:

```ts
await vault.list();           // ids + metadata, from the index — opens ZERO records
await vault.find("identity"); // opens only the file(s) that matched, not every file
```

## Nothing in the store is invisible

A hint can be **missing an entry**, and then `list` describes a smaller store than the one on
disk while every answer it gives is still technically correct. So a rebuild never drops what it
could not read, and there is one method that does not ask the index at all.

```ts
const verified = await vault.verify();

const report = verified.value;   // check `verified.isSuccess` in real code

report.healthy;   // every record verifies AND the index matches the store
report.totals;    // { files, intact, damaged }
report.records;   // every record file, each judged on its own, by filename
report.index;     // where the index and the store disagree
```

`verify` reads the **files**. It is the only thing that can: the index cannot report a file it
could not name, and a torn write leaves nothing to name it with. It reports two kinds of
finding, kept apart because they need opposite responses:

| | | response |
| --- | --- | --- |
| `records[].state: "damaged"` | the file is there and does not read | a human, a backup, or the layer above |
| `index[]` | the records are fine and the **index** is wrong | `rebuild()` — cheap |

```ts
report.index;   // [ { kind: "dangling",   id, filename },      the index points at nothing
                //   { kind: "unknown",    filename },          a record the index never saw
                //   { kind: "misindexed", filename, indexed, stored },
                //   { kind: "duplicate",  id, filenames } ]     two files, one id
```

So `healthy: false` with `totals.damaged === 0` reads as *your index drifted*, not *your data is
gone*. `verify` changes nothing — repair is `rebuild`'s job, and this is what you consult to
decide whether to ask for it.

## Three pieces, three jobs

| | |
| --- | --- |
| `VaultRecord` | the **format** — what a record is, and whether a string of bytes is one. No I/O. |
| `Indexer` | **resolution and search** — `id → filename`, metadata, types, rebuild |
| `IFileSystem` | **bytes** |

Nothing in the vault does any of those itself. The only thing the vault owns is the **order**:
record first, index second.

## API

| | |
| --- | --- |
| `Vault.open({ fs, name? })` | open a store, creating it if it is not there |
| `save(id, data, metadata?)` | store a record, replacing any previous one for that id |
| `get<T>(id)` | the record's data — `absent` is the old `null` |
| `find(keyword)` | records whose **metadata** matches — the type included, because the type is metadata |
| `list()` | `{ id, metadata }[]` without opening a record — damaged records included and **marked** |
| `delete(id)` | `boolean` — `false` when the id was never known. Removes the damaged copies too |
| `exists(id)` | whether the store holds anything under the id — presence, not usability |
| `stats()` | name, `totalRecords`, `damaged`, created, descriptor |
| `rebuild()` | rebuild the index from the records; keeps what it cannot read |
| `verify()` | read the **store** and report what is in it — the one call that does not use the index |
| `opening` | whether `open` loaded or rebuilt the index, why, and whether it created the store |

Every one returns a `Result`, and the failure is **typed** — `absent` · `corrupt` *(`unparseable`
· `shape` · `checksum` · `identity` · `unreadable`)* · `invalid` · `unreadable`.

## Corruption

A corrupt record is **never** reported as absent. Absent is routine; corrupt is an incident —
a torn write, a failing disk, somebody editing the file — and the file is left exactly where it
is, because it is evidence and it may be recoverable by hand.

```ts
const found = await vault.get(id);

if (found.isFailure && found.error.kind === "corrupt") {
  found.error.reason;   // "unparseable" | "shape" | "checksum" | "identity" | "unreadable"
  found.error.detail;   // what was actually found, for a human
}
```

And one bad file never hides the others, nor itself. `list` and `find` skip what they cannot
read, and `list` also **marks** a damaged record instead of omitting it, with `stats().damaged`
counting it. What cannot be marked is a record the index could not *name* — a torn write leaves
no id behind — and reporting those, by filename, is what `verify` is for.

**The checksum covers the whole record** — id, data, metadata, version — over a *stable*
serialisation while the file itself is written pretty-printed. So reformatting a record by
hand, which is exactly what recovery is, does not invalidate it.

## Requirements

Node.js 18+. Zero runtime dependencies — `node:crypto` for the checksum, and the store is
injected.

## License

MIT
