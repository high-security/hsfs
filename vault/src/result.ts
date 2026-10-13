/**
 * `Result<T, E>` — the pattern, local.
 *
 * The shape is deliberately the familiar one: `success` / `failure`, `isSuccess` /
 * `isFailure`, `value`, `error`. Nothing here is invented, and nothing here is imported —
 * the vault is small, and a dependency for forty lines would be a dependency the vault then
 * has to keep alive.
 *
 * **The one deliberate difference from a message-carrying Result:** `E` is *typed*. The
 * vault's whole job is telling apart `absent`, `corrupt` and `unreadable`, and a caller
 * that has to string-match to do that has been given ceremony, not information. Hence
 * `VaultError` being a discriminated union (`errors.ts`).
 *
 * `value` throws when read from a failure, and `error` throws when read from a success.
 * Both are *programming* errors rather than data conditions — the pattern's way of saying
 * "you checked wrong" — and the symmetry is deliberate: see the note on `error` below for
 * why it is typed `E` rather than `E | undefined`.
 */
export class Result<T, E> {
  readonly #success: boolean;
  readonly #value?: T;
  readonly #error?: E;

  private constructor(success: boolean, value?: T, error?: E) {
    this.#success = success;
    this.#value = value;
    this.#error = error;
  }

  static success<T, E = never>(value: T): Result<T, E> {
    return new Result<T, E>(true, value, undefined);
  }

  static failure<T, E>(error: E): Result<T, E> {
    return new Result<T, E>(false, undefined, error);
  }

  get isSuccess(): boolean {
    return this.#success;
  }

  get isFailure(): boolean {
    return !this.#success;
  }

  /** The value. **Throws if this is a failure** — check `isSuccess` first, or use `unwrapOr`. */
  get value(): T {
    if (!this.#success) {
      throw new Error("cannot read the value of a failed Result");
    }
    return this.#value as T;
  }

  /**
   * The error. **Throws if this succeeded** — the mirror of `value`.
   *
   * Typed `E` rather than `E | undefined`, and that is the point. The `| undefined` looks
   * harmless and is not: it makes every `result.error.kind` need a non-null assertion at
   * every call site, which is exactly the ceremony a *typed* Result is supposed to remove.
   * Reading the wrong half is a programming error either way, so both halves throw.
   */
  get error(): E {
    if (this.#success) {
      throw new Error("cannot read the error of a successful Result");
    }
    return this.#error as E;
  }

  /** The value, or `fallback` when this failed. The alternative to checking. */
  unwrapOr(fallback: T): T {
    return this.#success ? (this.#value as T) : fallback;
  }

  /** Transform a success. A failure passes through untouched. */
  map<U>(transform: (value: T) => U): Result<U, E> {
    return this.#success
      ? Result.success<U, E>(transform(this.#value as T))
      : Result.failure<U, E>(this.#error as E);
  }
}
