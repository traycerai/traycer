import { describe, expect, it } from "vitest";
import { sandboxRefusalCopyFor } from "@/components/chat/segments/sandbox-refusal-copy";

const FROZEN_HEADLINE = "Paused: account out of credits";

describe("sandboxRefusalCopyFor", () => {
  it("renders SANDBOX_FROZEN as the paused-for-credits copy by its code", () => {
    const copy = sandboxRefusalCopyFor("SANDBOX_FROZEN", "anything at all");
    expect(copy).not.toBeNull();
    expect(copy?.headline).toBe(FROZEN_HEADLINE);
    expect(copy?.description).toContain("credits ran out");
  });

  it("matches the message prefix `CODE:` when the block carries no code", () => {
    expect(
      sandboxRefusalCopyFor(
        null,
        "SANDBOX_FROZEN: sandbox host 'abc': out of credits",
      )?.headline,
    ).toBe(FROZEN_HEADLINE);
    // An empty code is no code.
    expect(
      sandboxRefusalCopyFor("", "SANDBOX_FROZEN: sandbox host 'abc'")?.headline,
    ).toBe(FROZEN_HEADLINE);
  });

  it("lets the code win over the prefix: a block with another code is not rewritten by its message", () => {
    expect(
      sandboxRefusalCopyFor(
        "RUNTIME_THROWN",
        "SANDBOX_FROZEN: sandbox host 'abc'",
      ),
    ).toBeNull();
    // And the code alone is enough when the message says something else.
    expect(
      sandboxRefusalCopyFor("SANDBOX_FROZEN", "RUNTIME_THROWN: boom")?.headline,
    ).toBe(FROZEN_HEADLINE);
  });

  it("does not match a message that merely contains the code", () => {
    expect(
      sandboxRefusalCopyFor(null, "The host said SANDBOX_FROZEN: later"),
    ).toBeNull();
    expect(
      sandboxRefusalCopyFor(null, "not SANDBOX_FROZEN: at the start"),
    ).toBeNull();
  });

  it("needs the colon: a longer word starting with the code is not the code", () => {
    expect(
      sandboxRefusalCopyFor(null, "SANDBOX_FROZEN_FOREVER: no"),
    ).toBeNull();
    expect(sandboxRefusalCopyFor(null, "SANDBOX_FROZEN")).toBeNull();
  });

  it("is not fooled by inherited Object keys used as a code", () => {
    for (const code of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
      "valueOf",
    ]) {
      expect(sandboxRefusalCopyFor(code, "")).toBeNull();
    }
  });

  it("returns null for an unrelated code and for a plain message", () => {
    expect(sandboxRefusalCopyFor("RUNTIME_THROWN", "boom")).toBeNull();
    expect(sandboxRefusalCopyFor(null, "boom")).toBeNull();
  });
});
