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

describe("a config the provider cannot parse", () => {
  // There is no code of its own for this any more, and that is the point: a
  // config the provider rejects is a server that never boots, so the condition
  // is not observable here as anything else. It arrives as
  // `server_unavailable` carrying the redacted parse error, and the detail rule
  // is what turns a generic sentence into an actionable one.

  it("shows the host's parse error rather than our generic sentence", () => {
    // File, line and column - the three things that say where to go, none of
    // which a fallback sentence can know.
    const detail =
      "~/.config/opencode/opencode.json: unexpected token '}' at line 12, column 3";
    expect(modelProviderAuthErrorMessage("server_unavailable", detail)).toBe(
      detail,
    );
    expect(modelProviderListErrorMessage("server_unavailable", detail)).toBe(
      detail,
    );
  });

  it("still reads sensibly on a bare code, because the fallback is TRUE", () => {
    // A config the parser rejects IS a server that failed to start, so the
    // generic sentence is not a wrong-bug answer - just a less useful one.
    expect(modelProviderListErrorMessage("server_unavailable", null)).toContain(
      "couldn't be started",
    );
    expect(modelProviderAuthErrorMessage("server_unavailable", null)).toContain(
      "couldn't be started",
    );
  });

  it("is REPORTED, not restarted or re-prompted", () => {
    // No attempt was lost, so `restart` would invent one; and nothing the user
    // types in the dialog fixes a file the parser choked on, so `reprompt`
    // would ask for input that cannot help. The next move is in an editor.
    expect(modelProviderAuthErrorDisposition("server_unavailable")).toBe(
      "report",
    );
  });
});

describe("detail normalization on the LIST helper", () => {
  // The two helpers implement the same rule separately, so covering it through
  // the auth one only proved the auth one. These are the cases that would go
  // unnoticed if the list copy ever drifted: a whitespace-only detail is the
  // shape that turns a useful message into a blank line.
  it("falls back to the table for a blank or whitespace detail", () => {
    expect(modelProviderListErrorMessage("server_unavailable", "")).toBe(
      modelProviderListErrorMessage("server_unavailable", null),
    );
    expect(modelProviderListErrorMessage("server_unavailable", "   \n ")).toBe(
      modelProviderListErrorMessage("server_unavailable", null),
    );
  });

  it("prefers the host's detail, trimmed", () => {
    expect(
      modelProviderListErrorMessage(
        "server_unavailable",
        "  opencode.json: unexpected token at line 12  ",
      ),
    ).toBe("opencode.json: unexpected token at line 12");
  });
});
