# Changelog

All notable changes to this package are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

First release. A rework of the previous vault — **the names are unchanged on purpose.**

- **`Vault`** — `open`, `save`, `get`, `find`, `list`, `delete`, `exists`, `stats`, `rebuild`,
  `verify`. Records are named `<epoch>-<random>-<type>.vault.json`; **the id is not in the
  filename.**
- **`verify()`** — reads the **store**, not the index, and reports what is actually in it:
  every record file judged on its own, plus every disagreement between the index and the files
  (`dangling`, `unknown`, `misindexed`, `duplicate`). It is the one call that can see a record
  the index could not name, which is what a torn write produces, and it changes nothing.
- **Damage is never hidden.** `rebuild` records what it could not read instead of dropping it,
  so `list` marks a damaged record rather than omitting it, `stats()` counts it, and `get`
  answers `corrupt` rather than `absent`. `delete` removes the damaged copies too.
- **`opening`** — whether `open` loaded or rebuilt the index, why, and whether it created the
  store. A rebuild is routine; a silent one is how a store quietly becomes a different store.
- **`Indexer`** — `id → filename`, metadata, and the distinct types. **Derived, never
  authoritative**: `open` rebuilds it when it is absent, unreadable or unparseable, so
  corrupting the index is a cache miss rather than data loss. Where two files claim one id the
  newer **filename** wins — the epoch is already in the name, so no clock of ours is involved.
- **`VaultRecord<T>`** — the value object. Knows the shape, builds, serialises, parses,
  decides whether a string of bytes is a record, and salvages what is legible from one that
  isn't. No I/O.
- **`VaultMetadata`** — `.vault.json`: name, version, format, and **how the store is
  encrypted**. It records that; it does not implement it.
- **`Result`** — local, typed, no dependency. `error` is `E`, not `E | undefined`, and
  `VaultError` is a discriminated union so callers switch on `kind` instead of matching
  strings.
- **Corruption, named** — `unparseable`, `shape`, `checksum`, `identity`, `unreadable`. A
  corrupt record is never reported as absent, and the file is left in place.
- **`list` opens no records**, and `find` opens only the ones that matched — both asserted.
- **Zero runtime dependencies** — `node:crypto`, and the store is injected.

### Known gaps, recorded rather than hidden

- **No locking.** Concurrent writers can lose an index update. Bounded (the index is derived),
  not prevented. `proper-lockfile` cannot work over an object store.
- **`find` does not report what it skipped** — a match that has rotted is missing from the
  result without saying so. `list` and `verify` are where that is visible.
- **Every legacy record reports `corrupt (checksum)`.** The old checksum was not a hash.
- **The index's metadata is not verified against the records.** `verify` checks existence and
  integrity; a stale metadata *copy* is repaired by `rebuild`, which reads it back off the
  record.
