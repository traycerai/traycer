import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ModelOption } from "@/components/home/data/landing-options";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";
import { useTaskProfileRateLimitSwitch } from "../use-task-profile-rate-limit-switch";

/**
 * The sibling reads are cached in the app's QueryClient, which outlives any
 * one composer. A composer that unmounts and mounts again (the chat reopened,
 * or a second composer for the same task) must still read the host on its
 * next tick - not a previous mount's cached answer.
 *
 * Driven through the REAL batch hook and query cache, with only the host, the
 * tab binding, the epic records and the viewer faked.
 */

const TAB_HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-remount";
const CURRENT_CHAT_ID = "chat-current";
const SIBLING_CHAT_ID = "chat-sibling";

function settings(profileId: string): ChatRunSettings {
  return {
    harnessId: "claude",
    model: "opus[1m]",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId,
  };
}

const host = vi.hoisted(() => ({
  siblingProfileId: "limited",
  requests: 0,
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 } },
});
const hostClient = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: createHostQueryInvalidator(queryClient),
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "epic.getChatRunSettings": () => {
        host.requests += 1;
        return { settings: settings(host.siblingProfileId) };
      },
    },
  }),
});
hostClient.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);
const requester = vi.hoisted((): { current: unknown } => ({ current: null }));
requester.current = hostClient.createRequester(mockLocalHostEntry);

function chat(id: string): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: "viewer",
    hostId: TAB_HOST_ID,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
    docResident: false,
  };
}

const records: ChatsSlice = {
  allIds: [CURRENT_CHAT_ID, SIBLING_CHAT_ID],
  byId: {
    [CURRENT_CHAT_ID]: chat(CURRENT_CHAT_ID),
    [SIBLING_CHAT_ID]: chat(SIBLING_CHAT_ID),
  },
};
const epicStore = vi.hoisted((): { state: unknown } => ({ state: null }));
epicStore.state = { chatRecords: records };

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useTabHostId: () => entry.hostId };
});
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => requester.current,
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({
    store: {
      getState: () => epicStore.state,
      subscribe: () => () => {},
    },
  }),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicUpdateChatProfile: () => ({ mutate: () => {} }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer",
}));

const SELECTED_MODEL: ModelOption = {
  harnessId: "claude",
  slug: "opus[1m]",
  label: "Opus",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: null,
  supportedServiceTiers: [],
  metadata: {},
};

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function mountComposerSwitch() {
  return renderHook(
    () =>
      useTaskProfileRateLimitSwitch({
        enabled: true,
        episodeKey: "warning-1",
        harnessId: "claude",
        profileId: "limited",
        selectedModel: SELECTED_MODEL,
        epicId: EPIC_ID,
        chatId: CURRENT_CHAT_ID,
      }),
    { wrapper: Wrapper },
  );
}

describe("useTaskProfileRateLimitSwitch across composer remounts", () => {
  afterEach(cleanup);

  it("reads the host again on a remounted composer's tick, rather than an earlier mount's cached answer", async () => {
    const first = mountComposerSwitch();
    act(() => first.result.current.resolveScope());
    await waitFor(() =>
      expect(first.result.current.scope).toEqual({
        kind: "resolved",
        otherChatCount: 1,
        uncheckedChatCount: 0,
      }),
    );
    expect(host.requests).toBe(1);
    first.unmount();

    // Another client moved the sibling off the limited profile meanwhile.
    host.siblingProfileId = "fresh";

    const second = mountComposerSwitch();
    act(() => second.result.current.resolveScope());
    await waitFor(() =>
      expect(second.result.current.scope).toEqual({
        kind: "resolved",
        otherChatCount: 0,
        uncheckedChatCount: 0,
      }),
    );
    expect(host.requests).toBe(2);
  });
});
