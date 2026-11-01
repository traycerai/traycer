import { describe, expect, it } from "vitest";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { providerRailStateWord } from "@/components/settings/panels/provider-rail-state-word";

function profile(
  kind: ProviderProfile["kind"],
  status: ProviderAuthStatus,
): ProviderProfile {
  return {
    profileId: kind === "ambient" ? "ambient" : `managed-${status}`,
    enabled: true,
    kind,
    authType: "oauth",
    label: kind,
    auth: { status, badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function state(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    ...overrides,
  };
}

const OAUTH_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
  remoteSafe: null,
  selfOpensBrowser: null,
};

const SIGNED_IN = {
  status: "authenticated",
  badgeText: null,
  label: null,
  detail: null,
} as const;
const SIGNED_OUT = {
  status: "unauthenticated",
  badgeText: null,
  label: null,
  detail: null,
} as const;

describe("providerRailStateWord", () => {
  it("says off before anything else the row holds", () => {
    expect(
      providerRailStateWord(
        state({
          enabled: false,
          profiles: [profile("managed", "authenticated")],
          apiKey: { supported: true, configured: true, source: "stored" },
          auth: SIGNED_OUT,
        }),
      ),
    ).toBe("off");
  });

  it("counts managed profiles, not the terminal login, ahead of a key or a sign-out", () => {
    const managed = profile("managed", "authenticated");
    expect(
      providerRailStateWord(
        state({
          profiles: [profile("ambient", "authenticated"), managed],
          apiKey: { supported: true, configured: true, source: "stored" },
          auth: SIGNED_OUT,
        }),
      ),
    ).toBe("1 profile");
    expect(
      providerRailStateWord(
        state({
          profiles: [
            managed,
            { ...managed, profileId: "managed-2" },
            { ...managed, profileId: "managed-3" },
          ],
        }),
      ),
    ).toBe("3 profiles");
  });

  it("says key for a configured key, ahead of a signed-out terminal login", () => {
    expect(
      providerRailStateWord(
        state({
          apiKey: { supported: true, configured: true, source: "env" },
          auth: SIGNED_OUT,
        }),
      ),
    ).toBe("key");
  });

  it("says signed out for a definitive sign-out on the provider or on the terminal login's row", () => {
    expect(providerRailStateWord(state({ auth: SIGNED_OUT }))).toBe(
      "signed out",
    );
    expect(
      providerRailStateWord(
        state({ profiles: [profile("ambient", "unauthenticated")] }),
      ),
    ).toBe("signed out");
  });

  it("says own login for a signed-in terminal login, but never for Traycer", () => {
    expect(providerRailStateWord(state({ auth: SIGNED_IN }))).toBe("own login");
    expect(
      providerRailStateWord(state({ providerId: "traycer", auth: SIGNED_IN })),
    ).toBeNull();
  });

  it("says own login for a saved login the tool reports as configured, on the provider or on the terminal login's row, but never for Traycer", () => {
    const configured = { ...SIGNED_IN, status: "configured" } as const;
    expect(providerRailStateWord(state({ auth: configured }))).toBe(
      "own login",
    );
    expect(
      providerRailStateWord(
        state({
          profiles: [{ ...profile("ambient", "configured") }],
        }),
      ),
    ).toBe("own login");
    expect(
      providerRailStateWord(state({ providerId: "traycer", auth: configured })),
    ).toBeNull();
  });

  it("states nothing while the sign-in is not an answer yet", () => {
    expect(providerRailStateWord(state({}))).toBeNull();
    expect(
      providerRailStateWord(
        state({ auth: { ...SIGNED_IN, status: "unavailable" } }),
      ),
    ).toBeNull();
  });

  it("says not checked for a provider with a terminal login whose settled check answered neither way", () => {
    expect(
      providerRailStateWord(
        state({
          loginCapability: OAUTH_CAP,
          profiles: [profile("ambient", "unavailable")],
          auth: { ...SIGNED_IN, status: "unavailable" },
        }),
      ),
    ).toBe("not checked");
    expect(
      providerRailStateWord(
        state({
          loginCapability: OAUTH_CAP,
          profiles: [profile("ambient", "unknown")],
          auth: { ...SIGNED_IN, status: "unknown" },
        }),
      ),
    ).toBe("not checked");
  });

  it("stays null, never 'not checked', while the probe is still running - a surface that wants 'checking' reads authPending itself", () => {
    expect(
      providerRailStateWord(
        state({
          loginCapability: OAUTH_CAP,
          profiles: [profile("ambient", "unavailable")],
          auth: { ...SIGNED_IN, status: "unavailable" },
          authPending: true,
        }),
      ),
    ).toBeNull();
  });

  it("control: a provider with no terminal login at all says nothing, never 'not checked', even though the host still sends it an ambient profile row", () => {
    expect(
      providerRailStateWord(
        state({
          loginCapability: null,
          profiles: [profile("ambient", "unknown")],
          auth: { ...SIGNED_IN, status: "unknown" },
        }),
      ),
    ).toBeNull();
  });
});
