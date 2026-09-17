import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { ReceivedLoginCapability } from "@/components/providers/provider-signin-availability";
import {
  hostIsLocalForLoginAutoOpen,
  providerLoginIsRemoteSafe,
  providerSignInUnavailableHint,
  providerStartLoginFailureMessage,
  providerSupportsTerminalLogin,
  shouldAutoOpenLoginUrl,
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
      remoteSafe: null,
      selfOpensBrowser: null,
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
    expect(hint).toContain("Account tab");
    expect(hint).not.toContain("above");
    expect(hint).not.toContain("local host");
  });

  it("treats an empty-but-non-null oauthArgs as sign-in capable, not as no sign-in", () => {
    // The ACP-authenticate shape (antigravity): no `terminalLogin`, and a
    // headless sign-in that needs no login subcommand because the host spawns
    // the server and drives ACP `authenticate`. This used to read `null ||
    // length === 0` and answered the "does not support browser sign-in"
    // sentence, which disabled the button for the one provider whose argv is
    // legitimately empty. Distinct from the terminal-login rows below, which
    // are answered by the earlier branch whichever way their argv points -
    // this one has no `terminalLogin`, so it reaches the argv check.
    expect(
      providerSignInUnavailableHint(
        providerState({
          providerId: "antigravity",
          loginCapability: {
            oauthArgs: [],
            token: null,
            codePaste: null,
            terminalLogin: null,
            remoteSafe: null,
            selfOpensBrowser: null,
          },
        }),
        true,
      ),
    ).toBeNull();
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

  it("allows Claude code-paste sign-in on a remote host", () => {
    expect(
      providerSignInUnavailableHint(
        providerState({
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
            terminalLogin: null,
            remoteSafe: null,
            selfOpensBrowser: null,
          },
        }),
        false,
      ),
    ).toBeNull();
  });

  it("allows declared remote-safe sign-in on a remote host", () => {
    expect(
      providerSignInUnavailableHint(
        providerState({
          providerId: "codex",
          loginCapability: {
            oauthArgs: ["login", "--device-auth"],
            token: null,
            codePaste: null,
            terminalLogin: null,
            remoteSafe: {},
            selfOpensBrowser: null,
          },
        }),
        false,
      ),
    ).toBeNull();
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
          remoteSafe: null,
          selfOpensBrowser: null,
        },
      }),
      true,
    );
    expect(hint).toContain("signed in from a terminal");
    expect(hint).not.toContain("browser sign-in");
  });

  it.each([
    { providerId: "amp", name: "Amp", apiKeySupported: true },
    { providerId: "kiro", name: "Kiro", apiKeySupported: true },
    { providerId: "hermes", name: "Hermes Agent", apiKeySupported: false },
    { providerId: "kilocode", name: "Kilo Code", apiKeySupported: false },
  ] as const)(
    "points $providerId at both model pickers and only supported Account credentials",
    ({ providerId, name, apiKeySupported }) => {
      const state = providerState({
        providerId,
        apiKey: {
          supported: apiKeySupported,
          configured: false,
          source: null,
        },
        loginCapability: {
          oauthArgs: null,
          token: null,
          codePaste: null,
          terminalLogin: {},
          remoteSafe: null,
          selfOpensBrowser: null,
        },
      });
      const terminalHint = `${name} is signed in from a terminal. Open its model picker in a chat or on the start page and use the terminal sign-in there.`;
      for (const isSelectedHostLocal of [true, false]) {
        const hint = providerSignInUnavailableHint(state, isSelectedHostLocal);
        if (apiKeySupported) {
          expect(hint).toBe(
            `${terminalHint} Or set an API key on the Account tab.`,
          );
        } else {
          expect(hint).toBe(terminalHint);
          expect(hint).not.toContain("API key");
          expect(hint).not.toContain("Account tab");
        }
      }
    },
  );

  // A launch-the-CLI provider (Qwen, Droid, OMP, OpenCode) declares
  // `terminalLogin` with `oauthArgs: null` - there is no headless command.
  // The terminal branch must win over the "no browser sign-in, use its own
  // CLI" one: Traycer opens that CLI for the user.
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
            remoteSafe: null,
            selfOpensBrowser: null,
          },
        }),
        true,
      );
      expect(hint).toContain("Qwen Code is signed in from a terminal");
      expect(hint).not.toContain("its own CLI");
    },
  );
});

