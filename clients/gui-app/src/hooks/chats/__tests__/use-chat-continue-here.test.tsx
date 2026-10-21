import type { ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { ChatContinueHereResponse } from "@traycer/protocol/host/chat-serving/index";
import type {
  CloudChatSummary,
  ListCloudChatsResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * The continue press, end to end through the real mutation. The target is a
 * team sandbox found from the host directory and the environment list, never
 * the app-wide host (which is a personal host by design), and the server's
 * answer decides whether a tab opens, which lists refresh, and whether the
 * dead tile's Clone takes over. The host seams (effective host, directory,
 * environment list, client) are the only stubs.
 */

const PERSONAL_HOST_ID = "host-personal";
const SOURCE_HOST_ID = "host-source";
const TEAM_ID = "team-1";
const ENVIRONMENT_ID = "env-1";
const TARGET_HOST_ID = "sandbox-target";
const MOVED_TO_HOST_ID = "host-elsewhere";
const VIEWER_ID = "viewer-1";
const OPERATION_ID = "5f0b1d1e-5c3a-4a55-9b52-2f1e0c9a7d11";

const harness = vi.hoisted(() => ({
  client: vi.fn<() => HostClient<HostRpcRegistry> | null>(),
  clientHostIds: [] as Array<string | null>,
  directory: [] as HostDirectoryEntry[],
  environments: [] as EnvironmentListResponse["environments"],
  openTile: vi.fn<(intent: TileOpenIntent) => null>(),
  toast: vi.fn(),
  toastFromHostError: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: harness.toast }));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: harness.toastFromHostError,
}));

// The app-wide host is a personal host: the hook must not use it as a target.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => PERSONAL_HOST_ID,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    harness.clientHostIds.push(hostId);
    return harness.client();
  },
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: harness.openTile }),
}));

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: { environments: harness.environments } }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: harness.directory }),
}));

// The chat's own host is gone from the directory (a destroyed sandbox's host
// is revoked) unless a test puts it there.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    harness.directory.find((entry) => entry.hostId === hostId) ?? null,
}));

import { useChatContinueHere } from "../use-chat-continue-here";

type ContinueHere = {
  readonly eligible: boolean;
  readonly targetLabel: string | null;
  readonly continueHere: () => void;
  readonly continuing: boolean;
};

let queryClient = new QueryClient();

function teamSandbox(
  hostId: string,
  teamId: string,
  state: "awake" | "suspended",
): HostDirectoryEntry {
  return remoteEntry(hostId, { ...sandboxFacts(teamId), state });
}

function awakeTeamSandbox(hostId: string): HostDirectoryEntry {
  return teamSandbox(hostId, TEAM_ID, "awake");
}

function clientAnswering(
  answer: ChatContinueHereResponse,
): HostClient<HostRpcRegistry> {
  return Object.assign({} as HostClient<HostRpcRegistry>, {
    request: () => Promise.resolve(answer),
  });
}

function clientFailing(error: HostRpcError): HostClient<HostRpcRegistry> {
  return Object.assign({} as HostClient<HostRpcRegistry>, {
    request: () => Promise.reject(error),
  });
}

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderContinue(): RenderHookResult<ContinueHere, undefined> {
  return renderHook(
    () =>
      useChatContinueHere({
        epicId: "epic-1",
        chatId: "chat-1",
        sourceHostId: SOURCE_HOST_ID,
        ownerUserId: ENVIRONMENT_ID,
        name: "Agent",
        fallback: harness.fallback,
      }),
    { wrapper },
  );
}

async function press(client: HostClient<HostRpcRegistry>): Promise<void> {
  harness.client.mockReturnValue(client);
  const { result } = renderContinue();
  act(() => {
    result.current.continueHere();
  });
  await waitFor(() => {
    expect(result.current.continuing).toBe(false);
  });
}

async function pressContinue(answer: ChatContinueHereResponse): Promise<void> {
  await press(clientAnswering(answer));
}

