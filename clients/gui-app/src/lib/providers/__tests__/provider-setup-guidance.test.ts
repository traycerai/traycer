import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderLoginCapability,
} from "@traycer/protocol/host/provider-schemas";
import {
  defaultTerminalSignInGuidance,
  PROVIDER_SETUP_GUIDANCE,
  providerSetupActionPlacement,
  providerSetupGuidance,
  providerSetupPreparingLabel,
  providerSetupSteps,
  providerTerminalGuidance,
  resolveProviderTerminalSetup,
  TERMINAL_SIGN_IN_COPY,
} from "@/lib/providers/provider-setup-guidance";

function capabilityWithTerminalLogin(
  oauthArgs: ReadonlyArray<string> | null,
): ProviderLoginCapability {
  return {
    oauthArgs: oauthArgs === null ? null : [...oauthArgs],
    token: null,
    codePaste: null,
    terminalLogin: {},
    remoteSafe: null,
    selfOpensBrowser: null,
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

  it("returns hermes's setup guidance with the manual 'hermes setup model' command and three post-action steps", () => {
    const guidance = providerSetupGuidance("hermes");
    expect(guidance).not.toBeNull();
    expect(guidance?.manualCommand).toBe("hermes setup model");
    expect(guidance?.summary).toBe(
      "Hermes Agent keeps provider API keys in its own store, not in your shell environment.",
    );
    expect(guidance?.stepsAfterAction).toEqual([
      "Choose your inference provider from the list in that terminal.",
      "Give that provider an API key when Hermes asks for one.",
      "Refresh this list.",
    ]);
    expect(guidance?.stepsAfterAction).toHaveLength(3);
    expect(guidance?.noSurfaceStep).toBe(
      "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Hermes' setup wizard on the host that composer runs on.",
    );
    expect(guidance?.epicOnlyStep).toBe(
      "Open a chat and choose “Set up in terminal” from its model picker. This host's version can open Hermes' setup wizard from a chat, but not from the start page.",
    );
    expect(guidance?.terminalActionLabel).toBe("Set up in terminal");
    expect(guidance?.terminalHint).toBe(
      "Hermes asks for an inference provider and its API key in that terminal. Finish there, then use Refresh above.",
    );
    expect(providerTerminalGuidance("hermes")).toEqual(guidance);
  });

  it("returns null for a provider with no guidance entry (cursor)", () => {
    expect(providerSetupGuidance("cursor")).toBeNull();
  });
});

describe("TERMINAL_SIGN_IN_COPY", () => {
  it("re-words Kilo Code like OpenCode: a terminal picker, generic sign-in labels, no manual command", () => {
    const guidance = providerTerminalGuidance("kilocode");
    expect(providerSetupGuidance("kilocode")).toBeNull();
    expect(guidance.summary).toBe(
      "Kilo Code signs in from a terminal, one provider account at a time.",
    );
    expect(guidance.stepsAfterAction).toEqual([
      "Pick the provider and sign-in method in that terminal and follow the prompts.",
      "Refresh this list.",
    ]);
    expect(guidance.terminalHint).toBe(
      "Kilo Code asks for the provider and sign-in method in that terminal. Complete it there, then use Refresh above.",
    );
    expect(guidance.terminalActionLabel).toBe("Sign in from a terminal");
    expect(guidance.manualCommand).toBeNull();
  });

  it("re-words Amp around a printed sign-in link that finishes in the terminal, without promising a code paste or that a browser opens", () => {
    const guidance = providerTerminalGuidance("amp");
    expect(providerSetupGuidance("amp")).toBeNull();
    expect(guidance.summary).toBe(
      "Amp signs in from a terminal: it prints a sign-in link, and finishes in that terminal.",
    );
    expect(guidance.summary).not.toContain("opens your browser");
    expect(guidance.stepsAfterAction).toEqual([
      "Open the link that terminal prints — on your own machine Amp may open it for you — then follow it through and answer whatever the terminal asks for next.",
      "Refresh this list.",
    ]);
    expect(guidance.stepsAfterAction[0]).not.toMatch(/paste/i);
    expect(guidance.terminalHint).toBe(
      "Amp prints a sign-in link and waits in that terminal. Finish there, then use Refresh above.",
    );
    expect(guidance.terminalActionLabel).toBe("Sign in from a terminal");
    expect(guidance.manualCommand).toBeNull();
  });

  it("re-words Kiro around choosing an account first, without requiring every arm to print a link", () => {
    const guidance = providerTerminalGuidance("kiro");
    expect(providerSetupGuidance("kiro")).toBeNull();
    expect(guidance.summary).toBe(
      "Kiro signs in from a terminal, and asks which account to use first.",
    );
    expect(guidance.stepsAfterAction).toEqual([
      "Choose a sign-in method in that terminal, then follow what it shows — for a social account that is a link to open and a code to confirm.",
      "Refresh this list.",
    ]);
    expect(guidance.terminalHint).toBe(
      "Kiro asks which account to use in that terminal, then walks you through that account's sign-in. Finish there, then use Refresh above.",
    );
    expect(guidance.terminalActionLabel).toBe("Sign in from a terminal");
    expect(guidance.manualCommand).toBeNull();
  });
});

