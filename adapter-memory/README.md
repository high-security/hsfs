# @hsfs/adapter-memory

**A `Map`.** The test double, and a genuine scratch store for work that should not outlive
the process.

```bash
npm install @hsfs/adapter-memory
```

```ts
import { MemoryFileSystem } from "@hsfs/adapter-memory";

const fs = new MemoryFileSystem();

await fs.write("a.json", "1");
await fs.read("a.json");        // "1"
await fs.list("");              // ["a.json"]
```

## What it is

A `Map`. `write` sets a key and `read` gets it — no ceremony in between, and no temporaries
to clean up. That is all a test double needs.

## The one deliberate divergence

`adapter-node` **refuses** paths containing `..`, because it has a real root and a record id
containing `../` would otherwise be a way out of the vault. A `Map` has no root to escape,
so a path here is an opaque key and `..` is not an error.

That difference is asserted in the test suite rather than papered over: containment is a
property of adapters that sit on a real filesystem.

## Parity

The test suite runs a scripted scenario — every port method, in an order that exercises the
rules — against **both** this adapter and `@hsfs/adapter-node`, and asserts they answer
identically. A port with two implementations is only a port if they agree.

That is why `@hsfs/adapter-node` is a devDependency here: not to be used, but to be
disagreed with in public if either one drifts.

## Not here

- **No persistence.** The `Map` dies with the process, by design.
- **No containment guard.** See above.
- **No sync twin**, like every other adapter.

## Requirements

Node.js 18+ for development. Zero runtime dependencies.

## License

MIT
