import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/foundation";
import { GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS } from "@traycer/protocol/host/epic/chat-records";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useChatRunSettingsBatch } from "@/hooks/chats/use-chat-run-settings-query";

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet",
  permissionMode: "full_access",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

describe("useChatRunSettingsBatch", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  function createFixture() {
    const queryClient = createAppQueryClient();
    const counts = { single: 0, batch: 0 };
    let requestCounter = 0;
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestCounter += 1;
          return `req-${String(requestCounter)}`;
        },
        handlers: {
          "epic.getChatRunSettings": () => {
            counts.single += 1;
            return { settings: SETTINGS };
          },
          "epic.getChatRunSettingsBatch": (params) => {
            counts.batch += 1;
            return {
              entries: params.chatIds.map((chatId) => ({
                chatId,
                settings: SETTINGS,
              })),
            };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    return { Wrapper, client, counts };
  }

  it("issues one batch RPC for N chats when the host advertised the method", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "epic.getChatRunSettings",
      "epic.getChatRunSettingsBatch",
    ]);
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: fixture.client,
          epicId: "epic-1",
          chatIds: ["chat-a", "chat-b", "chat-c"],
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current[0]?.data?.settings).toEqual(SETTINGS);
    });
    expect(fixture.counts.batch).toBe(1);
    expect(fixture.counts.single).toBe(0);
    expect(result.current).toHaveLength(3);
  });

  it("chunks at 50 ids into two batch RPCs", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "epic.getChatRunSettingsBatch",
    ]);
    const chatIds = Array.from(
      { length: GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS + 1 },
      (_unused, index) => `chat-${String(index)}`,
    );
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: fixture.client,
          epicId: "epic-1",
          chatIds,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current[0]?.data?.settings).toEqual(SETTINGS);
    });
    expect(fixture.counts.batch).toBe(2);
    expect(fixture.counts.single).toBe(0);
  });

  it("falls back to N singles when the host did not advertise the batch method", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "epic.getChatRunSettings",
    ]);
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: fixture.client,
          epicId: "epic-1",
          chatIds: ["chat-a", "chat-b"],
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current[1]?.data?.settings).toEqual(SETTINGS);
    });
    expect(fixture.counts.single).toBe(2);
    expect(fixture.counts.batch).toBe(0);
  });

  it("issues zero RPCs while disabled", () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "epic.getChatRunSettingsBatch",
    ]);
    const fixture = createFixture();
    renderHook(
      () =>
        useChatRunSettingsBatch({
          client: fixture.client,
          epicId: "epic-1",
          chatIds: ["chat-a", "chat-b"],
          enabled: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    expect(fixture.counts.batch).toBe(0);
    expect(fixture.counts.single).toBe(0);
  });
});
