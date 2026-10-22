import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A landing draft's owner follows the host picker: the team that owns the
 * resolved host when the person is in it, else Personal.
 */

const mocks = vi.hoisted(() => {
  // hostId -> the team that owns that host; a host absent here is no team's.
  const hostTeams: { current: Record<string, string | null> } = { current: {} };
  return { hostTeams };
});

vi.mock("@/hooks/sandboxes/use-on-team-sandbox", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-on-team-sandbox")
  >()),
  useHostOwnerTeamId: (hostId: string | null): string | null =>
    hostId === null ? null : (mocks.hostTeams.current[hostId] ?? null),
}));

import { useLandingOwner } from "@/hooks/home/use-landing-owner";

const ACME: EpicShareableTeam = {
  teamId: "t1",
  slug: "acme",
  avatarUrl: null,
};
const BETA: EpicShareableTeam = {
  teamId: "t2",
  slug: "beta",
  avatarUrl: null,
};
const HOST_ID = "host-1";

beforeEach(() => {
  mocks.hostTeams.current = {};
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-viewer", username: "viewer" },
    shareableTeams: [ACME, BETA],
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    shareableTeams: [],
  });
});

describe("useLandingOwner", () => {
  it("is the team that owns the resolved host", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };

    const { result } = renderHook(() => useLandingOwner(HOST_ID));

    expect(result.current).toEqual({ teamId: "t1", slug: "acme" });
  });

  it("is Personal on the person's own host", () => {
    const { result } = renderHook(() => useLandingOwner(HOST_ID));

    expect(result.current).toBeNull();
  });

  it("is Personal on a team's host the person is no longer in", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t-gone" };

    const { result } = renderHook(() => useLandingOwner(HOST_ID));

    expect(result.current).toBeNull();
  });

  it("is Personal while no host is resolved", () => {
    const { result } = renderHook(() => useLandingOwner(null));

    expect(result.current).toBeNull();
  });

  it("follows the host when the picker moves to another", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1", "host-2": "t2" };

    const { result, rerender } = renderHook(
      (props: { readonly hostId: string }) => useLandingOwner(props.hostId),
      { initialProps: { hostId: HOST_ID } },
    );
    expect(result.current).toEqual({ teamId: "t1", slug: "acme" });

    rerender({ hostId: "host-2" });

    expect(result.current).toEqual({ teamId: "t2", slug: "beta" });
  });
});
