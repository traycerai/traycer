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
    },
    ...overrides,
  };
}

/**
 * The tooltip used to be one hardcoded sentence - "Sign in requires a local
 * host with browser sign-in available" - shown for every reason the button was
 * disabled. On a local host, which is most of them, that sentence is false, and
 * it is the same misdirection class `providerCliNotFoundMessage` exists to
 * kill: the user reads a precondition they already satisfy and has nowhere to
 * go.
 */
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
    expect(hint).not.toContain("local host");
  });

  it("explains the remote-host case in terms of what sign-in does", () => {
    const hint = providerSignInUnavailableHint(providerState({}), false);
    expect(hint).toContain("opens a browser on the machine running Traycer");
  });

  it("reports a blocking managed pack rather than a false host precondition", () => {
    // The case the old sentence got most wrong: a local host, a provider that
    // does support sign-in, and a pack that has not arrived. The user was told
    // to find a local host while sitting at one.
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

  // Row 1 of the terminal-login contract table (this consumer's half): the
  // hint must point at the terminal sign-in flow, not the generic
  // "does not support browser sign-in" message.
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

  // The real source of a "no key to check" capability is the optional chain
  // over `loginCapability` itself, not an old host's echo: the v6 -> v7
  // upgrade bridge (`registry.ts`) fills `terminalLogin: null` for exactly
  // that case, so a pre-terminal-login host's payload decodes with the key
  // present and `null` (the `NO_TERMINAL_LOGIN_CAP` case above), never absent.
  // `loginCapability` reads `null` for an API-key-only provider (Cursor,
  // Traycer) and `undefined` for one not yet loaded (a map lookup before
  // `providers.list` resolves) - both must read as "does not support terminal
  // login".
  it("is false when loginCapability itself is null", () => {
    expect(providerSupportsTerminalLogin(null)).toBe(false);
  });

  it("is false when loginCapability itself is undefined", () => {
    expect(providerSupportsTerminalLogin(undefined)).toBe(false);
  });

  // Unified gate: `oauthArgs` is the command the terminal runs, so a
  // provider advertising `terminalLogin` with no real command has nothing to
  // offer. This one check is what keeps the banner, the picker gate, and
  // this module's own `providerSignInUnavailableHint` from disagreeing about
  // the same provider (each used to re-check `oauthArgs` separately, in a
  // different order relative to its own `terminalLogin` branch).
  it("is false when terminalLogin is present but oauthArgs is empty or null", () => {
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: [],
        token: null,
        codePaste: null,
        terminalLogin: {},
      }),
    ).toBe(false);
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: null,
        token: null,
        codePaste: null,
        terminalLogin: {},
      }),
    ).toBe(false);
  });
});
