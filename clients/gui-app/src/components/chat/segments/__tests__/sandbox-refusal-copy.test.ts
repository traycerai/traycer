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

  it("gives SANDBOX_FROZEN no host detail, whatever the host's message says", () => {
    expect(
      sandboxRefusalCopyFor(
        "SANDBOX_FROZEN",
        "SANDBOX_FROZEN: sandbox host 'abc': out of credits",
      )?.hostDetail,
    ).toBeNull();
  });

  describe("SANDBOX_GUEST_NOT_CONFIGURED", () => {
    const HEADLINE = "Waiting for this sandbox's setup to finish";
    const MESSAGE =
      "SANDBOX_GUEST_NOT_CONFIGURED: sandbox host 'abc': guest setup stopped at step 3 of 5";
    const DETAIL = "sandbox host 'abc': guest setup stopped at step 3 of 5";

    it("renders the setup-in-progress copy by its code, carrying the host's last status as detail", () => {
      const copy = sandboxRefusalCopyFor(
        "SANDBOX_GUEST_NOT_CONFIGURED",
        MESSAGE,
      );
      expect(copy?.headline).toBe(HEADLINE);
      expect(copy?.description).toContain("still being set up");
      expect(copy?.hostDetail).toBe(DETAIL);
    });

    it("matches the message prefix when the block carries no code, with the same detail", () => {
      const copy = sandboxRefusalCopyFor(null, MESSAGE);
      expect(copy?.headline).toBe(HEADLINE);
      expect(copy?.hostDetail).toBe(DETAIL);
    });

    it("takes the whole message as the detail when the code arrived without its prefix", () => {
      expect(
        sandboxRefusalCopyFor(
          "SANDBOX_GUEST_NOT_CONFIGURED",
          "guest setup stopped at step 3",
        )?.hostDetail,
      ).toBe("guest setup stopped at step 3");
    });

    it("has no detail when the host sent nothing past the code", () => {
      for (const message of [
        "SANDBOX_GUEST_NOT_CONFIGURED:",
        "SANDBOX_GUEST_NOT_CONFIGURED:   \n ",
        "",
        "   ",
      ]) {
        expect(
          sandboxRefusalCopyFor("SANDBOX_GUEST_NOT_CONFIGURED", message)
            ?.hostDetail,
        ).toBeNull();
      }
    });
  });

  describe("SANDBOX_HOST_REFUSES_CREDENTIALS", () => {
    const HEADLINE = "Sandboxes don't take sign-ins";
    const MESSAGE =
      "SANDBOX_HOST_REFUSES_CREDENTIALS: sandbox host 'abc': refuses a provider key";

    it("renders the no-credentials copy by its code and by its message prefix", () => {
      const byCode = sandboxRefusalCopyFor(
        "SANDBOX_HOST_REFUSES_CREDENTIALS",
        MESSAGE,
      );
      expect(byCode?.headline).toBe(HEADLINE);
      expect(byCode?.description).toContain("never holds your credentials");
      expect(sandboxRefusalCopyFor(null, MESSAGE)?.headline).toBe(HEADLINE);
    });

    it("never surfaces the host's message as detail: the copy already says it", () => {
      expect(
        sandboxRefusalCopyFor("SANDBOX_HOST_REFUSES_CREDENTIALS", MESSAGE)
          ?.hostDetail,
      ).toBeNull();
      expect(sandboxRefusalCopyFor(null, MESSAGE)?.hostDetail).toBeNull();
    });
  });

  it("does not let one sandbox code's prefix pick another code's copy", () => {
    expect(
      sandboxRefusalCopyFor(null, "SANDBOX_GUEST_NOT_CONFIGURED_LATER: no"),
    ).toBeNull();
    expect(
      sandboxRefusalCopyFor(
        "SANDBOX_HOST_REFUSES_CREDENTIALS",
        "SANDBOX_GUEST_NOT_CONFIGURED: x",
      )?.headline,
    ).toBe("Sandboxes don't take sign-ins");
  });
});
