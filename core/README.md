# @hsfs/core

**The port.** One interface, six methods — and no code at all.

```bash
npm install @hsfs/core
```

## Why it is empty on purpose

This package is **types only: zero runtime, zero dependencies.** Not as a stylistic choice —
as the mechanism that makes adapters leaves. An adapter depends on it with

```json
"devDependencies": { "@hsfs/core": "^0.1.0" }
```

and `import type`, which is erased at build. So a published adapter carries **no dependency
on us at all**, and the contract stays a contract instead of becoming a framework.

You can see it in the test suite: the first assertion is that the module has no runtime
exports.

## `IFileSystem`

```ts
read(path): Promise<string | undefined>   // undefined when nothing is there
write(path, data): Promise<void>          // creates missing parents
delete(path): Promise<void>               // idempotent
exists(path): Promise<boolean>
list(prefix): Promise<string[]>           // recursive, paths you can pass back to read
ensure(prefix): Promise<void>             // idempotent

stat?(path): Promise<FileStats | undefined>   // optional — detect it
chmod?(path, mode): Promise<void>             // optional — detect it
```

The rules that keep it portable:

- **Paths are POSIX-style**, relative to the adapter's root. Backends translate.
- **`read` returns `undefined` for absence** — a *value*, not an exception, because it is
  the one failure every backend spells differently (`ENOENT`, `NoSuchKey`, `404`). Real
  failures still throw.
- **`write` creates parents.** Object stores have no directories; requiring `ensure` first
  would be teaching the caller about the disk.
- **`delete` is idempotent.** S3 is; POSIX is not. The port takes the forgiving one.
- **`list` is recursive**, because "all keys under this prefix" is the native object-store
  operation.
- **Optional members are detected, never assumed.** A port that *requires* what half its
  backends cannot do is how an ecosystem rots — `chmod` is the example, and it is optional
  here.

## No second tier

Atomicity was tried and removed the same day: `readonly atomicWrite: true` is a **label**,
not a capability. The real need is **resilience** — checks against corruption on every
method — and that is a sibling class for a different use case, not a flag beside one.

If resilience ever earns its keep it comes back as a sibling class that checks **every**
method, not as a flag beside one.

## Not here

- **No implementation.** Not a single function. Adapters do that.
- **No decorators, no layers.** Those are separate packages, so that using one does not
  opt you into all of them.
- **No Unit, no `teach`, no capabilities.** A filesystem has no business teaching a model
  to call `chmod`.

## Requirements

Node.js 18+ for development. Zero runtime dependencies.

## License

MIT
