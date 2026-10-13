# @hsfs/adapter-node

**POSIX, in the ordinary way.** One constructor argument: the root.

```bash
npm install @hsfs/adapter-node
```

```ts
import { NodeFileSystem } from "@hsfs/adapter-node";

const fs = new NodeFileSystem({ root: "~/.hsfs/vault" });

await fs.write("1753427840015-ez9omy-identity.vault.json", record);
await fs.read("1753427840015-ez9omy-identity.vault.json"); // string | undefined
await fs.list("1753");                                     // recursive, portable paths
```

## Writing

```ts
async write(path, data) {
  const target = this.resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data, "utf8");
}
```

That is the whole of it, and it is deliberate. The platform's `writeFile` truncates and then
writes, so a crash mid-write can leave a torn file — **which is not this class's problem to
solve.** Durability belongs to whoever owns the data (`docs/SPEC.md` §4).

A test asserts that no temporaries ever appear beside a target. If somebody adds an `fsync`
to a class named after a platform, that test fails and the decision gets made out loud
instead of being discovered in production.

A store that needs more than this says so by *being* a different, more expensive store.

## Containment

Every path is resolved inside `root`, and anything that would leave it is **refused**, not
normalised:

```ts
await fs.write("../escape.json", "x");
// Error: path escapes the root: "../escape.json"
```

That guard is not a nicety. The root is usually a vault or a key directory, and a record id
containing `../` would otherwise be a perfectly good way to write outside it. A leading `/`
is treated as relative to the root, never as an absolute path.

## The port

`write` creates missing parents. `delete` is idempotent (and can remove a namespace, since
`rm -r` is what a directory delete means here). `read` returns `undefined` for absence —
including when the path is a directory, so that `read` and `exists` always agree.

`stat` and `chmod` are implemented here, because a disk has them.

## Durability

Not promised here, and not needed by the vault either: a caller that wants certainty pairs
immutable unique names with a `checksum` and discards what fails to verify. That is a shape
decision, not a filesystem feature — `docs/SPEC.md` §4, and §3 for the atomic tier we tried
and removed.

## Requirements

Node.js 18+. Zero runtime dependencies — `node:fs` only.

## License

MIT
