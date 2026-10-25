/**
 * Which sessions raise the app's "Agent stream closed unexpectedly"
 * notification on a fatal close: an epic's chat does, a bot's channel or
 * thread (opened through `useChatSessionHandleForContainer`) does not, because
 * its view says the failure itself. Seen as the option the registry hands the
 * session store, with everything around the registry as in the owner-identity
 * suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { createChatSessionStore } from "@/stores/chats/chat-session-store";

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

const hostEntryRef = vi.hoisted((): { value: HostDirectoryEntry | null } => ({
  value: null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hostEntryRef.value,
}));

const globalClientRef = vi.hoisted(
  (): { value: HostClient<HostRpcRegistry> | null } => ({ value: null }),
);
vi.mock("@/lib/host", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test: globalClientRef not configured");
    }
    return globalClientRef.value;
  },
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

// The real opener is referentially stable; the acquire effect depends on it.
const openTransportRef = vi.hoisted(
  (): { fn: ((hostId: string) => DurableStreamTransport) | null } => ({
    fn: null,
  }),
);
const stableOpenTransport = vi.hoisted(() => {
  return (hostId: string) => {
    if (openTransportRef.fn === null) {
      throw new Error("test: openTransportRef not configured");
    }
    return openTransportRef.fn(hostId);
  };
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => stableOpenTransport,
}));

// The registry builds the real store; the spy only records its options.
const storeOptions = vi.hoisted(
  (): { calls: Array<Parameters<typeof createChatSessionStore>[0]> } => ({
    calls: [],
  }),
);
vi.mock("@/stores/chats/chat-session-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/chats/chat-session-store")>();
  return {
    ...actual,
    createChatSessionStore: (
      options: Parameters<typeof createChatSessionStore>[0],
    ) => {
      storeOptions.calls.push(options);
      return actual.createChatSessionStore(options);
    },
  };
});

import {
  disposeAllChatSessions,
  useChatSessionHandle,
  useChatSessionHandleForContainer,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

const REMOTE_HOST_ID = "chat-registry-remote-host";

function remoteTarget(): RemoteHostDirectoryEntry {
  return {
    hostId: REMOTE_HOST_ID,
    label: REMOTE_HOST_ID,
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey: "pubkey-a",
    relayFuseGrace: false,
    sandbox: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => undefined,
  };
}

function fakeWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => fakeStreamSession(),
    close: () => undefined,
    isClosed: () => false,
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => true,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-stream-client",
  };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function arrange(): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "chat-test-user",
      userName: "chat-test-user",
      email: "chat-test-user@example.com",
    },
  });
  openTransportRef.fn = () => ({
    wsStreamClient: fakeWsStreamClient(),
    close: () => undefined,
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  globalClientRef.value = client;
  hostEntryRef.value = remoteTarget();
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
  storeOptions.calls.length = 0;
  hostEntryRef.value = null;
  globalClientRef.value = null;
  openTransportRef.fn = null;
  useAuthStore.setState({ profile: null, status: "signed-out" });
});

describe("the chat session registry's fatal close notification", () => {
  it("raises it for an epic's chat and not for a bot's channel or thread", async () => {
    arrange();

    const epicChat = renderHook(
      () => useChatSessionHandle("chat-epic", REMOTE_HOST_ID, true),
      { wrapper },
    );
    const botChat = renderHook(
      () =>
        useChatSessionHandleForContainer(
          "bot-1",
          "chat-bot-channel",
          REMOTE_HOST_ID,
          true,
        ),
      { wrapper },
    );

    await waitFor(() => {
      expect(epicChat.result.current).not.toBeNull();
      expect(botChat.result.current).not.toBeNull();
    });
    expect(
      Object.fromEntries(
        storeOptions.calls.map((options) => [
          options.chatId,
          options.fatalCloseNotification,
        ]),
      ),
    ).toEqual({ "chat-epic": "raise", "chat-bot-channel": "silent" });
  });
});
