import "../../../../__tests__/test-browser-apis";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import {
  hostIdsOf,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const ENVIRONMENT_ID = "env-a";
const VIEWER_ID = "u-admin";

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => VIEWER_ID,
}));

function member(userId: string) {
  return {
    userId,
    displayName: userId,
    email: `${userId}@acme.test`,
    avatarUrl: null,
    effectiveRole: "viewer" as const,
    linkedPlan: false,
    inviteState: null,
    invitedAddress: null,
  };
}

function page(
  userIds: readonly string[],
  nextCursor: string | null,
): EnvironmentMembersResponseV12 {
  return {
    members: userIds.map(member),
    nextCursor,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  };
}

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

describe("useEnvironmentMembersList without a pool", () => {
  it("uses the caller host page cache and sends no request to the pool", async () => {
    const requestedCursors: Array<string | null> = [];
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.members": ({ cursor }) => {
        requestedCursors.push(cursor);
        return cursor === null
          ? page(["u-admin"], "page-1")
          : page(["u-read-from-host"], null);
      },
    });
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
      mutations: { retry: false },
    });
    harness.queryClient.setQueryDefaults(
      ["host", mockLocalHostEntry.hostId, "environment.members"],
      { gcTime: Infinity, staleTime: Infinity },
    );
    const callerSecondPageKey = [
      ...queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
        mockLocalHostEntry.hostId,
        "environment.members",
        { environmentId: ENVIRONMENT_ID, cursor: "page-1" },
      ),
      VIEWER_ID,
    ];
    const poolDecoyPageKey = [
      ...queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
        POOL_HOST_ID,
        "environment.members",
        { environmentId: ENVIRONMENT_ID, cursor: "page-1" },
      ),
      VIEWER_ID,
    ];
    harness.queryClient.setQueryData(
      callerSecondPageKey,
      page(["u-caller-page-2"], null),
    );
    harness.queryClient.setQueryData(
      poolDecoyPageKey,
      page(["u-pool-decoy"], null),
    );

    const { result } = renderHook(
      () =>
        useEnvironmentMembersList(
          requireTeamHostClient(),
          ENVIRONMENT_ID,
          true,
        ),
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.members.map(({ userId }) => userId)).toEqual([
        "u-admin",
        "u-caller-page-2",
      ]);
    });
    expect(result.current.members.map(({ userId }) => userId)).not.toContain(
      "u-pool-decoy",
    );
    expect(requestedCursors).toEqual([null]);
    expect(hostIdsOf(harness, "environment.members")).toEqual([
      mockLocalHostEntry.hostId,
    ]);
  });
});
