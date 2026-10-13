# @hsfs — High Security File System

Storage infrastructure. A port, adapters for it, and security layers on top.

```
core              the ports — types only, zero runtime, zero dependencies
adapter-node      POSIX. Plain writes; durability is the caller's business.
adapter-memory    a Map. For tests, and for scratch stores.
vault             records, indexed — the store the layers attach to
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


```bash
npm install
npm run build      # in dependency order: core → adapters
npm test
```

`build` runs before `test` because a dependant resolves its sibling's `dist`.

Each package's README carries the reasoning behind it.

## License

MIT
