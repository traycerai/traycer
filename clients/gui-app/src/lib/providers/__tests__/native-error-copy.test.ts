import { describe, expect, it } from "vitest";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";
import { ProviderNativeRpcError } from "@/hooks/providers/native-response-map";

describe("nativeErrorMessage", () => {
  it("prefers non-empty detail over code copy", () => {
    expect(nativeErrorMessage("duplicate_name", "  already there  ")).toBe(
      "already there",
    );
  });

  it("falls back to code copy when detail is empty", () => {
    expect(nativeErrorMessage("unsupported_action", null)).toBe(
      "This action is not supported for this provider.",
    );
    expect(nativeErrorMessage("unsupported_scope", "   ")).toBe(
      "This action is not supported for the selected scope.",
    );
  });
});

// The MCP/plugins/skills panels render `error.message` directly, so the copy
// map is only reachable if the error CARRIES it. Building the message from
// `detail ?? code` put the raw enum member on screen and made every string in
// that map dead on the list path.
describe("ProviderNativeRpcError message", () => {
  it("uses the friendly copy when the host sends no detail", () => {
    const err = new ProviderNativeRpcError({
      code: "config_unreadable",
      detail: null,
      method: "providers.list",
    });
    expect(err.message).toBe(
      "This provider's config could not be read. Check the file, then try again.",
    );
    // The raw enum member must not reach the user.
    expect(err.message).not.toContain("config_unreadable");
  });

  it("falls back for a whitespace-only detail too", () => {
    expect(
      new ProviderNativeRpcError({
        code: "duplicate_name",
        detail: "   ",
        method: "providers.nativeMutate",
      }).message,
    ).toBe("A server with this name already exists in this scope.");
  });

  it("still prefers a real detail from the host", () => {
    // Discriminating: the host's redacted parser message is more specific than
    // any static copy, so it must win when present.
    expect(
      new ProviderNativeRpcError({
        code: "config_unreadable",
        detail: "Failed to parse config /x/config.yaml: bad indent at line 3",
        method: "providers.list",
      }).message,
    ).toBe("Failed to parse config /x/config.yaml: bad indent at line 3");
  });

  it("keeps the typed code available for callers that branch on it", () => {
    const err = new ProviderNativeRpcError({
      code: "config_unreadable",
      detail: null,
      method: "providers.list",
    });
    expect(err.nativeCode).toBe("config_unreadable");
    expect(err.nativeDetail).toBeNull();
  });
});
