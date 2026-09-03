import { describe, expect, it } from "vitest";
import type { ProviderLoginCapability } from "@traycer/protocol/host/provider-schemas";
import {
  providerSetupGuidance,
  providerSetupSteps,
  resolveProviderTerminalSetup,
} from "@/lib/providers/provider-setup-guidance";

function capabilityWithTerminalLogin(
  oauthArgs: ReadonlyArray<string> | null,
): ProviderLoginCapability {
  return {
    oauthArgs: oauthArgs === null ? null : [...oauthArgs],
    token: null,
    codePaste: null,
    terminalLogin: {},
  };
}

describe("providerSetupGuidance", () => {
  it("returns reasonix's setup guidance with the manual 'reasonix setup' command and two post-action steps", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    expect(guidance).not.toHaveProperty("steps");
    expect(guidance).not.toHaveProperty("command");
    expect(guidance?.manualCommand).toBe("reasonix setup");
    expect(guidance?.summary).toBe(
      "Reasonix keeps provider API keys in its own store, not in your shell environment.",
    );
    expect(guidance?.stepsAfterAction).toEqual([
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);
    expect(guidance?.stepsAfterAction).toHaveLength(2);
    expect(guidance?.noSurfaceStep).toBe(
      "Choose \u201cSet up in terminal\u201d from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
    );
    expect(guidance?.terminalActionLabel).toBe("Set up in terminal");
    expect(guidance?.terminalHint).toBe(
      "Reasonix asks for your provider API key in that terminal. Finish there, then use Refresh above.",
    );
  });

  it("returns null for a provider with no guidance entry (cursor)", () => {
    expect(providerSetupGuidance("cursor")).toBeNull();
  });
});

describe("providerSetupSteps", () => {
  it("returns just the post-action steps when a terminal action is available", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    expect(providerSetupSteps(guidance, true)).toEqual(
      guidance.stepsAfterAction,
    );
  });

  it("prepends the no-surface step when there is no terminal action", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    expect(providerSetupSteps(guidance, false)).toEqual([
      guidance.noSurfaceStep,
      ...guidance.stepsAfterAction,
    ]);
  });
});

describe("resolveProviderTerminalSetup", () => {
  it("returns null for a provider with no declared capability (undefined loginCapability)", () => {
    expect(resolveProviderTerminalSetup("copilot", undefined)).toBeNull();
  });

  it("returns the default generic copy for a provider with the capability but no guidance override (copilot)", () => {
    const guidance = resolveProviderTerminalSetup(
      "copilot",
      capabilityWithTerminalLogin(["login"]),
    );
    expect(guidance).not.toBeNull();
    expect(guidance?.terminalActionLabel).toBe("Sign in from a terminal");
    expect(guidance?.manualCommand).toBeNull();
    expect(guidance?.summary).toBe(
      "Copilot signs in from a terminal: it prints a sign-in code that only exists there.",
    );
  });

  it("returns the reasonix override for reasonix with the capability", () => {
    const guidance = resolveProviderTerminalSetup(
      "reasonix",
      capabilityWithTerminalLogin(["setup"]),
    );
    expect(guidance).not.toBeNull();
    expect(guidance?.manualCommand).toBe("reasonix setup");
    expect(guidance?.terminalActionLabel).toBe("Set up in terminal");
  });

  it("returns null for reasonix when terminalLogin is set but oauthArgs is empty", () => {
    expect(
      resolveProviderTerminalSetup("reasonix", capabilityWithTerminalLogin([])),
    ).toBeNull();
  });
});
