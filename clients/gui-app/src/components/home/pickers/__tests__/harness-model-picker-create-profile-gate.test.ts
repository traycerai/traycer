import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { resolveCreateProfileGate } from "@/components/home/pickers/harness-model-picker-create-profile-gate";

const OAUTH_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
  remoteSafe: null,
  selfOpensBrowser: null,
};

const TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: {},
  remoteSafe: null,
  selfOpensBrowser: null,
};

// The gate now takes the whole `providers.list` row, not just its
// `loginCapability`, so it can also ask whether the host would act on the
// click at all (`providerHostBlock`). Every test builds one of these rather
// than a bare capability; the default is an enabled provider with one
// available candidate, so a test that only cares about the argv/host checks
// never trips the host-block branch by accident.
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
    loginCapability: OAUTH_CAP,
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

describe("resolveCreateProfileGate", () => {
  it("allows creating a profile on a local host with browser sign-in", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ loginCapability: OAUTH_CAP }),
    );
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  // Row 1 of the terminal-login contract table (this consumer's third):
  // a terminal-login provider is disabled here (the picker only drives
  // browser OAuth), with copy that names the terminal, not "browser sign-in".
  it("disables profile creation for a terminal-login provider without saying 'browser sign-in'", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ loginCapability: TERMINAL_LOGIN_CAP }),
    );
    expect(gate.disabled).toBe(true);
    expect(gate.reason).not.toContain("browser sign-in");
    expect(gate.reason).toContain("terminal");
  });

  // An ACP-authenticate provider (antigravity) has no `terminalLogin` and a
  // headless sign-in that needs no login subcommand - the host spawns the
  // server and drives ACP `authenticate` - so its argv is legitimately `[]`.
  // The gate read `oauthArgs === null || oauthArgs.length === 0` and disabled
  // Create profile for exactly that provider, with copy telling the user to
  // find a local host they were already on.
  it("allows creating a profile when oauthArgs is empty but non-null", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({
        loginCapability: {
          oauthArgs: [],
          token: null,
          codePaste: null,
          terminalLogin: null,
          remoteSafe: null,
          selfOpensBrowser: null,
        },
      }),
    );
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  // Retitled: this row used to say "for --device-auth" and passed because the
  // gate sniffed that flag out of `oauthArgs`. It no longer does - the host
  // declares `remoteSafe` and the flag says nothing to the client - so the
  // marker is what this row asserts, and the argv below is retained only as a
  // decoy proving the sniff is really gone.
  it("allows creating a profile on a remote host for a remote-safe flow", () => {
    const gate = resolveCreateProfileGate(
      null,
      false,
      providerState({
        loginCapability: {
          oauthArgs: ["login", "--device-auth"],
          token: null,
          codePaste: null,
          terminalLogin: null,
          remoteSafe: {},
          selfOpensBrowser: null,
        },
      }),
    );
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  // The mirror of the row above, and the one that would have caught the
  // codex/grok regression: the same argv WITHOUT the marker must be refused.
  it("refuses a remote host for --device-auth argv with no remote-safe marker", () => {
    const gate = resolveCreateProfileGate(
      null,
      false,
      providerState({
        loginCapability: {
          oauthArgs: ["login", "--device-auth"],
          token: null,
          codePaste: null,
          terminalLogin: null,
          remoteSafe: null,
          selfOpensBrowser: null,
        },
      }),
    );
    expect(gate.disabled).toBe(true);
  });

  it("allows creating a profile on a remote host for code-paste", () => {
    const gate = resolveCreateProfileGate(
      null,
      false,
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
    );
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  it("still requires a local host when oauthArgs is empty but non-null", () => {
    // The host check is orthogonal and must survive the argv relaxation: an
    // empty argv is a sign-in the HOST performs, so the loopback constraint is
    // unchanged.
    const gate = resolveCreateProfileGate(
      null,
      false,
      providerState({
        loginCapability: {
          oauthArgs: [],
          token: null,
          codePaste: null,
          terminalLogin: null,
          remoteSafe: null,
          selfOpensBrowser: null,
        },
      }),
    );
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });

  // `providerSupportsTerminalLogin` answers false for both a null and an
  // undefined capability, so the terminal-login branch above must fall
  // through cleanly to the generic reason instead of throwing or matching on
  // `undefined.oauthArgs`. This is the case the ordering comment ("safe
  // against a null/absent capability") in the source claims but the suite
  // never exercised.
  it("falls through to the generic reason for a null loginCapability", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ loginCapability: null }),
    );
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });

  // The row itself hasn't arrived yet - `providers.list` has not resolved for
  // this provider. `state?.loginCapability` reads undefined the same way a
  // null capability does, so this must fall through to the same generic
  // reason rather than throwing on an unresolved row.
  it("falls through to the generic reason for an unresolved row (state undefined)", () => {
    const gate = resolveCreateProfileGate(null, true, undefined);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });

  // A launch-the-CLI provider (Qwen, Droid, OMP, OpenCode) declares
  // `terminalLogin` with `oauthArgs: null`. The terminal reason must still
  // win: the generic one names browser sign-in, which these providers do not
  // do either. `[]` is covered beside `null` to prove the terminal branch is
  // answered BEFORE the argv is even read - the two spellings mean different
  // things past that branch (see the empty-argv test above), so a regression
  // that reordered the two checks would change this row's answer for `[]`.
  it.each([{ oauthArgs: null }, { oauthArgs: [] }])(
    "uses the terminal reason for a terminal-login provider with no oauthArgs (%o)",
    ({ oauthArgs }) => {
      const gate = resolveCreateProfileGate(
        null,
        true,
        providerState({
          loginCapability: {
            oauthArgs,
            token: null,
            codePaste: null,
            terminalLogin: {},
            remoteSafe: null,
            selfOpensBrowser: null,
          },
        }),
      );
      expect(gate.disabled).toBe(true);
      expect(gate.reason).toBe(
        "This provider is signed in from a terminal, not the browser.",
      );
    },
  );

  // The three outcomes of the row-level host gate (`providerHostBlock`),
  // reached only once the permanent argv/host checks above have passed.

  it("is not disabled for an enabled row with an available candidate", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ loginCapability: OAUTH_CAP }),
    );
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  it("disables profile creation for a disabled provider, with the host-block label as reason", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ enabled: false, loginCapability: OAUTH_CAP }),
    );
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Claude Code is turned off. Turn it on to sign in or manage its profiles.",
    );
  });

  it("disables profile creation when no candidate is available, with the host-block label as reason", () => {
    const gate = resolveCreateProfileGate(
      null,
      true,
      providerState({ candidates: [], loginCapability: OAUTH_CAP }),
    );
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "The Claude Code CLI is not installed on this host.",
    );
  });

  // A sandbox takes no sign-in at all, so the refusal wins over every other
  // answer and is the reason shown, whatever the provider's capability says.
  it("disables profile creation with the credential refusal as reason, whatever the provider", () => {
    const refusal = "Sandboxes don't take sign-ins";
    for (const loginCapability of [
      OAUTH_CAP,
      TERMINAL_LOGIN_CAP,
      null,
    ] as const) {
      for (const hostIsLocal of [true, false]) {
        expect(
          resolveCreateProfileGate(
            refusal,
            hostIsLocal,
            providerState({ loginCapability }),
          ),
        ).toEqual({ disabled: true, reason: refusal });
      }
    }
    expect(resolveCreateProfileGate(refusal, true, undefined)).toEqual({
      disabled: true,
      reason: refusal,
    });
    expect(
      resolveCreateProfileGate(
        refusal,
        true,
        providerState({ enabled: false, candidates: [] }),
      ),
    ).toEqual({ disabled: true, reason: refusal });
  });
});