describe("providerLoginIsRemoteSafe", () => {
  it("uses the remote-safe marker rather than a device-auth argv flag", () => {
    const kimiCapability = {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      remoteSafe: {},
      selfOpensBrowser: null,
    };
    expect(providerLoginIsRemoteSafe(kimiCapability)).toBe(true);
    expect(
      providerSignInUnavailableHint(
        providerState({ providerId: "kimi", loginCapability: kimiCapability }),
        false,
      ),
    ).toBeNull();
    expect(
      providerLoginIsRemoteSafe({
        ...kimiCapability,
        oauthArgs: ["login", "--device-auth"],
        remoteSafe: null,
        selfOpensBrowser: null,
      }),
    ).toBe(false);
    expect(
      providerLoginIsRemoteSafe({ ...kimiCapability, remoteSafe: null }),
    ).toBe(false);
    expect(providerLoginIsRemoteSafe(null)).toBe(false);
    expect(providerLoginIsRemoteSafe(undefined)).toBe(false);
  });

  it("treats a capability with no remoteSafe key as not remote-safe", () => {
    // Not a hypothetical shape. Both response decoders return the payload by
    // cast when the peers agree on the major and the client's minor is not
    // ahead (`clientCanonical.minor <= hostCanonical.minor`), so no parse runs
    // and `.catch(null)` never supplies its default. `providers.list@9.1` is
    // unreleased and was widened in place, so a host built before these
    // markers landed answers on that very same 9.1 with the key absent - and
    // no upgrade bridge runs, because by version the two peers already agree.
    //
    // No cast is needed to express this, which is the point of
    // `ReceivedLoginCapability`: the wire shape is a real type, so a payload
    // with the key genuinely absent is something the checker accepts and a
    // reader can see. Writing `remoteSafe: undefined` would not be the same
    // test - it satisfies the parsed type and describes a host that sent the
    // key, rather than one that has never heard of it.
    const unparsedFromOlderNinePointOneHost: ReceivedLoginCapability = {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    };

    expect(providerLoginIsRemoteSafe(unparsedFromOlderNinePointOneHost)).toBe(
      false,
    );

    // The control: the same payload from a host that DOES send the marker is
    // still remote-safe, so the guard above is refusing absence rather than
    // refusing everything.
    expect(
      providerLoginIsRemoteSafe({
        ...unparsedFromOlderNinePointOneHost,
        remoteSafe: {},
        selfOpensBrowser: null,
      }),
    ).toBe(true);
  });
});

const TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: {},
  remoteSafe: null,
  selfOpensBrowser: null,
};

const NO_TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
  remoteSafe: null,
  selfOpensBrowser: null,
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

  // The command the terminal runs is host-owned, not `oauthArgs` - that is
  // the HEADLESS command, and the providers whose sign-in lives inside their
  // own TUI (Qwen, Droid, OMP, OpenCode) ship `terminalLogin` with
  // `oauthArgs: null` so a client predating the field never offers them a
  // headless button. This helper once required `oauthArgs` too, which hid
  // the terminal button for exactly those four.
  it("is true when terminalLogin is present even though oauthArgs is null or empty", () => {
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: null,
        token: null,
        codePaste: null,
        terminalLogin: {},
        remoteSafe: null,
        selfOpensBrowser: null,
      }),
    ).toBe(true);
    expect(
      providerSupportsTerminalLogin({
        oauthArgs: [],
        token: null,
        codePaste: null,
        terminalLogin: {},
        remoteSafe: null,
        selfOpensBrowser: null,
      }),
    ).toBe(true);
  });
});

