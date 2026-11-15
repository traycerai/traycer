import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import {
  authnAnswer,
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";

// The account directory and its cloud enrichment use the shared transport
// fake. The hook, host binding, cloud hook and QueryClient stay real.

const viewer = vi.hoisted(() => ({ current: "" }));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => viewer.current,
}));

function listFor(label: string): EnvironmentListResponseV11 {
  return {
    environments: [
      {
        environmentId: `env-${label}`,
        ownerKind: "user",
        ownerId: label,
        roomId: `room-${label}`,
        label,
        effectiveRole: "owner",
        kind: "personal",
        hostCount: 0,
        providerHandle: null,
      },
    ],
  };
}

function createFixture() {
  let requests = 0;
  const harness = mountTeamPage(poolSource("admin"), {
    "environment.list": () => {
      requests += 1;
      return listFor(viewer.current);
    },
  });
  // Preserve A's stale entry across unmount so the account partition remains
  // the only reason B cannot observe it.
  harness.queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: 0, gcTime: Infinity },
    mutations: { retry: false },
  });
  return { ...harness, requestCount: () => requests };
}

function setSignedInViewer(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
  viewer.current = "";
});

describe("useEnvironmentListQuery - per-viewer cache partition", () => {
  it("does not serve viewer A's environments on viewer B's first render", async () => {
    const fixture = createFixture();
    viewer.current = "user-a";
    setSignedInViewer("user-a");
    const first = renderHook(() => useEnvironmentListQuery(true), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.data?.environments[0]?.label).toBe("user-a");
    });
    first.unmount();

    // What an identity transition does to the account directory: stale, not dropped.
    await fixture.queryClient.invalidateQueries({
      queryKey: ["host"],
      refetchType: "none",
    });
    viewer.current = "user-b";
    setSignedInViewer("user-b");
    const second = renderHook(() => useEnvironmentListQuery(true), {
      wrapper: fixture.Wrapper,
    });

    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(second.result.current.data?.environments[0]?.label).toBe("user-b");
    });
  });

  it("sends no request while the viewer is unresolved", async () => {
    const fixture = createFixture();
    const { result } = renderHook(() => useEnvironmentListQuery(true), {
      wrapper: fixture.Wrapper,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.requestCount()).toBe(0);
    expect(result.current.data).toBeUndefined();
  });
});

describe("useEnvironmentListQuery - the account's teams", () => {
  const acme = { teamId: "team-a", slug: "acme", avatarUrl: null };
  const beta = { teamId: "team-b", slug: "beta", avatarUrl: null };

  /** The directory names one team the account may not yet list; authn knows its role. */
  function mountTeamDirectory() {
    let reads = 0;
    const harness = mountTeamPage(poolSource("admin"), {});
    harness.auth.listEnvironments = () => {
      reads += 1;
      return Promise.resolve({
        kind: "ok",
        list: {
          environments: [
            {
              environmentId: "env-team-a",
              ownerKind: "organization",
              ownerId: "team-a",
              roomId: "room-team-a",
              label: "Acme",
            },
          ],
        },
      });
    };
    harness.cloudResponses.set(
      "GET /api/v3/environments/env-team-a/members",
      () => authnAnswer(200, { viewer: { effectiveRole: "editor" } }),
    );
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    });
    return { ...harness, directoryReads: () => reads };
  }

  function setTeams(teams: (typeof acme)[]): void {
    act(() => useAuthStore.setState({ shareableTeams: teams }));
  }

  it("lists a team degraded until the account names it, then reads the list again", async () => {
    const fixture = mountTeamDirectory();
    viewer.current = "user-a";
    setSignedInViewer("user-a");
    const { result } = renderHook(() => useEnvironmentListQuery(true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(result.current.data?.environments[0]).toMatchObject({
        providerHandle: null,
        effectiveRole: "viewer",
      });
    });
    expect(fixture.directoryReads()).toBe(1);

    setTeams([acme]);

    await waitFor(() => {
      expect(result.current.data?.environments[0]).toMatchObject({
        providerHandle: "acme",
        effectiveRole: "editor",
      });
    });
    expect(fixture.directoryReads()).toBe(2);
  });

  it("reads again for a changed set of teams, and not for the same set written again or reordered", async () => {
    const fixture = mountTeamDirectory();
    viewer.current = "user-a";
    setSignedInViewer("user-a");
    const { result } = renderHook(() => useEnvironmentListQuery(true), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    setTeams([acme, beta]);
    await waitFor(() => expect(fixture.directoryReads()).toBe(2));
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    setTeams([{ ...acme }, { ...beta }]);
    expect(result.current.isFetching).toBe(false);
    setTeams([beta, acme]);
    expect(result.current.isFetching).toBe(false);

    expect(fixture.directoryReads()).toBe(2);
  });
});
