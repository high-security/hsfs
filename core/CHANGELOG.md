# Changelog

All notable changes to this package are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

First release.

- **`IFileSystem`** — six methods, async only: `read`, `write`, `delete`, `exists`,
  `list`, `ensure`. Nothing a backend could not honour.
- **Optional capabilities** — `stat`, `chmod`. Detected, never assumed.
- **Types only** — zero runtime, zero dependencies, so an adapter can depend on this as a
  leaf and publish with no dependency at all.
- **No second tier.** An `IAtomicFileSystem` was written and removed the same day: a
  contract with no implementer, and `atomicWrite: true` was a label rather than a
  capability. If resilience ever earns its keep it returns as a sibling class, not a flag.
  See `docs/SPEC.md` §3.

> The port is **not frozen**. This is why the version is `0.x`: it can still move without a
> breaking change, which is the honest signal for a contract with no consumers yet.
