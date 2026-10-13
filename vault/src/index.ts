/**
 * `@hsfs/vault` — records, indexed, over any `IFileSystem`.
 *
 * ```ts
 * import { NodeFileSystem } from "@hsfs/adapter-node";
 * import { Vault } from "@hsfs/vault";
 *
 * const opened = await Vault.open({ fs: new NodeFileSystem({ root: "./store" }) });
 *
 * if (opened.isSuccess) {
 *   const vault = opened.value;
 *   await vault.save("user:alice", { did: "did:key:z6Mk…" }, { type: "identity" });
 *
 *   const found = await vault.get<{ did: string }>("user:alice");
 *   if (found.isSuccess) found.value.did;   // "did:key:z6Mk…"
 * }
 * ```
 *
 * The index is a **hint**; the records are the truth. That is what makes corrupting the index
 * a cache miss rather than data loss. And `vault.verify()` is the one call that reads the
 * **store** rather than the index, so nothing on disk can be invisible to it: every record is
 * judged on its own, and every disagreement between the index and the files is reported.
 *
 * `README.md` has the reasoning, `../docs/SPEC.md` §8 the design record.
 */

export {
  Vault,
  type IndexDisagreement,
  type ListEntry,
  type VaultOpening,
  type VaultOptions,
  type VaultReport,
  type VaultStats,
  type VerifiedRecord,
} from "./vault.js";

export {
  INDEX_FILENAME,
  Indexer,
  type IndexerOptions,
  type OpenReport,
} from "./indexer.js";

export {
  INDEX_VERSION,
  parseIndex,
  type DamagedRecord,
  type IndexDocument,
  type IndexRecord,
} from "./index-document.js";

export {
  VAULT_FILENAME,
  VAULT_VERSION,
  createVaultMetadata,
  parseVaultMetadata,
  type CreateVaultMetadataArgs,
  type VaultEncoding,
  type VaultFormat,
  type VaultMetadata,
} from "./metadata.js";

export {
  RECORD_SUFFIX,
  RECORD_VERSION,
  VaultRecord,
  checksumOf,
  salvageRecord,
  stableStringify,
  type CreateRecordArgs,
  type RecordFields,
} from "./record.js";

export { Result } from "./result.js";

export {
  CORRUPT_REASONS,
  describeError,
  isCorruptReason,
  type Corrupt,
  type CorruptReason,
  type VaultError,
} from "./errors.js";

export { sha256 } from "./hash.js";
