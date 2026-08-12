import { describe, expect, it } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { resolveCreateProfileGate } from "@/components/home/pickers/harness-model-picker-create-profile-gate";

const OAUTH_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
};

const TERMINAL_LOGIN_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: {},
};

describe("resolveCreateProfileGate", () => {
  it("allows creating a profile on a local host with browser sign-in", () => {
    const gate = resolveCreateProfileGate(true, OAUTH_CAP);
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  // Row 1 of the terminal-login contract table (this consumer's third):
  // a terminal-login provider is disabled here (the picker only drives
  // browser OAuth), with copy that names the terminal, not "browser sign-in".
  it("disables profile creation for a terminal-login provider without saying 'browser sign-in'", () => {
    const gate = resolveCreateProfileGate(true, TERMINAL_LOGIN_CAP);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).not.toContain("browser sign-in");
    expect(gate.reason).toContain("terminal");
  });

  // `providerSupportsTerminalLogin` answers false for both a null and an
  // undefined capability, so the terminal-login branch above must fall
  // through cleanly to the generic reason instead of throwing or matching on
  // `undefined.oauthArgs`. This is the case the ordering comment ("safe
  // against a null/absent capability") in the source claims but the suite
  // never exercised.
  it("falls through to the generic reason for a null loginCapability", () => {
    const gate = resolveCreateProfileGate(true, null);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });

  it("falls through to the generic reason for an undefined loginCapability", () => {
    const gate = resolveCreateProfileGate(true, undefined);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });

  // Unified gate: terminalLogin present but no real oauthArgs must read the
  // same as "not a terminal-login provider" here too - the generic reason,
  // not the terminal-specific one.
  it("uses the generic reason, not the terminal one, when oauthArgs is empty", () => {
    const gate = resolveCreateProfileGate(true, {
      oauthArgs: [],
      token: null,
      codePaste: null,
      terminalLogin: {},
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe(
      "Add profiles from a local host with browser sign-in available.",
    );
  });
});
