# Changelog

All notable changes to this package are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

First release.

- **`NodeFileSystem`** — the six port methods over `node:fs`, plus the optional `stat` and
  `chmod`, because a disk has them.
- **A direct write** — `mkdir` + `writeFile`, and nothing else. No temporaries, no `fsync`.
  An atomic variant was tried and removed; durability is the caller's business
  (`../docs/SPEC.md` §3, §4).
- **Containment** — paths that escape the root are refused, not normalised.
- **Zero runtime dependencies** — `node:fs` only.
- **No sync twin** — async only, deliberately.