describe("provider guidance table exclusivity", () => {
  // `providerTerminalGuidance` returns a PROVIDER_SETUP_GUIDANCE override
  // outright and never consults TERMINAL_SIGN_IN_COPY, so a provider in both
  // silently drops the copy-table half.
  it("does not let any provider carry both a PROVIDER_SETUP_GUIDANCE override and a TERMINAL_SIGN_IN_COPY entry", () => {
    const overlap = Object.keys(PROVIDER_SETUP_GUIDANCE).filter((id) =>
      Object.hasOwn(TERMINAL_SIGN_IN_COPY, id),
    );
    expect(overlap).toEqual([]);
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

  it("leads with the epic-only step for 'unsupported-scope' - the post-action steps alone would say to finish in a terminal nothing here opened", () => {
    const guidance = providerSetupGuidance("reasonix");
    expect(guidance).not.toBeNull();
    if (guidance === null) return;
    const steps = providerSetupSteps(guidance, "unsupported-scope");
    expect(steps).toEqual([
      guidance.epicOnlyStep,
      ...guidance.stepsAfterAction,
    ]);
    // Not the no-surface sentence: that one names the start page as a place
    // the button exists, which on this host it does not.
    expect(steps).not.toContain(guidance.noSurfaceStep);
  });

  it("gives the generic guidance an epic-only step too, so a provider with no manual command (copilot) still has a route", () => {
    const guidance = defaultTerminalSignInGuidance("copilot");
    expect(guidance.manualCommand).toBeNull();
    expect(providerSetupSteps(guidance, "unsupported-scope")[0]).toBe(
      "Open a chat and choose “Sign in from a terminal” from its model picker. This host's version can open the Copilot sign-in from a chat, but not from the start page.",
    );
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

  it("returns the hermes override, with canStartTerminal: true, for hermes with the capability", () => {
    const setup = resolveProviderTerminalSetup(
      "hermes",
      stateWith(capabilityWithTerminalLogin(["setup", "model"])),
    );
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(true);
    expect(setup?.guidance.manualCommand).toBe("hermes setup model");
    expect(setup?.guidance.terminalActionLabel).toBe("Set up in terminal");
  });

  it("preserves hermes's guidance with canStartTerminal: false when the capability is absent", () => {
    const setup = resolveProviderTerminalSetup(
      "hermes",
      stateWith({
        ...capabilityWithTerminalLogin(["setup", "model"]),
        terminalLogin: null,
      }),
    );
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(false);
    expect(setup?.guidance.manualCommand).toBe("hermes setup model");
    expect(setup?.guidance.summary).toBe(
      "Hermes Agent keeps provider API keys in its own store, not in your shell environment.",
    );
  });

  it("preserves hermes's guidance with canStartTerminal: false when the row itself is null", () => {
    const setup = resolveProviderTerminalSetup("hermes", null);
    expect(setup).not.toBeNull();
    expect(setup?.canStartTerminal).toBe(false);
    expect(setup?.guidance.manualCommand).toBe("hermes setup model");
  });

  it.each(["kilocode", "amp", "kiro"] as const)(
    "gives %s the terminal-sign-in copy when the capability is present, and nothing when it is absent",
    (providerId: ProviderId) => {
      const withCapability = resolveProviderTerminalSetup(
        providerId,
        stateWith(capabilityWithTerminalLogin(["login"])),
      );
      expect(withCapability).not.toBeNull();
      expect(withCapability?.canStartTerminal).toBe(true);
      expect(withCapability?.guidance).toEqual(
        providerTerminalGuidance(providerId),
      );
      expect(withCapability?.guidance.terminalActionLabel).toBe(
        "Sign in from a terminal",
      );
      expect(withCapability?.guidance.manualCommand).toBeNull();

      expect(
        resolveProviderTerminalSetup(
          providerId,
          stateWith({
            ...capabilityWithTerminalLogin(["login"]),
            terminalLogin: null,
          }),
        ),
      ).toBeNull();
      expect(resolveProviderTerminalSetup(providerId, null)).toBeNull();
    },
  );

  it("preserves reasonix's guidance with canStartTerminal: false when the capability is absent (terminalLogin null) - the fix for old hosts losing Reasonix's manual instructions", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith({
        ...capabilityWithTerminalLogin(["setup"]),
        terminalLogin: null,
      }),
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

  it("returns null for copilot when the capability is absent (terminalLogin null) - no copy-table override to fall back on", () => {
    expect(
      resolveProviderTerminalSetup(
        "copilot",
        stateWith({
          ...capabilityWithTerminalLogin(["login"]),
          terminalLogin: null,
        }),
      ),
    ).toBeNull();
  });

  // The launch-the-CLI providers declare `terminalLogin` with `oauthArgs:
  // null` (no headless command; the host launches the CLI itself). They get
  // the terminal action on that capability alone, with the generic guidance
  // re-worded to name the step inside the CLI - and, like copilot, nothing at
  // all on a host that declares no capability.
  it.each([{ oauthArgs: null }, { oauthArgs: [] }])(
    "gives a launch-the-CLI provider (qwen, no oauthArgs %o) the terminal action with copy naming the in-CLI step",
    ({ oauthArgs }) => {
      const setup = resolveProviderTerminalSetup(
        "qwen",
        stateWith(capabilityWithTerminalLogin(oauthArgs)),
      );
      expect(setup).not.toBeNull();
      expect(setup?.canStartTerminal).toBe(true);
      expect(setup?.guidance.terminalActionLabel).toBe(
        "Sign in from a terminal",
      );
      expect(setup?.guidance.manualCommand).toBeNull();
      expect(setup?.guidance.summary).toBe(
        "Qwen Code signs in from inside its own terminal UI.",
      );
      expect(setup?.guidance.stepsAfterAction).toEqual([
        "Type /auth in that terminal, choose a sign-in method and finish in the browser.",
        "Refresh this list.",
      ]);
      expect(setup?.guidance.terminalHint).toContain("Type /auth");
      expect(setup?.guidance.summary).not.toContain("sign-in code");
    },
  );

  it("names the in-CLI step for each launch-the-CLI provider and keeps the generic labels", () => {
    for (const [providerId, step] of [
      ["droid", "Follow the sign-in prompt Droid shows when it starts."],
      [
        "omp",
        "Type login followed by the provider (for example login anthropic) in that terminal and follow the prompts.",
      ],
      [
        "opencode",
        "Pick the provider and sign-in method in that terminal and follow the prompts.",
      ],
    ] as const) {
      const guidance = defaultTerminalSignInGuidance(providerId);
      expect(guidance.stepsAfterAction, providerId).toEqual([
        step,
        "Refresh this list.",
      ]);
      expect(guidance.terminalActionLabel, providerId).toBe(
        "Sign in from a terminal",
      );
      expect(guidance.summary, providerId).not.toContain("sign-in code");
      expect(guidance.terminalHint, providerId).not.toContain("sign-in code");
      expect(guidance.manualCommand, providerId).toBeNull();
    }
  });

  it("returns null for a launch-the-CLI provider on a host that declares no capability", () => {
    expect(
      resolveProviderTerminalSetup(
        "droid",
        stateWith({
          ...capabilityWithTerminalLogin(null),
          terminalLogin: null,
        }),
      ),
    ).toBeNull();
  });
});

describe("providerSetupActionPlacement", () => {
  it("returns 'unsupported-host' whenever canStartTerminal is false, regardless of hasSurface", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith({
        ...capabilityWithTerminalLogin(["setup"]),
        terminalLogin: null,
      }),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(setup.canStartTerminal).toBe(false);
    expect(providerSetupActionPlacement(setup, true, "supported")).toBe(
      "unsupported-host",
    );
    expect(providerSetupActionPlacement(setup, false, "supported")).toBe(
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
    expect(providerSetupActionPlacement(setup, true, "supported")).toBe("here");
  });

  it("returns 'unsupported-scope' when the host cannot carry this surface's scope, even with a surface and the capability", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    // The provider row says yes and the surface exists; only the host's
    // negotiated `providers.startTerminalLogin` major says no. Reporting
    // 'here' would lead the steps with a button that can only ever fail, and
    // 'unsupported-host' would lead with nothing - but this host DOES draw
    // the button, in an Epic, and the steps have to say so.
    expect(providerSetupActionPlacement(setup, true, "unsupported")).toBe(
      "unsupported-scope",
    );
  });

  it("returns 'unsupported-host', not 'unsupported-scope', while the host's scope support is unknown", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    // No manifest recorded, or no host at all: the button stays hidden, but
    // the epic-only sentence claims this host negotiated the pre-scope major,
    // which nothing has proven. The claim-free copy leads with the manual
    // route instead.
    expect(providerSetupActionPlacement(setup, true, "unknown")).toBe(
      "unsupported-host",
    );
    expect(providerSetupActionPlacement(setup, false, "unknown")).toBe(
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
    expect(providerSetupActionPlacement(setup, true, "supported")).toBe(
      "preparing",
    );
    // A transient wait never becomes "the button is on another surface".
    expect(providerSetupActionPlacement(setup, false, "supported")).toBe(
      "preparing",
    );
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
    expect(providerSetupActionPlacement(setup, true, "supported")).toBe("here");
  });

  it("permanent reasons outrank the transient one: an unsupported scope on a preparing pack is 'unsupported-scope'", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      providerState(capabilityWithTerminalLogin(["setup"]), {
        status: "downloading",
        percent: 30,
      }),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(providerSetupActionPlacement(setup, true, "unsupported")).toBe(
      "unsupported-scope",
    );
  });

  it("returns 'other-surface' when canStartTerminal is true but this surface has no action", () => {
    const setup = resolveProviderTerminalSetup(
      "reasonix",
      stateWith(capabilityWithTerminalLogin(["setup"])),
    );
    expect(setup).not.toBeNull();
    if (setup === null) return;
    expect(providerSetupActionPlacement(setup, false, "supported")).toBe(
      "other-surface",
    );
  });
});
