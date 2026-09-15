import { describe, expect, it } from "vitest";
import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  accountLineFor,
  buildWelcomeTiles,
  disablingLastEnabledFor,
  installStateFor,
  WELCOME_DETECTED_OFF_TOOLTIP,
  WELCOME_HOST_UNAVAILABLE_TOOLTIP,
  WELCOME_TRAYCER_OFF_TOOLTIP,
  WELCOME_UNAUTHENTICATED_TOOLTIP,
  type WelcomeTileModel,
} from "@/components/onboarding/welcome/welcome-providers-model";

const UNKNOWN_AUTH: ProviderAuth = {
  status: "unknown",
  badgeText: null,
  label: null,
  detail: null,
};

function candidatesFor(
  installed: boolean | "pending",
): ProviderCliState["candidates"] {
  if (installed === "pending") {
    return [
      {
        kind: "path",
        path: "/usr/bin/x",
        available: false,
        version: null,
        versionPending: true,
      },
    ];
  }
  if (installed) {
    return [
      {
        kind: "path",
        path: "/usr/bin/x",
        available: true,
        version: "1.0.0",
        versionPending: false,
      },
    ];
  }
  return [];
}

function providerState(input: {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly installed: boolean | "pending";
  readonly auth: ProviderAuth;
  readonly authPending: boolean;
  readonly apiKeyConfigured: boolean;
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: input.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: candidatesFor(input.installed),
    auth: input.auth,
    authPending: input.authPending,
    checkedAt: null,
    apiKey: {
      supported: true,
      configured: input.apiKeyConfigured,
      source: null,
    },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function detectedWith(
  providerId: ProviderId,
  enabled: boolean,
  auth: ProviderAuth,
  extra: { readonly authPending: boolean; readonly apiKey: boolean },
): ProviderCliState {
  return providerState({
    providerId,
    enabled,
    installed: true,
    auth,
    authPending: extra.authPending,
    apiKeyConfigured: extra.apiKey,
  });
}

function detected(
  providerId: ProviderId,
  enabled: boolean,
  auth: ProviderAuth,
): ProviderCliState {
  return detectedWith(providerId, enabled, auth, {
    authPending: false,
    apiKey: false,
  });
}

function only(tiles: ReadonlyArray<WelcomeTileModel>): WelcomeTileModel {
  const tile = tiles.at(0);
  if (tile === undefined || tiles.length !== 1) {
    throw new Error(`expected exactly one tile, got ${tiles.length}`);
  }
  return tile;
}

function tileFor(
  state: ProviderCliState | undefined,
  providerId: ProviderId,
  hostUnavailable: boolean,
): WelcomeTileModel {
  return only(
    buildWelcomeTiles({
      providers: state === undefined ? [] : [state],
      hostUnavailable,
      ids: [providerId],
    }),
  );
}

describe("installStateFor", () => {
  it("is pending for an unknown row, detected when any candidate is available, pending while the host's availability probe or a version read is outstanding, missing otherwise", () => {
    expect(installStateFor(undefined)).toBe("pending");
    // The shell-environment probe is still running: the (empty) candidates
    // under-report, so this is not "missing" yet.
    expect(
      installStateFor({
        ...providerState({
          providerId: "claude-code",
          enabled: true,
          installed: false,
          auth: UNKNOWN_AUTH,
          authPending: false,
          apiKeyConfigured: false,
        }),
        availabilityPending: true,
      }),
    ).toBe("pending");
    expect(installStateFor(detected("claude-code", true, UNKNOWN_AUTH))).toBe(
      "detected",
    );
    expect(
      installStateFor(
        providerState({
          providerId: "claude-code",
          enabled: true,
          installed: "pending",
          auth: UNKNOWN_AUTH,
          authPending: false,
          apiKeyConfigured: false,
        }),
      ),
    ).toBe("pending");
    expect(
      installStateFor(
        providerState({
          providerId: "claude-code",
          enabled: true,
          installed: false,
          auth: UNKNOWN_AUTH,
          authPending: false,
          apiKeyConfigured: false,
        }),
      ),
    ).toBe("missing");
  });
});

describe("accountLineFor", () => {
  it("spells each auth state as one line", () => {
    expect(accountLineFor(detected("traycer", true, UNKNOWN_AUTH)).text).toBe(
      "Ready with your Traycer subscription",
    );
    expect(accountLineFor(detected("codex", false, UNKNOWN_AUTH)).text).toBe(
      "Disabled",
    );
    expect(
      accountLineFor(
        detectedWith("codex", true, UNKNOWN_AUTH, {
          authPending: true,
          apiKey: false,
        }),
      ).text,
    ).toBe("Checking account…");
    expect(
      accountLineFor(
        detected("codex", true, {
          status: "authenticated",
          badgeText: null,
          label: "jane@example.com",
          detail: "Signed in as jane@example.com",
        }),
      ),
    ).toEqual({
      text: "jane@example.com",
      tone: "good",
      title: "Signed in as jane@example.com",
    });
    expect(
      accountLineFor(
        detected("codex", true, {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        }),
      ).text,
    ).toBe("Signed in");
    expect(
      accountLineFor(
        detected("codex", true, { ...UNKNOWN_AUTH, status: "configured" }),
      ).text,
    ).toBe("Configured, not verified");
    expect(
      accountLineFor(
        detected("codex", true, { ...UNKNOWN_AUTH, status: "unavailable" }),
      ).text,
    ).toBe("Status check failed");
    expect(
      accountLineFor(
        detected("codex", true, { ...UNKNOWN_AUTH, status: "unauthenticated" }),
      ).text,
    ).toBe("Not signed in");
    expect(
      accountLineFor(
        detectedWith("codex", true, UNKNOWN_AUTH, {
          authPending: false,
          apiKey: true,
        }),
      ).text,
    ).toBe("API key set");
    expect(accountLineFor(detected("codex", true, UNKNOWN_AUTH)).text).toBe(
      "Account status unavailable",
    );
  });
});

describe("disablingLastEnabledFor", () => {
  it("refuses only the switch that would turn off the last enabled provider", () => {
    const state = detected("codex", true, UNKNOWN_AUTH);
    expect(disablingLastEnabledFor(state, true, 1)).toBe(true);
    expect(disablingLastEnabledFor(state, true, 2)).toBe(false);
    expect(disablingLastEnabledFor(state, false, 1)).toBe(false);
    expect(disablingLastEnabledFor(undefined, true, 1)).toBe(false);
  });
});

describe("buildWelcomeTiles", () => {
  const AUTHED: ProviderAuth = {
    status: "authenticated",
    badgeText: null,
    label: "jane@example.com",
    detail: "Signed in as jane@example.com",
  };

  it.each<{
    readonly name: string;
    readonly state: ProviderCliState | undefined;
    readonly providerId: ProviderId;
    readonly hostUnavailable: boolean;
    readonly expected: Omit<WelcomeTileModel, "providerId" | "name">;
  }>([
    {
      name: "row undefined (list pending)",
      state: undefined,
      providerId: "codex",
      hostUnavailable: false,
      expected: {
        install: "pending",
        badge: "Detecting…",
        enabled: false,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: null,
        switchDisabled: true,
        dimmed: true,
      },
    },
    {
      name: "host unavailable",
      state: detected("codex", true, AUTHED),
      providerId: "codex",
      hostUnavailable: true,
      expected: {
        install: "unavailable",
        badge: "Unavailable",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: WELCOME_HOST_UNAVAILABLE_TOOLTIP,
        switchDisabled: true,
        dimmed: true,
      },
    },
    {
      name: "traycer, enabled",
      state: providerState({
        providerId: "traycer",
        enabled: true,
        installed: false,
        auth: UNKNOWN_AUTH,
        authPending: false,
        apiKeyConfigured: false,
      }),
      providerId: "traycer",
      hostUnavailable: false,
      expected: {
        install: "builtIn",
        badge: "Built in",
        enabled: true,
        subtitle: "Ready with your Traycer subscription",
        subtitleTone: "good",
        tooltip: null,
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      // Decision 26: connected + off. The subscription is the account, so
      // the ready line and full brightness stay; only the switch is off.
      name: "traycer, off",
      state: providerState({
        providerId: "traycer",
        enabled: false,
        installed: false,
        auth: UNKNOWN_AUTH,
        authPending: false,
        apiKeyConfigured: false,
      }),
      providerId: "traycer",
      hostUnavailable: false,
      expected: {
        install: "builtIn",
        badge: "Built in",
        enabled: false,
        subtitle: "Ready with your Traycer subscription",
        subtitleTone: "good",
        tooltip: WELCOME_TRAYCER_OFF_TOOLTIP,
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "install missing",
      state: providerState({
        providerId: "cursor",
        enabled: false,
        installed: false,
        auth: UNKNOWN_AUTH,
        authPending: false,
        apiKeyConfigured: false,
      }),
      providerId: "cursor",
      hostUnavailable: false,
      expected: {
        install: "missing",
        badge: "Not found",
        enabled: false,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "Install Cursor on this machine to use it.",
        switchDisabled: true,
        dimmed: true,
      },
    },
    {
      name: "install pending",
      state: providerState({
        providerId: "codex",
        enabled: true,
        installed: "pending",
        auth: UNKNOWN_AUTH,
        authPending: false,
        apiKeyConfigured: false,
      }),
      providerId: "codex",
      hostUnavailable: false,
      expected: {
        install: "pending",
        badge: "Detecting…",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: null,
        switchDisabled: true,
        dimmed: true,
      },
    },
    {
      name: "detected, off",
      state: detected("grok", false, UNKNOWN_AUTH),
      providerId: "grok",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: false,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: WELCOME_DETECTED_OFF_TOOLTIP,
        switchDisabled: false,
        dimmed: true,
      },
    },
    {
      name: "detected, enabled, auth pending",
      state: detectedWith(
        "codex",
        true,
        { ...UNKNOWN_AUTH, detail: "Probing" },
        { authPending: true, apiKey: false },
      ),
      providerId: "codex",
      hostUnavailable: false,
      // Decision 22: no label, no subtitle - the checking text is status,
      // and status lives in the tooltip.
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "Checking account…",
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, authenticated",
      state: detected("claude-code", true, AUTHED),
      providerId: "claude-code",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: "jane@example.com",
        subtitleTone: "good",
        tooltip: "Signed in as jane@example.com",
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, authenticated with no label",
      state: detected("claude-code", true, {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: "Signed in via OAuth",
      }),
      providerId: "claude-code",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "Signed in via OAuth",
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, authenticated with neither label nor detail",
      state: detected("claude-code", true, {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      }),
      providerId: "claude-code",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "Signed in",
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, unauthenticated",
      state: detected("claude-code", true, {
        ...UNKNOWN_AUTH,
        status: "unauthenticated",
      }),
      providerId: "claude-code",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: WELCOME_UNAUTHENTICATED_TOOLTIP,
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, configured",
      state: detected("opencode", true, {
        ...UNKNOWN_AUTH,
        status: "configured",
      }),
      providerId: "opencode",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "Configured, not verified",
        switchDisabled: false,
        dimmed: false,
      },
    },
    {
      name: "detected, enabled, API key",
      state: detectedWith("opencode", true, UNKNOWN_AUTH, {
        authPending: false,
        apiKey: true,
      }),
      providerId: "opencode",
      hostUnavailable: false,
      expected: {
        install: "detected",
        badge: "Installed",
        enabled: true,
        subtitle: null,
        subtitleTone: "muted",
        tooltip: "API key set",
        switchDisabled: false,
        dimmed: false,
      },
    },
  ])("$name", ({ state, providerId, hostUnavailable, expected }) => {
    const tile = tileFor(state, providerId, hostUnavailable);
    expect(tile).toEqual({ ...expected, providerId, name: tile.name });
  });

  it("keeps the requested order and names every tile", () => {
    const tiles = buildWelcomeTiles({
      providers: [detected("codex", true, AUTHED)],
      hostUnavailable: false,
      ids: ["cursor", "codex", "traycer"],
    });
    expect(tiles.map((tile) => tile.providerId)).toEqual([
      "cursor",
      "codex",
      "traycer",
    ]);
    expect(tiles.map((tile) => tile.name)).toEqual([
      "Cursor",
      "Codex",
      "Traycer Inference",
    ]);
    expect(tiles.map((tile) => tile.badge)).toEqual([
      "Detecting…",
      "Installed",
      "Detecting…",
    ]);
  });
});
