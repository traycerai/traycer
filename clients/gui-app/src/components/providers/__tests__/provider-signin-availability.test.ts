import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerSignInUnavailableHint,
  providerSupportsTerminalLogin,
} from "@/components/providers/provider-signin-availability";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows a `JSON.parse`d wire payload into `ProviderCliState["loginCapability"]`
 * without asserting `terminalLogin` is present - deliberately, since the whole
 * point of `oldHostLoginCapability` below is to model a shape that genuinely
 * lacks that key. `JSON.parse` alone returns `any`; parsing into `unknown`
 * first and narrowing through this predicate (rather than `as`) is what keeps
 * the fixture both honest and lint-clean.
 */
function looksLikeLoginCapability(
  value: unknown,
): value is ProviderCliState["loginCapability"] {
  return (
    isRecord(value) &&
    "oauthArgs" in value &&
    "token" in value &&
    "codePaste" in value
  );
}

function oldHostLoginCapability(
  raw: Record<string, unknown>,
): ProviderCliState["loginCapability"] {
  const parsed: unknown = JSON.parse(JSON.stringify(raw));
  if (!looksLikeLoginCapability(parsed)) {
    throw new Error("expected the fixture to at least resemble a capability");
  }
  return parsed;
}

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

  it("is false for a genuinely absent terminalLogin key (an old host's frozen-schema echo), not just null", () => {
    // The key is truly absent (`undefined`), not `null` - exactly what a
    // pre-terminal-login host's negotiated frozen schema decodes to.
    const preTerminalLogin = oldHostLoginCapability({
      oauthArgs: null,
      token: null,
      codePaste: null,
      terminalLogin: null,
    });
    expect(providerSupportsTerminalLogin(preTerminalLogin)).toBe(false);
  });

  it("is false when loginCapability itself is undefined", () => {
    expect(providerSupportsTerminalLogin(undefined)).toBe(false);
  });
});
