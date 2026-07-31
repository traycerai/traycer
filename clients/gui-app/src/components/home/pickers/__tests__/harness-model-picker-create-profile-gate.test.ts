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
});
