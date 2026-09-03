import { describe, expect, it } from "vitest";
import { providerSetupGuidance } from "@/lib/providers/provider-setup-guidance";

describe("providerSetupGuidance", () => {
  it("returns reasonix's setup guidance with the manual 'reasonix setup' command and three in-app steps", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    expect(guidance).not.toHaveProperty("command");
    expect(guidance?.manualCommand).toBe("reasonix setup");
    expect(guidance?.summary).toBe(
      "Reasonix keeps provider API keys in its own store, not in your shell environment.",
    );
    expect(guidance?.steps).toEqual([
      "From a chat, choose \u201cSet up in terminal\u201d in the banner above the composer. It opens Reasonix's setup wizard on the host this composer runs on.",
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);
    expect(guidance?.steps).toHaveLength(3);
    expect(guidance?.steps[0]).toContain("Set up in terminal");
    expect(guidance?.terminalActionLabel).toBe("Set up in terminal");
    expect(guidance?.terminalHint).toBe(
      "Reasonix asks for your provider API key in that terminal. Finish there, then use Refresh above.",
    );
  });

  it("returns null for a provider with no guidance entry (cursor)", () => {
    expect(providerSetupGuidance("cursor")).toBeNull();
  });
});
