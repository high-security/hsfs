import { describe, expect, it } from "vitest";
import { Result } from "../src/index.js";

describe("Result", () => {
  it("carries a success", () => {
    const result = Result.success<number, string>(42);

    expect(result.isSuccess).toBe(true);
    expect(result.isFailure).toBe(false);
    expect(result.value).toBe(42);
  });

  it("carries a typed failure", () => {
    const result = Result.failure<number, string>("nope");

    expect(result.isFailure).toBe(true);
    expect(result.isSuccess).toBe(false);
    expect(result.error).toBe("nope");
  });

  it("throws when the wrong half is read", () => {
    // A programming error, not a data condition — it means "you checked wrong". Both halves
    // throw, so that `error` can be typed `E` instead of `E | undefined`.
    expect(() => Result.failure<number, string>("nope").value).toThrow(/failed Result/);
    expect(() => Result.success<number, string>(1).error).toThrow(/successful Result/);
  });

  it("unwraps with a fallback", () => {
    expect(Result.success<number, string>(1).unwrapOr(9)).toBe(1);
    expect(Result.failure<number, string>("x").unwrapOr(9)).toBe(9);
  });

  it("maps a success", () => {
    expect(Result.success<number, string>(2).map((n) => n * 2).value).toBe(4);
  });

  it("passes a failure through map untouched", () => {
    const mapped = Result.failure<number, string>("x").map((n) => n * 2);

    expect(mapped.isFailure).toBe(true);
    expect(mapped.error).toBe("x");
  });
});
