import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderLoginCapability,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerSetupActionPlacement,
  providerSetupGuidance,
  providerSetupPreparingLabel,
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

/** A `providers.list` row: the capability plus, optionally, a pack state. */
function providerState(
  loginCapability: ProviderLoginCapability | null,
  managedInstallState: ProviderCliState["managedInstallState"],
): ProviderCliState {
  return {
    providerId: "reasonix",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function stateWith(loginCapability: ProviderLoginCapability): ProviderCliState {
  return providerState(loginCapability, null);
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
      "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
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
  it("returns just the post-action steps when the action is right here on this surface ('here')", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    expect(providerSetupSteps(guidance, "here")).toEqual(
      guidance.stepsAfterAction,
    );
  });

  it("prepends the no-surface step when the action is on another surface ('other-surface')", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    expect(providerSetupSteps(guidance, "other-surface")).toEqual([
      guidance.noSurfaceStep,
      ...guidance.stepsAfterAction,
    ]);
  });

  it("returns just the post-action steps for 'unsupported-host' - never the no-surface step, since no host surface has the action at all", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    const steps = providerSetupSteps(guidance, "unsupported-host");
    expect(steps).toEqual(guidance.stepsAfterAction);
    expect(steps).not.toContain(guidance.noSurfaceStep);
  });
});

describe("resolveProviderTerminalSetup", () => {
  it("returns null for a provider with no declared capability and no guidance override (null row, copilot)", () => {
    expect(resolveProviderTerminalSetup("copilot", null)).toBeNull();
  });

  it("returns the default generic copy for a provider with the capability but no guidance override (copilot)", () => {
    const setup = resolveProviderTerminalSetup(
      "copilot",
      stateWith(capabilityWithTerminalLogin(["login"])),
    );
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(true);
    expect(setup?.guidance.terminalActionLabel).toBe("Sign in from a terminal");
    expect(setup?.guidance.manualCommand).toBeNull();
    expect(setup?.guidance.summary).toBe(
      "Copilot signs in from a terminal: it prints a sign-in code that only exists there.",
    );
  });

  it("returns the reasonix override, with canStartTerminal: true, for reasonix with the capability", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(true);
    expect(setup?.guidance.manualCommand).toBe("reasonix setup");
    expect(setup?.guidance.terminalActionLabel).toBe("Set up in terminal");
  });

  it("preserves reasonix's guidance with canStartTerminal: false when the capability is absent (oauthArgs empty) - the fix for old hosts losing Reasonix's manual instructions", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin([])),
    );
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(false);
    expect(setup?.guidance.manualCommand).toBe("reasonix setup");
    expect(setup?.guidance.summary).toBe(
      "Reasonix keeps provider API keys in its own store, not in your shell environment.",
    );
  });

  it("preserves reasonix's guidance with canStartTerminal: false when the row itself is null (not yet resolved)", () => {
    const setup = resolveProviderTerminalSetup("reasonix", null);
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(false);
    expect(setup?.guidance.manualCommand).toBe("reasonix setup");
  });

  it("returns null for copilot when the capability is absent (oauthArgs empty) - no copy-table override to fall back on", () => {
    expect(
      resolveProviderTerminalSetup(
        "copilot",
        stateWith(capabilityWithTerminalLogin([])),
      ),
    ).toBeNull();
  });
});

describe("providerSetupActionPlacement", () => {
  it("returns 'unsupported-host' whenever canStartTerminal is false, regardless of hasSurface", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin([])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(setup.canStartTerminal).toBe(false);
    expect(providerSetupActionPlacement(setup, true, true)).toBe(
      "unsupported-host",
    );
    expect(providerSetupActionPlacement(setup, false, true)).toBe(
      "unsupported-host",
    );
  });

  it("returns 'here' when canStartTerminal is true and this surface has the action", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(providerSetupActionPlacement(setup, true, true)).toBe("here");
  });

  it("returns 'unsupported-host' when the host cannot carry this surface's scope, even with a surface and the capability", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    // The provider row says yes and the surface exists; only the host's
    // negotiated `providers.startTerminalLogin` major says no. Reporting
    // 'here' would lead the steps with a button that can only ever fail.
    expect(providerSetupActionPlacement(setup, true, false)).toBe(
      "unsupported-host",
    );
  });

  it("returns 'preparing' when the capability and surface are there but the pack cannot spawn yet", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      providerState(capabilityWithTerminalLogin(["setup"]), {
        status: "downloading",
        percent: 30,
      }),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(setup.canStartTerminal).toBe(true);
    expect(setup.packPreparing).not.toBeNull();
    expect(providerSetupActionPlacement(setup, true, true)).toBe("preparing");
    // A transient wait never becomes "the button is on another surface".
    expect(providerSetupActionPlacement(setup, false, true)).toBe("preparing");
    // The wait reads as the same sentence every other gated surface shows.
    expect(providerSetupPreparingLabel(setup, "reasonix")).toBe(
      "Preparing Reasonix… 30%",
    );
    // Steps read as for `here`: that is what they will be once the pack lands.
    expect(providerSetupSteps(setup.guidance, "preparing")).toEqual(
      setup.guidance.stepsAfterAction,
    );
  });

  it("a downloading pack does NOT gate when a runnable fallback candidate exists", () => {
    const setup = resolveProviderTerminalSetup("reasonix", {
      ...providerState(capabilityWithTerminalLogin(["setup"]), {
        status: "downloading",
        percent: 30,
      }),
      candidates: [
        {
          kind: "path",
          path: "/usr/local/bin/reasonix",
          version: "1.35.0",
          available: true,
          versionPending: false,
        },
      ],
    });
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(setup.packPreparing).toBeNull();
    expect(providerSetupPreparingLabel(setup, "reasonix")).toBeNull();
    expect(providerSetupActionPlacement(setup, true, true)).toBe("here");
  });

  it("permanent reasons outrank the transient one: an unsupported scope on a preparing pack is 'unsupported-host'", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      providerState(capabilityWithTerminalLogin(["setup"]), {
        status: "downloading",
        percent: 30,
      }),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(providerSetupActionPlacement(setup, true, false)).toBe(
      "unsupported-host",
    );
  });

  it("returns 'other-surface' when canStartTerminal is true but this surface has no action", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(providerSetupActionPlacement(setup, false, true)).toBe(
      "other-surface",
    );
  });
});
