/**
 * What can go wrong, as a thing a caller can branch on.
 *
 * A vault's most important question is *"is the record absent, or is it broken?"* — and the
 * answer has to be unambiguous, because the two mean opposite things. Absent is routine.
 * **Corrupt is an incident**: it may be a torn write, a bad disk, or somebody editing the
 * file, and a store that answers `absent` to any of those is lying at the exact moment
 * somebody needs the truth.
 *
 * So the reason is typed, and the caller switches on `kind` rather than matching a string.
 */

/**
 * Why a file that should have held a record did not.
 *
 * A value, not just a type: the index reads reasons back off disk, and a second hand-written
 * list to validate them against would drift from this one the first time a reason is added.
 */
export const CORRUPT_REASONS = [
  /** Not JSON at all — a torn write, or something else wrote here. */
  "unparseable",
  /** Valid JSON, wrong shape: missing fields, or fields of the wrong type. */
  "shape",
  /** The record is intact but does not hash to its own `checksum`. */
  "checksum",
  /** The file's name and the record inside it disagree about which id they hold. */
  "identity",
  /** The file could not be read at all. The store failed, rather than the record. */
  "unreadable",
] as const;

/** Why a file that should have held a record did not. */
export type CorruptReason = (typeof CORRUPT_REASONS)[number];

/** Is this one of the reasons above? Used to validate a reason read back from disk. */
export function isCorruptReason(value: unknown): value is CorruptReason {
  return (
    typeof value === "string" &&
    (CORRUPT_REASONS as readonly string[]).includes(value)
  );
}

/** A record that could not be read. Produced by `VaultRecord.parse`, given an id by the vault. */
export interface Corrupt {
  reason: CorruptReason;
  /** What was actually found, for a human — never for branching. */
  detail: string;
}

export type VaultError =
  /** Nothing is stored under that id. Routine, not an incident. */
  | { kind: "absent"; id: string }
  /**
   * Something *is* stored under that id, and it is not usable.
   *
   * The file is left exactly where it is. Discarding it would be the one thing worse than
   * reporting it: a corrupt record is evidence, and it may be recoverable by hand.
   */
  | { kind: "corrupt"; id: string; reason: CorruptReason; detail: string }
  /** The caller asked for something that cannot be stored — an empty id, unserialisable data. */
  | { kind: "invalid"; id: string; detail: string }
  /** The store itself failed. The port throws for this, and the vault converts it. */
  | { kind: "unreadable"; id: string; cause: string };

/** `"corrupt (checksum): …"` — for logs and tests. Never for branching. */
export function describeError(error: VaultError): string {
  switch (error.kind) {
    case "absent":
      return `absent: ${JSON.stringify(error.id)}`;
    case "corrupt":
      return `corrupt (${error.reason}): ${JSON.stringify(error.id)} — ${error.detail}`;
    case "invalid":
      return `invalid: ${JSON.stringify(error.id)} — ${error.detail}`;
    case "unreadable":
      return `unreadable: ${JSON.stringify(error.id)} — ${error.cause}`;
  }
}
