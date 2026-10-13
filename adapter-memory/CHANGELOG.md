# Changelog

All notable changes to this package are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

First release.

- **`MemoryFileSystem`** — the six port methods over a `Map`, plus the optional `stat` and
  `chmod`.
- **Parity-tested** — a scripted scenario is run against `@hsfs/adapter-node` and must
  produce identical answers.
- **One documented divergence** — no `..` guard, because there is no root to escape.
- **Zero runtime dependencies.**
