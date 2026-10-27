import { describe, expect, it } from "vitest";
import { sandboxCredentialLine } from "@/lib/sandboxes/sandbox-credential-mode";

describe("sandboxCredentialLine", () => {
  it("says a placeholder credential stays with Traycer, in the plain tone", () => {
    expect(sandboxCredentialLine("claude", "placeholder", null)).toEqual({
      tone: "plain",
      text: "On this sandbox its credential stays with Traycer: agents can use it, never read it",
    });
  });

  it("names Traycer's key for Traycer's own harness", () => {
    expect(sandboxCredentialLine("traycer", "placeholder", null)).toEqual({
      tone: "plain",
      text: "Uses Traycer's key on this sandbox. Agents can use it but never see it.",
    });
  });

  it("says a process-scoped credential is readable by agents, in the caution tone", () => {
    expect(sandboxCredentialLine("claude", "process-scoped", null)).toEqual({
      tone: "caution",
      text: "Runs with its own credential on this sandbox, readable by agents",
    });
  });

  it("appends the note after the unsupported line", () => {
    expect(
      sandboxCredentialLine(
        "claude",
        "unsupported",
        "  needs a browser sign-in  ",
      ),
    ).toEqual({
      tone: "unavailable",
      text: "Not available on sandboxes: needs a browser sign-in",
    });
  });

  it.each([null, undefined, "", "   \n "])(
    "drops the colon for the unsupported note %j",
    (note) => {
      expect(sandboxCredentialLine("claude", "unsupported", note)).toEqual({
        tone: "unavailable",
        text: "Not available on sandboxes",
      });
    },
  );

  it("says nothing for a null or undefined mode", () => {
    expect(sandboxCredentialLine("claude", null, null)).toBeNull();
    expect(sandboxCredentialLine("claude", undefined, "ignored")).toBeNull();
  });
});
