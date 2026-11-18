/**
 * A team host's task chat is owned by its ENVIRONMENT, so the row's owner is
 * not the signed-in member. The delete hook reads the viewer's row out of a
 * REAL open-epic session and keys its cloud suppression and confirmed removal
 * by that row's owner, not by the viewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";
import * as Y from "yjs";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    message: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-test",
    request: () => Promise.reject(new Error("unused")),
  }),
  useHostBinding: () => ({ hostClient: null, hostId: null }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({ hostClient: null, hostId: null }),
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ request: vi.fn() }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({
    request: vi.fn(),
    getActiveHostId: () => "host-test",
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({ forceRelease: vi.fn() }),
}));

interface CapturedMutationArgs {
  readonly method: string;
  readonly options: unknown;
}
const capturedMutations: Partial<Record<string, CapturedMutationArgs>> = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: CapturedMutationArgs) => {
    capturedMutations[args.method] = args;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  },
}));

import { renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import {
  useEpicDeleteChat,
  type DeleteChatMutationOptions,
} from "@/hooks/epic/use-epic-chat-mutations";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  filterDeletedCloudChats,
  useCloudChatDeletions,
} from "@/lib/chats/cloud-chat-deletions";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

const ENV = "env_team";
const OWNER_HOST = "owner-host";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Epic",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function record(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "env-chat",
    ownerUserId: ENV,
    originHostId: OWNER_HOST,
    title: "Env chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    ...overrides,
  };
}

function openEpicWith(
  rows: readonly ChatRecordSummaryV11[],
): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = getOpenEpicRegistry().acquire("epic-1", (id) =>
    openStoreForTest({
      epicId: id,
      userId: null,
      factories: { streamClientFactory: factory, laneSelection: null },
      writeCommand: null,
    }),
  );
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  handle.store.getState().applyChatRecords([...rows], null);
  return handle;
}

function signedInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

function wrapper({ children }: { children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function cloudChat(ownerUserId: string): CloudChatSummary {
  return {
    identity: { taskId: "epic-1", chatId: "env-chat", ownerUserId },
    ownerHostId: OWNER_HOST,
    title: "Env chat",
    createdAt: 1,
    visibility: "private",
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.keys(capturedMutations)) {
    delete capturedMutations[method];
  }
  useCloudChatDeletions.setState({ pending: new Map(), confirmed: new Set() });
});

afterEach(() => {
  getOpenEpicRegistry().disposeAll();
  useAuthStore.getState().setSignedOut();
});

function deleteOptions(): Required<
  Pick<DeleteChatMutationOptions, "onMutate" | "onSuccess">
> {
  renderHook(() => useEpicDeleteChat(), { wrapper });
  const options = capturedMutations["epic.deleteChat"]
    ?.options as DeleteChatMutationOptions;
  if (options.onMutate === undefined || options.onSuccess === undefined) {
    throw new Error("expected deleteChat handlers");
  }
  return { onMutate: options.onMutate, onSuccess: options.onSuccess };
}

const MUTATION_CONTEXT: MutationFunctionContext = {
  client: new QueryClient(),
  meta: undefined,
};

describe("deleting an environment-owned chat", () => {
  it("keys the cloud suppression and the confirmed removal by the row's owner, so a stale list cannot resurrect it", async () => {
    signedInAs("user-b");
    const handle = openEpicWith([record({})]);
    expect(handle.store.getState().chats.byId["env-chat"].ownedByViewer).toBe(
      true,
    );
    const { onMutate, onSuccess } = deleteOptions();
    const variables = {
      epicId: "epic-1",
      chatId: "env-chat",
      hostId: OWNER_HOST,
    };

    const ctx = await onMutate(variables, MUTATION_CONTEXT);
    expect(ctx.ownerUserId).toBe(ENV);
    // Provisionally suppressed under the environment, which is the identity the
    // cloud copy of this chat carries, and not under the member.
    const suppressed = (owner: string): boolean =>
      filterDeletedCloudChats(
        [cloudChat(owner)],
        useCloudChatDeletions.getState(),
      ).length === 0;
    expect(suppressed(ENV)).toBe(true);
    expect(suppressed("user-b")).toBe(false);

    onSuccess(
      { deleted: true, publicationChatId: null, outcome: "applied" },
      variables,
      ctx,
      MUTATION_CONTEXT,
    );
    expect(suppressed(ENV)).toBe(true);
    expect(handle.store.getState().chats.allIds).toEqual([]);

    // The owning host's stale list still carries the row: the removal that was
    // filed under the environment is what keeps it out.
    handle.store.getState().applyChatRecords([record({ revision: 9 })], null);
    expect(handle.store.getState().chats.allIds).toEqual([]);
  });

  it("falls back to the viewer for a chat the open epic holds no row for", async () => {
    signedInAs("user-b");
    openEpicWith([]);
    const { onMutate } = deleteOptions();
    const ctx = await onMutate(
      {
        epicId: "epic-1",
        chatId: "unknown",
        hostId: OWNER_HOST,
      },
      MUTATION_CONTEXT,
    );
    expect(ctx.ownerUserId).toBe("user-b");
  });
});
