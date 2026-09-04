import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMentionCollaboratorsForClient } from "@/hooks/comments/use-mention-collaborators";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `enabled: false` stops the NEXT fetch; it does not empty the cache entry
 * the picker shares with the Sharing panel. So a verdict lost after the
 * query answered has to gate the projection too, or the picker keeps
 * offering the names and email addresses it loaded under the verdict.
 */
const collaboratorsQuery = vi.hoisted(() => ({
  enabled: null as boolean | null,
  data: {
    directUsers: [],
    teams: [],
    flatRows: [
      {
        key: "u-2",
        userId: "u-2",
        displayName: "Bea",
        email: "bea@example.com",
        handle: "bea",
        avatarUrl: null,
        role: "editor",
        accessSource: "direct-user",
        teamId: null,
        teamName: null,
      },
    ],
  },
}));

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  useEpicCollaboratorsQuery: (
    _epicId: string,
    options: { readonly enabled: boolean },
  ) => {
    collaboratorsQuery.enabled = options.enabled;
    return { data: collaboratorsQuery.data };
  },
}));

function signIn(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "u-1", userName: "U", email: "u@example.com" },
      { userId: "u-1", username: "U" },
      [],
    );
}

function demoteToUnverified(): void {
  useAuthStore
    .getState()
    .setUnverifiedSession(
      { userId: "u-1", userName: "U", email: "u@example.com" },
      { userId: "u-1", username: "U" },
    );
}

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("useMentionCollaboratorsForClient under a withdrawn verdict", () => {
  it("empties the loaded list once the session is demoted, not only the next request", () => {
    signIn();
    const { result } = renderHook(() =>
      useMentionCollaboratorsForClient(null, "epic-1"),
    );
    expect(collaboratorsQuery.enabled).toBe(true);
    expect(result.current.map((row) => row.email)).toEqual(["bea@example.com"]);

    // The cache still holds the rows; the mock returns the same `data`.
    act(() => {
      demoteToUnverified();
    });

    expect(collaboratorsQuery.enabled).toBe(false);
    expect(result.current).toEqual([]);
  });
});