beforeEach(() => {
  harness.openTile.mockReset();
  harness.toast.mockReset();
  harness.toastFromHostError.mockReset();
  harness.fallback.mockReset();
  harness.client.mockReset();
  harness.clientHostIds.length = 0;
  harness.directory = [awakeTeamSandbox(TARGET_HOST_ID)];
  harness.environments = [
    {
      environmentId: "env-personal",
      ownerKind: "user",
      ownerId: VIEWER_ID,
      roomId: "room-personal",
      label: "Personal",
    },
    {
      environmentId: ENVIRONMENT_ID,
      ownerKind: "organization",
      ownerId: TEAM_ID,
      roomId: "room-team",
      label: "Alpha",
    },
  ];
  resetNegotiatedManifests();
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("useChatContinueHere target", () => {
  it("targets the person's awake sandbox of the chat's team, whatever the app-wide host is", () => {
    const { result } = renderContinue();

    expect(result.current.eligible).toBe(true);
    expect(result.current.targetLabel).toBe(`label-${TARGET_HOST_ID}`);
  });

  it("sends the continue on the target sandbox's client, not the app-wide host's", async () => {
    await pressContinue({
      kind: "refused",
      reason: "never-published",
      ownerHostId: null,
    });

    expect(harness.clientHostIds.at(-1)).toBe(TARGET_HOST_ID);
  });

  it("is not eligible when the only sandbox belongs to another team", () => {
    harness.directory = [teamSandbox(TARGET_HOST_ID, "team-other", "awake")];

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(false);
    expect(result.current.targetLabel).toBeNull();
  });

  it("is not eligible when the team's sandbox is not awake", () => {
    harness.directory = [teamSandbox(TARGET_HOST_ID, TEAM_ID, "suspended")];

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(false);
  });

  it("is not eligible when the sandbox's negotiated methods lack chat.continueHere", () => {
    recordNegotiatedHostMethods(TARGET_HOST_ID, ["host.status"]);

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(false);
  });

  it("stays eligible when the sandbox's negotiated methods include chat.continueHere", () => {
    recordNegotiatedHostMethods(TARGET_HOST_ID, [
      "host.status",
      "chat.continueHere",
    ]);

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(true);
  });

  it("targets the first awake team sandbox in directory order", () => {
    harness.directory = [
      awakeTeamSandbox("sandbox-first"),
      awakeTeamSandbox("sandbox-second"),
    ];

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(true);
    expect(result.current.targetLabel).toBe("label-sandbox-first");
  });

  it("is not eligible when the chat's owner is not one of the person's team environments", () => {
    harness.environments = harness.environments.filter(
      (environment) => environment.environmentId !== ENVIRONMENT_ID,
    );

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(false);
  });

  it("is not eligible while the chat's own host is still live", () => {
    harness.directory = [
      awakeTeamSandbox(TARGET_HOST_ID),
      teamSandbox(SOURCE_HOST_ID, TEAM_ID, "awake"),
    ];

    const { result } = renderContinue();

    expect(result.current.eligible).toBe(false);
  });
});

describe("useChatContinueHere answers", () => {
  it("toasts and opens no tab when the removed sandbox never published the chat", async () => {
    await pressContinue({
      kind: "refused",
      reason: "never-published",
      ownerHostId: null,
    });

    expect(harness.toast).toHaveBeenCalledWith(
      "This agent has nothing saved to continue from.",
    );
    expect(harness.openTile).not.toHaveBeenCalled();
    expect(harness.fallback).not.toHaveBeenCalled();
  });

  it("opens a tab on the owner host the answer names when another press already moved the chat", async () => {
    await pressContinue({
      kind: "refused",
      reason: "already-moved",
      ownerHostId: MOVED_TO_HOST_ID,
    });

    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.openTile).toHaveBeenCalledTimes(1);
    const [intent] = harness.openTile.mock.calls[0];
    expect(intent.node).toMatchObject({
      id: "chat-1",
      type: "chat",
      hostId: MOVED_TO_HOST_ID,
    });
  });

  it("falls back to the dead tile's Clone when the chat belongs to another environment", async () => {
    await pressContinue({
      kind: "refused",
      reason: "other-environment",
      ownerHostId: null,
    });

    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.openTile).not.toHaveBeenCalled();
  });

  it("toasts and opens no tab when the chat's sandbox still exists", async () => {
    await pressContinue({
      kind: "refused",
      reason: "source-live",
      ownerHostId: null,
    });

    expect(harness.toast).toHaveBeenCalledWith(
      "This agent's sandbox still exists. Resume it instead.",
    );
    expect(harness.openTile).not.toHaveBeenCalled();
  });
});

