import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useTombstonedProfileLabel } from "../use-tombstoned-profile-label";
import { TombstonedProfileProvider } from "../tombstoned-profile-provider";

function claudeAnchor(
  profileId: string | null,
  labelSnapshot: string | null,
): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId: "host-1",
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "uuid-1",
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
    profiles: profileIds.map((profileId) => ({
      profileId,
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

describe("useTombstonedProfileLabel", () => {
  it("returns null with no provider mounted (inert default - every existing message test)", () => {
    const { result } = renderHook(() =>
      useTombstonedProfileLabel(claudeAnchor("removed-uuid", "Work")),
    );
    expect(result.current).toBeNull();
  });

  it("returns null when there is no session anchor", () => {
    const { result } = renderHook(() => useTombstonedProfileLabel(null), {
      wrapper: ({ children }) => (
        <TombstonedProfileProvider providers={[claudeState(["ambient"])]}>
          {children}
        </TombstonedProfileProvider>
      ),
    });
    expect(result.current).toBeNull();
  });

  it("returns null for the ambient login (profileId null)", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor(null, null)),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider providers={[claudeState(["ambient"])]}>
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBeNull();
  });

  it("returns null when the profile is still active", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor("work-uuid", "Work")),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider
            providers={[claudeState(["ambient", "work-uuid"])]}
          >
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBeNull();
  });

  it("returns the snapshotted label when the profile is no longer active", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor("removed-uuid", "Work")),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider providers={[claudeState(["ambient"])]}>
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBe("Work");
  });

  it("falls back to a generic label when the snapshot itself is missing", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor("removed-uuid", null)),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider providers={[claudeState(["ambient"])]}>
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBe("profile");
  });

  it("stays silent when the provider hasn't enumerated profiles at all (flag off / old host)", () => {
    const { result } = renderHook(
      () => useTombstonedProfileLabel(claudeAnchor("removed-uuid", "Work")),
      {
        wrapper: ({ children }) => (
          <TombstonedProfileProvider
            providers={[{ ...claudeState([]), profiles: [] }]}
          >
            {children}
          </TombstonedProfileProvider>
        ),
      },
    );
    expect(result.current).toBeNull();
  });
});
