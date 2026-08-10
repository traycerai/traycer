import { describe, expect, it } from "vitest";
import {
  modelProviderAuthErrorCodeSchema,
  modelProviderListErrorCodeSchema,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  modelProviderAuthErrorDisposition,
  modelProviderAuthErrorMessage,
  modelProviderListErrorMessage,
} from "@/lib/providers/model-provider-error-copy";

describe("model provider error copy", () => {
  it("prefers the host's detail over the fallback sentence", () => {
    // The detail is the provider's own wording for a flow Traycer does not
    // understand ("expected one of: ANTHROPIC_API_KEY"), already redacted
    // host-side. Our sentence exists for a bare code.
    expect(
      modelProviderAuthErrorMessage("invalid_input", "expected one of: X"),
    ).toBe("expected one of: X");
    // A whitespace-only detail is NOT a detail: it must fall through to the
    // same sentence a null one produces. `not.toBe("")` passed even when the
    // blank string was handed straight back.
    expect(modelProviderAuthErrorMessage("invalid_input", "   ")).toBe(
      modelProviderAuthErrorMessage("invalid_input", null),
    );
    expect(modelProviderListErrorMessage("server_unavailable", null)).toContain(
      "couldn't be started",
    );
  });

  it("has copy for every member of both wire enums", () => {
    // The tables are `Record<Code, string>`, so a new member fails compilation
    // - this asserts the runtime half: every member resolves to a non-empty
    // line without a detail to fall back on.
    for (const code of modelProviderAuthErrorCodeSchema.options) {
      expect(modelProviderAuthErrorMessage(code, null).length).toBeGreaterThan(
        0,
      );
    }
    for (const code of modelProviderListErrorCodeSchema.options) {
      expect(modelProviderListErrorMessage(code, null).length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("modelProviderAuthErrorDisposition", () => {
  it("stands down silently when a newer attempt took the surface", () => {
    // Not an error the user caused - it is what happens when they restart the
    // flow. Reporting it would accuse them of breaking the thing they fixed.
    expect(modelProviderAuthErrorDisposition("attempt_superseded")).toBe(
      "stand-down",
    );
  });

  it("offers a fresh start for an attempt that no longer exists", () => {
    expect(modelProviderAuthErrorDisposition("attempt_expired")).toBe(
      "restart",
    );
    expect(modelProviderAuthErrorDisposition("attempt_not_found")).toBe(
      "restart",
    );
  });

  it("re-prompts for a refused code, keeping the live attempt", () => {
    // Restarting would throw away a usable authorization the host is still
    // holding a server lease for.
    expect(modelProviderAuthErrorDisposition("code_rejected")).toBe("reprompt");
  });

  it("reports everything else", () => {
    for (const code of [
      "server_unavailable",
      "provider_not_found",
      "invalid_input",
      "provider_auth_failed",
    ] as const) {
      expect(modelProviderAuthErrorDisposition(code)).toBe("report");
    }
  });
});

describe("config_unreadable", () => {
  it("points at the FILE on both arms, because that is where the fix is", () => {
    // The one code that is neither our fault nor the host's: the user's own
    // `opencode.json` did not parse.
    expect(modelProviderListErrorMessage("config_unreadable", null)).toContain(
      "config file",
    );
    expect(modelProviderAuthErrorMessage("config_unreadable", null)).toContain(
      "config file",
    );
  });

  it("is REPORTED, not restarted or re-prompted", () => {
    // No attempt was lost, so `restart` would invent one; and nothing the user
    // types in the dialog fixes a file the parser choked on, so `reprompt`
    // would ask for input that cannot help.
    expect(modelProviderAuthErrorDisposition("config_unreadable")).toBe(
      "report",
    );
  });

  it("prefers the host's detail, which names where the file broke", () => {
    // Redacted host-side, and far more useful than our generic sentence.
    expect(
      modelProviderAuthErrorMessage(
        "config_unreadable",
        "opencode.json: unexpected token at line 12",
      ),
    ).toContain("line 12");
  });
});
