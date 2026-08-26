import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useTombstonedProfileLabel } from "../use-tombstoned-profile-label";
import { TombstonedProfileProvider } from "../tombstoned-profile-provider";

const THIS_HOST = "host-1";
const OTHER_HOST = "host-2";

function claudeAnchor(
  profileId: string | null,
  labelSnapshot: string | null,
  hostId: string,
): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId,
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "uuid-1",
    turnTailUuid: null,
    createdAt: 100,
    coveredUntilMessageId: null,
    profileId,
    labelSnapshot,
    accountUuid: null,
    accentColor: null,
  };
}

function claudeState(profileIds: readonly string[]): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: profileIds.map((profileId) => ({
      profileId,
      enabled: true,
      kind:
        profileId === "ambient" ? ("ambient" as const) : ("managed" as const),
      authType: "oauth" as const,
      label: profileId,
      auth: {
        status: "authenticated" as const,
        badgeText: null,
        label: null,
        detail: null,
      },
      identity: null,
      usageUpdatedAt: null,
      rateLimitStatus: "unknown" as const,
      rateLimitLimitedScopes: null,
      duplicateOfProfileId: null,
      accentColor: null,
      ambientDriftNotice: null,
    })),
  };
}

function wrapper(profileIds: readonly string[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TombstonedProfileProvider
        providers={[claudeState(profileIds)]}
        hostId={THIS_HOST}
      >
        {children}
      </TombstonedProfileProvider>
    );
  };
}

describe("useTombstonedProfileLabel", () => {
  it("returns null with no provider mounted (inert default - every existing message test)", () => {
    const { result } = renderHook(() =>
      useTombstonedProfileLabel(
        claudeAnchor("removed-uuid", "Work", THIS_HOST),
      ),
    );
    expect(result.current).toBeNull();
  });

  it("returns null when there is no session anchor", () => {
    const { result } = renderHook(() => useTombstonedProfileLabel(null), {
      wrapper: wrapper(["ambient"]),
    });
    expect(result.current).toBeNull();
  });

  it("returns null for the ambient login (profileId null)", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor(null, null, THIS_HOST)),
      { wrapper: wrapper(["ambient"]) },
    );
    expect(result.current).toBeNull();
  });

  it("returns null when the profile is still active", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(claudeAnchor("work-uuid", "Work", THIS_HOST)),
      { wrapper: wrapper(["ambient", "work-uuid"]) },
    );
    expect(result.current).toBeNull();
  });

  it("reports a removal for an anchor minted on THIS host whose profile is gone", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", "Work", THIS_HOST),
        ),
      { wrapper: wrapper(["ambient"]) },
    );
    expect(result.current).toEqual({ label: "Work", removedOnThisHost: true });
  });

  it("falls back to a generic label when the snapshot itself is missing", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", null, THIS_HOST),
        ),
      { wrapper: wrapper(["ambient"]) },
    );
    expect(result.current).toEqual({
      label: "profile",
      removedOnThisHost: true,
    });
  });

  it("stays silent when the provider hasn't enumerated profiles at all (flag off / old host)", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", "Work", THIS_HOST),
        ),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider
            providers={[{ ...claudeState([]), profiles: [] }]}
            hostId={THIS_HOST}
          >
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBeNull();
  });

  // --- cross-host provenance -------------------------------------------- //

  it("keeps the provenance but claims NO removal for an anchor from another host", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", "Work", OTHER_HOST),
        ),
      { wrapper: wrapper(["ambient"]) },
    );
    expect(result.current).toEqual({ label: "Work", removedOnThisHost: false });
  });

  it("uses the generic label for a foreign anchor with no label snapshot", () => {
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", null, OTHER_HOST),
        ),
      { wrapper: wrapper(["ambient"]) },
    );
    expect(result.current).toEqual({
      label: "profile",
      removedOnThisHost: false,
    });
  });

  it("still treats a foreign anchor as foreign when its profile id COLLIDES with a local one", () => {
    // The only case the host-check-before-match ordering changes, and it is
    // unreachable in production: managed ids are `randomUUID()`, and the one
    // value identical across hosts - the reserved `"ambient"` sentinel - never
    // reaches an anchor (ambient is spelled `null` there). Pinned anyway,
    // because it is what stops "minted elsewhere" from silently depending on
    // uuid uniqueness. A collision must not let this host's list speak for
    // another machine's profile - in EITHER direction: not "(removed)", and
    // not "still active" either.
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("work-uuid", "Work", OTHER_HOST),
        ),
      { wrapper: wrapper(["ambient", "work-uuid"]) },
    );
    expect(result.current).toEqual({ label: "Work", removedOnThisHost: false });
  });

  it("stays silent for a foreign anchor whose provider this host has not enumerated", () => {
    // The provider gate still runs FIRST: an uninstalled provider, or a
    // `providers.list` that has not resolved yet, is not evidence of anything,
    // and a foreign anchor must not start rendering a footer on the strength
    // of an empty list.
    const { result } = renderHook(
      () =>
        useTombstonedProfileLabel(
          claudeAnchor("removed-uuid", "Work", OTHER_HOST),
        ),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider
            providers={[{ ...claudeState([]), profiles: [] }]}
            hostId={THIS_HOST}
          >
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBeNull();
  });
});
