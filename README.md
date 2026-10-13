# @hsfs — High Security File System

Storage infrastructure. A port, adapters for it, and security layers on top.

```
core              the ports — types only, zero runtime, zero dependencies
adapter-node      POSIX. Plain writes; durability is the caller's (§4).
adapter-memory    a Map. For tests, and for scratch stores.
```

`@hsfs` holds no identity semantics and never asks for a key. It composes with any domain
layer; neither requires the other.

## The port

Six methods. Async only. Nothing a backend cannot honour.

```ts
const fs: IFileSystem = new NodeFileSystem({ root: "~/.hsfs/vault" });

await fs.write("1753427840015-ez9omy-identity.vault.json", record);
await fs.read("1753427840015-ez9omy-identity.vault.json"); // string | undefined
await fs.list("1753");                                     // recursive, portable paths
```

`write` creates missing parents. `delete` is idempotent. `read` returns `undefined` when
nothing is there — absence is a value, not an exception, because it is the one failure
every backend spells differently. Everything else throws.

Optional members (`stat`, `chmod`) are **detected, never assumed** — most backends cannot
chmod, and requiring it is what rots an adapter ecosystem.

## No second tier

Atomicity was tried (`IAtomicFileSystem`, with a `readonly atomicWrite: true` discriminant)
and removed the same day. `atomicWrite: true` is a **label**, not a capability — it says a
guarantee exists and says nothing about what the store actually does. The real need is
**resilience**: checks against corruption on *every* method, which is a sibling class for a
different use case, not a flag beside one method.

`docs/SPEC.md` §3 is the record. §4 is the doctrine that made the tier unnecessary —
durability belongs to whoever owns the data, and it is reachable from shape alone: immutable
names, a checksum, a rebuildable index.

## Working here

One repository, **npm workspaces only** — no Turborepo, no Nx, no changesets. If a tool is
needed to make the tool work, the tool is the problem.

```bash
npm install
npm run build      # in dependency order: core → adapters
npm test
```

`build` runs before `test` because a dependant resolves its sibling's `dist`.

See `docs/SPEC.md` for the design, the decision log, and what is deliberately not here.

## License

MIT