describe("shouldAutoOpenLoginUrl", () => {
  // NonNullable, not the bare field type: the field is nullable, and spreading
  // a possibly-null value into an object literal below would silently drop
  // every required key rather than failing at the spread.
  const capability = (
    selfOpensBrowser: Record<string, never> | null,
  ): NonNullable<ProviderCliState["loginCapability"]> => ({
    oauthArgs: ["login"],
    token: null,
    codePaste: null,
    terminalLogin: null,
    remoteSafe: null,
    selfOpensBrowser,
  });

  it("auto-opens on a remote host even when the child opens its own browser", () => {
    // The host's browser is on a machine the user cannot see, so whatever the
    // child does there is invisible. This branch never reads the marker.
    expect(shouldAutoOpenLoginUrl(false, capability({}))).toBe(true);
    expect(shouldAutoOpenLoginUrl(false, capability(null))).toBe(true);
  });

  it("does not auto-open on a local host when the child opens its own browser", () => {
    // THE regression pin. Before the marker this read `userCode !== null`, and
    // Kimi - which runs a device-code flow AND opens the browser itself -
    // therefore got a second consent tab the moment the host keyed it
    // device-auth. Written against a provider that is BOTH, because a provider
    // that is only self-opening passed the old predicate too and so cannot
    // tell the two implementations apart.
    const kimiShaped: ProviderCliState["loginCapability"] = {
      ...capability({}),
      remoteSafe: {},
    };
    expect(shouldAutoOpenLoginUrl(true, kimiShaped)).toBe(false);
  });

  it("auto-opens on a local host when the child does not open a browser", () => {
    // Codex and Grok print a URL and a code for the GUI to open; Antigravity
    // prints a consent link that is the flow's only affordance. All three are
    // `null` here, and all three must get a tab.
    expect(shouldAutoOpenLoginUrl(true, capability(null))).toBe(true);
  });

  it("auto-opens when there is no capability to read", () => {
    // The fail-safe direction: a duplicate tab is a nuisance, no tab at all is
    // a dead end, so an unknown answer opens.
    //
    // The genuinely ABSENT key is not expressible here - the field is required
    // on the live type - and it is not this test's job: an old host's payload
    // reaches the client through the v8->v9 bridge, which fills `null`. That
    // fill is pinned in the protocol suite
    // (`provider-login-remote-safe-marker.test.ts`), and the predicate's
    // `?? null` is the belt to that braces.
    expect(shouldAutoOpenLoginUrl(true, null)).toBe(true);
    expect(shouldAutoOpenLoginUrl(true, undefined)).toBe(true);
  });
});

describe("hostIsLocalForLoginAutoOpen", () => {
  const directory = [
    { hostId: "local-1", kind: "local" },
    { hostId: "remote-1", kind: "remote" },
  ];

  it("follows the app-wide default when the captured host id is null", () => {
    expect(hostIsLocalForLoginAutoOpen(directory, null, "remote-1")).toBe(
      false,
    );
    expect(hostIsLocalForLoginAutoOpen(directory, null, "local-1")).toBe(true);
  });

  it("prefers the captured host id over the default", () => {
    expect(hostIsLocalForLoginAutoOpen(directory, "remote-1", "local-1")).toBe(
      false,
    );
    expect(hostIsLocalForLoginAutoOpen(directory, "local-1", "remote-1")).toBe(
      true,
    );
  });

  it("fails closed as local when the resolved host is missing", () => {
    expect(hostIsLocalForLoginAutoOpen(directory, null, null)).toBe(true);
    expect(hostIsLocalForLoginAutoOpen(directory, "gone", "remote-1")).toBe(
      true,
    );
  });
});

describe("providerStartLoginFailureMessage", () => {
  it("names a ChatGPT workspace that has not enabled device-code login", () => {
    expect(
      providerStartLoginFailureMessage(
        "device_auth_unavailable",
        "Sign-in did not start.",
      ),
    ).toContain("Device-code login is not enabled");
  });

  it("names a missing device code instead of provider-unavailable copy", () => {
    expect(
      providerStartLoginFailureMessage(
        "device_code_missing",
        "Sign-in did not start.",
      ),
    ).toContain("did not print a device code");
  });
});
