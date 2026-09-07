import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerSignInUnavailableHint,
  providerSupportsTerminalLogin,
} from "@/components/providers/provider-signin-availability";

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [
      {
        kind: "bundled",
        path: "/opt/traycer/bin/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    },
    availabilityPending: false,
    profiles: [],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    ...overrides,
  };
}

/** On a local host, which is most of them, that sentence is false, and it is the same misdirection class
 * `providerCliNotFoundMessage` exists to kill. */
describe("providerSignInUnavailableHint", () => {
  it("is null when sign-in actually works", () => {
    expect(providerSignInUnavailableHint(providerState({}), true)).toBeNull();
  });

  it("names the provider's own capability before anything situational", () => {
    // A permanent property outranks a fixable one: telling this user to switch
    // hosts would send them somewhere that changes nothing.
    const hint = providerSignInUnavailableHint(
      providerState({ loginCapability: null }),
      false,
    );
    expect(hint).toContain("does not support browser sign-in");
    expect(hint).toContain("Account tab");
    expect(hint).not.toContain("above");
    expect(hint).not.toContain("local host");
  });

  it("does not invent a CLI or API-key path for traycer", () => {
    const hint = providerSignInUnavailableHint(
      providerState({ providerId: "traycer", loginCapability: null }),
      true,
    );
    expect(hint).toContain("does not support browser sign-in");
    expect(hint).not.toContain("CLI");
    expect(hint).not.toContain("API key");
  });

  it("explains the remote-host case in terms of what sign-in does", () => {
    const hint = providerSignInUnavailableHint(providerState({}), false);
    expect(hint).toContain("opens a browser on the machine running Traycer");
  });

  it("reports a blocking managed pack rather than a false host precondition", () => {
    // The user was told to find a local host while sitting at one.
    const hint = providerSignInUnavailableHint(
      providerState({
        candidates: [],
        managedInstallState: { status: "downloading", percent: 30 },
      }),
      true,
    );
    expect(hint).toContain("30%");
    expect(hint).not.toContain("local host");
  });

  it("does not withhold sign-in for a pack that blocks nothing", () => {
    // A managed pack downloading behind a runnable binary takes nothing away -
    // the login spawns whatever the resolver spawns.
    expect(
      providerSignInUnavailableHint(
        providerState({
          managedInstallState: { status: "downloading", percent: 30 },
        }),
        true,
      ),
    ).toBeNull();
  });

  // Row 1 of the terminal-login contract table (this consumer's half): the hint must point at the terminal
  // sign-in flow, not the generic "does not support browser sign-in" message.
  it("points at the terminal sign-in flow for a terminal-login provider, not 'browser sign-in'", () => {
    const hint = providerSignInUnavailableHint(
      providerState({
        loginCapability: {
          oauthArgs: ["auth", "login"],
          token: null,
          codePaste: null,
          terminalLogin: {},
        },
      }),
      true,
    );
    expect(hint).toContain("signed in from a terminal");
    expect(hint).not.toContain("browser sign-in");
  });

  // The terminal branch must win over the "no browser sign-in, use its own CLI" one: Traycer opens that CLI for
  // the user.
  it.each([{ oauthArgs: null }, { oauthArgs: [] }])(
    "points at the terminal sign-in flow for a terminal-login provider with no oauthArgs (%o)",
    ({ oauthArgs }) => {
      const hint = providerSignInUnavailableHint(
        providerState({
          providerId: "qwen",
          loginCapability: {
            oauthArgs,
            token: null,
            codePaste: null,
            terminalLogin: {},
          },
        }),
        true,
      );
      expect(hint).toContain("Qwen Code is signed in from a terminal");
      expect(hint).not.toContain("its own CLI");
    },
  );
});

const TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: {},
};

const NO_TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
};

describe("providerSupportsTerminalLogin", () => {
  it("is true only when terminalLogin is present and non-null", () => {
    expect(providerSupportsTerminalLogin(TERMINAL_LOGIN_CAP)).toBe(true);
    expect(providerSupportsTerminalLogin(NO_TERMINAL_LOGIN_CAP)).toBe(false);
  });

  // `loginCapability` reads `null` for an API-key-only provider (Cursor, Traycer) and `undefined` for one not
  // yet loaded (a map lookup before `providers.list` resolves).
  it("is false when loginCapability itself is null", () => {
    expect(providerSupportsTerminalLogin(null)).toBe(false);
  });

  it("is false when loginCapability itself is undefined", () => {
    expect(providerSupportsTerminalLogin(undefined)).toBe(false);
  });

  // The command the terminal runs is host-owned, not `oauthArgs`.
  it("is true when terminalLogin is present even though oauthArgs is null or empty", () => {
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: null,
        token: null,
        codePaste: null,
        terminalLogin: {},
      }),
    ).toBe(true);
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: [],
        token: null,
        codePaste: null,
        terminalLogin: {},
      }),
    ).toBe(true);
  });
});