describe("useChatContinueHere list refresh", () => {
  const TASK_HOSTS_METHOD = "epic.listTaskHosts" as const;

  function cloudChatsKey(taskId: string): readonly unknown[] {
    return cloudChatListQueryKey({
      hostId: PERSONAL_HOST_ID,
      viewerUserId: VIEWER_ID,
      taskId,
    });
  }

  function taskHostsKey(taskId: string): readonly unknown[] {
    return [
      ...hostQueryKeys.method<HostRpcRegistry, typeof TASK_HOSTS_METHOD>(
        PERSONAL_HOST_ID,
        TASK_HOSTS_METHOD,
        { taskId },
      ),
      VIEWER_ID,
    ];
  }

  function seedLists(): void {
    for (const taskId of ["epic-1", "epic-2"]) {
      queryClient.setQueryData(cloudChatsKey(taskId), { chats: [] });
      queryClient.setQueryData(taskHostsKey(taskId), { hosts: [] });
    }
  }

  function invalidated(key: readonly unknown[]): boolean | undefined {
    return queryClient.getQueryState(key)?.isInvalidated;
  }

  it("refreshes this task's chat list and host list once the chat is accepted elsewhere, and no other task's", async () => {
    seedLists();
    expect(
      hostQueryKeys.matchesMethodOnAnyHost(
        cloudChatsKey("epic-1"),
        "epic.listCloudChats",
      ),
    ).toBe(true);

    await pressContinue({
      kind: "accepted",
      operationId: OPERATION_ID,
      ownerHostId: TARGET_HOST_ID,
    });

    expect(invalidated(cloudChatsKey("epic-1"))).toBe(true);
    expect(invalidated(taskHostsKey("epic-1"))).toBe(true);
    expect(invalidated(cloudChatsKey("epic-2"))).toBe(false);
    expect(invalidated(taskHostsKey("epic-2"))).toBe(false);
  });

  function cloudChatOwnedBy(ownerHostId: string): CloudChatSummary {
    return {
      identity: {
        taskId: "epic-1",
        chatId: "chat-1",
        ownerUserId: ENVIRONMENT_ID,
      },
      ownerHostId,
      createdAt: 1,
      visibility: "task",
      title: null,
      isTitleEditedByUser: false,
      parentChatId: null,
      isArchived: false,
      runSettingsSummary: null,
      metadataUpdatedAt: 1,
      headSha256: null,
      publishedAt: null,
      throughRecordSeq: null,
      isOwnedByViewer: true,
    };
  }

  it("ends with the target as the chat's owner when the first list read, still pending, answers with the source host after the move", async () => {
    let releaseFirstRead: (answer: ListCloudChatsResponse) => void = () => {};
    const firstRead = new Promise<ListCloudChatsResponse>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    const observer = new QueryObserver<ListCloudChatsResponse>(queryClient, {
      queryKey: cloudChatsKey("epic-1"),
      queryFn: () => {
        reads += 1;
        return reads === 1
          ? firstRead
          : Promise.resolve({ chats: [cloudChatOwnedBy(TARGET_HOST_ID)] });
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(reads).toBe(1);

    await pressContinue({
      kind: "accepted",
      operationId: OPERATION_ID,
      ownerHostId: TARGET_HOST_ID,
    });
    releaseFirstRead({ chats: [cloudChatOwnedBy(SOURCE_HOST_ID)] });

    await waitFor(() => {
      expect(
        observer.getCurrentResult().data?.chats.map((chat) => chat.ownerHostId),
      ).toEqual([TARGET_HOST_ID]);
    });
    expect(reads).toBe(2);
    unsubscribe();
  });

  it("refreshes the same lists when the chat is already moved", async () => {
    seedLists();

    await pressContinue({
      kind: "refused",
      reason: "already-moved",
      ownerHostId: MOVED_TO_HOST_ID,
    });

    expect(invalidated(cloudChatsKey("epic-1"))).toBe(true);
    expect(invalidated(taskHostsKey("epic-1"))).toBe(true);
    expect(invalidated(cloudChatsKey("epic-2"))).toBe(false);
  });

  it("leaves the lists alone when the continue is refused without moving the chat", async () => {
    seedLists();

    await pressContinue({
      kind: "refused",
      reason: "never-published",
      ownerHostId: null,
    });

    expect(invalidated(cloudChatsKey("epic-1"))).toBe(false);
    expect(invalidated(taskHostsKey("epic-1"))).toBe(false);
  });
});

describe("useChatContinueHere errors", () => {
  function rpcError(code: "E_HOST_UNSUPPORTED" | "RPC_ERROR"): HostRpcError {
    return new HostRpcError({
      code,
      message: "refused",
      requestId: "req-1",
      method: "chat.continueHere",
      fatalDetails: null,
    });
  }

  it("falls back to Clone, with no error toast, when the target host does not serve the method", async () => {
    await press(clientFailing(rpcError("E_HOST_UNSUPPORTED")));

    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.toastFromHostError).not.toHaveBeenCalled();
    expect(harness.openTile).not.toHaveBeenCalled();
  });

  it("toasts any other error and does not fall back", async () => {
    await press(clientFailing(rpcError("RPC_ERROR")));

    expect(harness.toastFromHostError).toHaveBeenCalledTimes(1);
    expect(harness.fallback).not.toHaveBeenCalled();
  });
});
