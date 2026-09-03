import { describe, expect, it } from "vitest";
import { providerSetupGuidance } from "@/lib/providers/provider-setup-guidance";

describe("providerSetupGuidance", () => {
  it("returns reasonix's setup guidance with the 'reasonix setup' command", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    expect(guidance?.command).toBe("reasonix setup");
    expect(guidance?.summary).toBe(
      "Reasonix keeps provider API keys in its own store, not in your shell environment.",
    );
    expect(guidance?.steps).toEqual([
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);
    expect(guidance?.terminalActionLabel).toBe("Set up in terminal");
    expect(guidance?.terminalHint).toBe(
      "Reasonix asks for your provider API key in that terminal. Finish there, then use Refresh above.",
    );
  });

  it("returns null for a provider with no guidance entry (cursor)", () => {
    expect(providerSetupGuidance("cursor")).toBeNull();
  });
});
