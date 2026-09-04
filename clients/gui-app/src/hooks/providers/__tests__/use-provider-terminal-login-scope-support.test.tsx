import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

// The pickers that render this gate are drawn inside Epic TABS as well as on
// the start page, and a tab resolves host identity through its lifetime
// binding only. Any read of the app-wide host authority from this hook is a
// violation, whichever surface then ignores the answer - so the module is
// mocked to THROW, and every case below runs through it.
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: (): string => {
    throw new Error(
      "useProviderTerminalLoginScopeSupported must not read the addressable host",
    );
  },
}));

import {
  START_TERMINAL_LOGIN_METHOD,
  useProviderTerminalLoginScopeSupported,
} from "@/hooks/providers/use-provider-terminal-login-scope-support";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

const HOST_ID = "host-1";
const LANDING_SURFACE: ProviderTerminalLoginSurface = {
  kind: "landing",
  resolveLandingPageId: () => "draft-1",
};
const EPIC_SURFACE: ProviderTerminalLoginSurface = {
  kind: "epic",
  epicId: "epic-1",
  viewTabId: "tab-1",
};

function manifestWithMajor(major: number): ConnectionManifest {
  return { [START_TERMINAL_LOGIN_METHOD]: { major, minor: 0 } };
}

function scopeSupported(
  surface: ProviderTerminalLoginSurface | null,
  hostId: string | null,
): boolean {
  return renderHook(() =>
    useProviderTerminalLoginScopeSupported(surface, hostId),
  ).result.current;
}

describe("useProviderTerminalLoginScopeSupported", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  afterEach(() => {
    resetNegotiatedManifests();
  });

  it("is false for the landing surface on a host that negotiated the pre-scope major", () => {
    // `@1.0` has no `scope` field, so the client's downgrade refuses the
    // independent scope outright - the button could only ever fail, and for a
    // provider on the generic guidance there is no manual command to fall
    // back to.
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(1));

    expect(scopeSupported(LANDING_SURFACE, HOST_ID)).toBe(false);
  });

  it("is true for the EPIC surface on that same pre-scope host", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(1));

    // `@1.0` represents an epic scope natively, so the epic action is
    // unaffected - the same provider on the same host answers differently per
    // surface, which is the whole reason this is not a provider-row fact.
    expect(scopeSupported(EPIC_SURFACE, HOST_ID)).toBe(true);
  });

  it("is true for the EPIC surface with no manifest recorded at all - the epic path never consults the registry", () => {
    expect(scopeSupported(EPIC_SURFACE, HOST_ID)).toBe(true);
    expect(scopeSupported(EPIC_SURFACE, null)).toBe(true);
  });

  it("is true for the landing surface once the host negotiates the scoped major", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(2));

    expect(scopeSupported(LANDING_SURFACE, HOST_ID)).toBe(true);
  });

  it("fails closed for the landing surface while the host's manifest is unknown", () => {
    expect(scopeSupported(LANDING_SURFACE, HOST_ID)).toBe(false);
  });

  it("is vacuously true with no surface, so a fork dialog still says where the button lives", () => {
    expect(scopeSupported(null, HOST_ID)).toBe(true);
  });

  it("reads a null landing run target as unsupported rather than filling it from the app-wide host", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(2));

    // The landing composer resolves its placement host itself and hands it
    // down; `null` reaches the picker only in the ∅ case, where there is
    // nothing usable to create on and submit refuses too. Resolving it here
    // through the app-wide authority would be exactly the read a tab-bound
    // picker must never make.
    expect(scopeSupported(LANDING_SURFACE, null)).toBe(false);
  });

  it("answers for the host it was given, not the last host recorded", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(2));
    recordNegotiatedHostManifest("host-2", manifestWithMajor(1));

    expect(scopeSupported(LANDING_SURFACE, "host-2")).toBe(false);
    expect(scopeSupported(LANDING_SURFACE, HOST_ID)).toBe(true);
  });
});
