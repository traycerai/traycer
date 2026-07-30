// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListUserSessionsResponse } from "@traycer/protocol/auth/devices-sessions";
import type { AuthService } from "@/lib/auth/auth-service";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const fetchUserSessions =
  vi.fn<() => Promise<ListUserSessionsResponse | null>>();
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

  it("keeps an account A response in A's cache when the signed-in identity changes to B", async () => {
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

    resolveAccountA(sessionsResponse("account-a-family"));
    await waitFor(() => {
      expect(
        queryClient.getQueryData(authQueryKeys.userSessions(auth, "account-a")),
      ).toEqual(sessionsResponse("account-a-family"));
    });

    expect(
      queryClient.getQueryData(authQueryKeys.userSessions(auth, "account-b")),
    ).toEqual(sessionsResponse("account-b-family"));
    expect(result.current.data?.sessions[0]?.familyId).toBe("account-b-family");
  });
});
