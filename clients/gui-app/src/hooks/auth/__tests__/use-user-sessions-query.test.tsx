// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListUserSessionsResponse } from "@traycer/protocol/auth/devices-sessions";
import type { AuthService } from "@/lib/auth/auth-service";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const fetchUserSessions =
  vi.fn<(signal: AbortSignal) => Promise<ListUserSessionsResponse | null>>();
const auth = { fetchUserSessions } as Pick<AuthService, "fetchUserSessions">;

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ auth }),
}));

import { useAuthFetchUserSessions } from "@/hooks/auth/use-user-sessions-query";

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function sessionsResponse(familyId: string): ListUserSessionsResponse {
  return {
    sessions: [
      {
        familyId,
        clientKind: "desktop",
        displayLabel: familyId,
        platform: "macOS",
        appVersion: null,
        location: null,
        createdAt: "2026-07-30T10:00:00.000Z",
        lastSeenAt: "2026-07-30T10:00:00.000Z",
        revoked: false,
        revokedAt: null,
        revokedBy: null,
        current: true,
      },
    ],
  };
}

describe("useAuthFetchUserSessions", () => {
  beforeEach(() => {
    fetchUserSessions.mockReset();
    useAuthStore.getState().setSignedOut();
  });

  // `globals: false` in this project, so Testing Library's auto-cleanup never
  // runs. Without this an earlier test's hook stays mounted and refetches off
  // the next test's sign-in, inflating the call counts asserted below.
  afterEach(() => {
    cleanup();
  });

  it("drops account A's in-flight read when the identity changes to B, and never lets it reach B", async () => {
    let resolveAccountA: (value: ListUserSessionsResponse) => void = () => {};
    fetchUserSessions
      .mockImplementationOnce(
        () =>
          new Promise<ListUserSessionsResponse>((resolve) => {
            resolveAccountA = resolve;
          }),
      )
      .mockResolvedValueOnce(sessionsResponse("account-b-family"));

    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "account-a", userName: "Account A", email: "a@example.com" },
        { userId: "account-a", username: "account-a" },
        [],
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAuthFetchUserSessions(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(fetchUserSessions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "account-b",
          userName: "Account B",
          email: "b@example.com",
        },
        { userId: "account-b", username: "account-b" },
        [],
      );
    });

    await waitFor(() => {
      expect(result.current.data?.sessions[0]?.familyId).toBe(
        "account-b-family",
      );
    });

    const accountASignal = fetchUserSessions.mock.calls[0]?.[0];
    resolveAccountA(sessionsResponse("account-a-family"));
    await act(async () => {
      await Promise.resolve();
    });

    // Switching identity leaves A's query with no observer. Because the query
    // function consumes the signal, TanStack cancels-and-reverts that read
    // instead of letting it settle, so A's late response is discarded outright
    // rather than parked in A's cache. Stronger than the by-key isolation this
    // case was originally written for: the answer nobody asked for is gone, and
    // a later switch back to A refetches instead of showing a pre-switch
    // snapshot.
    expect(accountASignal.aborted).toBe(true);
    expect(
      queryClient.getQueryData(authQueryKeys.userSessions(auth, "account-a")),
    ).toBeUndefined();

    // The property that actually matters: A's response never reaches B.
    expect(
      queryClient.getQueryData(authQueryKeys.userSessions(auth, "account-b")),
    ).toEqual(sessionsResponse("account-b-family"));
    expect(result.current.data?.sessions[0]?.familyId).toBe("account-b-family");
  });

  it("aborts the signal it handed the in-flight read when a revoke invalidates the query", async () => {
    // The revoke mutations invalidate this exact key on success. The read that
    // was already in flight is abandoned by that invalidation, and
    // `fetchUserSessions` needs to hear about it: its repair path spends a
    // single-use refresh rotation that must not run for a discarded answer.
    let resolveInFlight: (value: ListUserSessionsResponse) => void = () => {};
    fetchUserSessions
      // The panel is already showing sessions...
      .mockResolvedValueOnce(sessionsResponse("initial-family"))
      // ...a 30s poll refetch is in flight...
      .mockImplementationOnce(
        () =>
          new Promise<ListUserSessionsResponse>((resolve) => {
            resolveInFlight = resolve;
          }),
      )
      // ...and the revoke's invalidation supersedes it.
      .mockResolvedValueOnce(sessionsResponse("post-revoke-family"));

    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "account-a", userName: "Account A", email: "a@example.com" },
        { userId: "account-a", username: "account-a" },
        [],
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAuthFetchUserSessions(), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data?.sessions[0]?.familyId).toBe("initial-family");
    });

    act(() => {
      void result.current.refetch();
    });
    await waitFor(() => {
      expect(fetchUserSessions).toHaveBeenCalledTimes(2);
    });
    const inFlightSignal = fetchUserSessions.mock.calls[1]?.[0];
    expect(inFlightSignal).toBeInstanceOf(AbortSignal);
    expect(inFlightSignal.aborted).toBe(false);

    // Not awaited: the returned promise settles only once the replacement
    // refetch chain does, and the point here is that the abort reaches the
    // read that is still in flight right now.
    act(() => {
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.userSessions(auth, "account-a"),
      });
    });

    await waitFor(() => {
      expect(inFlightSignal.aborted).toBe(true);
    });
    resolveInFlight(sessionsResponse("stale-pre-revoke-family"));
  });
});
