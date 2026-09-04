import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const mocks = vi.hoisted(() => ({ addressableHostId: { current: "host-1" } }));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.addressableHostId.current,
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
    mocks.addressableHostId.current = HOST_ID;
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

  it("resolves a null run target through the addressable host, not as an unknown host", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(2));

    // `null` means "follow the app-wide default", which is the picker's COMMON
    // case. Reading it as an unknown host would hide the action there.
    expect(scopeSupported(LANDING_SURFACE, null)).toBe(true);
  });

  it("follows the addressable host's answer, not the last host recorded", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWithMajor(2));
    recordNegotiatedHostManifest("host-2", manifestWithMajor(1));
    mocks.addressableHostId.current = "host-2";

    expect(scopeSupported(LANDING_SURFACE, null)).toBe(false);
    // An explicit run target still outranks the app-wide default.
    expect(scopeSupported(LANDING_SURFACE, HOST_ID)).toBe(true);
  });
});
