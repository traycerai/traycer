import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateRequest,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import { chatIndicatorHostScopes } from "@/lib/notifications/chat-indicator-scopes";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The multi-host indicator fan-out, driven through real `HostClient`s over
 * `MockHostMessenger` so "which host was asked about which chat" is OBSERVED on
 * the wire rather than asserted against a spy's shape.
 *
 * Only the client resolver is stubbed - `useHostClientForHostId` reaches the
 * live host runtime binding, which no provider publishes in jsdom.
 */

const HOST_A = mockLocalHostEntry.hostId;
const HOST_B = mockRemoteHostEntry.hostId;

const clientsByHostId = vi.hoisted((): { value: Map<string, unknown> } => ({
  value: new Map(),
}));
const feedMode = vi.hoisted((): { value: "local" | "cloud" } => ({
  value: "local",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : (clientsByHostId.value.get(hostId) ?? null),
}));

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => feedMode.value,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

interface HostStub {
  /** Every chat id set this host was actually ASKED about, in order. */
  readonly asked: string[][];
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly hosts: Map<string, HostStub>;
}

function lit(
  flags: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorState {
  return {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: false,
    unreadDone: false,
    ...flags,
  };
}

/**
 * A host that answers ONLY about chats it owns - which is what the real RPC
 * does, since it is computed over that host's own SQLite rows. A host asked
 * about someone else's chat returns nothing for it.
 */
type OwnedIndicatorRows = ReadonlyArray<
  readonly [string, Record<string, HostNotificationsIndicatorState>]
>;

function createHarness(ownedEntries: OwnedIndicatorRows): Harness {
  const owned = new Map<
    string,
    Record<string, HostNotificationsIndicatorState>
  >(ownedEntries);
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    mutations: { retry: false },
  });
  const hosts = new Map<string, HostStub>();
  clientsByHostId.value = new Map();
  let requestId = 0;
  for (const entry of [mockLocalHostEntry, mockRemoteHostEntry]) {
    const stub: HostStub = { asked: [] };
    const rows = owned.get(entry.hostId) ?? {};
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestId += 1;
          return `request-${String(requestId)}`;
        },
        handlers: {
          "host.notifications.indicatorState": (
            params: HostNotificationsIndicatorStateRequest,
          ): HostNotificationsIndicatorStateResponse => {
            stub.asked.push([...params.chatIds]);
            const chats: Record<string, HostNotificationsIndicatorState> = {};
            for (const chatId of params.chatIds) {
              if (Object.hasOwn(rows, chatId)) chats[chatId] = rows[chatId];
            }
            return { epics: {}, chats };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    hosts.set(entry.hostId, stub);
    clientsByHostId.value.set(entry.hostId, spine.createRequester(entry));
  }
  useAuthStore.setState({
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  return { queryClient, hosts };
}

/**
 * One tab's indicator read, host-qualified end to end: the probe reads with
 * its tab's bound host (the same `originHostId` a real host-bound tab icon
 * passes), and its key and test id carry the host too - `chatId` is
 * host-minted, so two tabs can legitimately share one under different hosts
 * and a chatId-only key would collide in that exact test.
 */
function Probe(props: {
  readonly hostId: string;
  readonly chatId: string;
}): ReactNode {
  const state = useSurfaceNotificationIndicatorState(
    {
      epicId: "epic-1",
      chatId: props.chatId,
    },
    props.hostId,
  );
  return (
    <span data-testid={`probe-${props.hostId}-${props.chatId}`}>
      {[
        state.pendingFork ? "fork" : "",
        state.pendingApproval ? "approval" : "",
      ]
        .filter((flag) => flag.length > 0)
        .join(",")}
    </span>
  );
}

function renderStrip(
  harness: Harness,
  tabs: ReadonlyArray<{ readonly hostId: string; readonly chatId: string }>,
): void {
  render(
    createElement(
      QueryClientProvider,
      { client: harness.queryClient },
      <ChatIndicatorHostScopes scopes={chatIndicatorHostScopes(tabs)}>
        {tabs.map((tab) => (
          <Probe
            key={`${tab.hostId}:${tab.chatId}`}
            hostId={tab.hostId}
            chatId={tab.chatId}
          />
        ))}
      </ChatIndicatorHostScopes>,
    ),
  );
}

afterEach(() => {
  cleanup();
  feedMode.value = "local";
  clientsByHostId.value = new Map();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("ChatIndicatorHostScopes", () => {
  it("lights a cross-host tab's pendingFork from the host that actually owns it", async () => {
    feedMode.value = "cloud";
    const harness = createHarness([
      [HOST_A, { "chat-a": lit({ pendingFork: true }) }],
      [HOST_B, { "chat-b": lit({ pendingFork: true }) }],
    ]);

    renderStrip(harness, [
      { hostId: HOST_A, chatId: "chat-a" },
      { hostId: HOST_B, chatId: "chat-b" },
    ]);

    // Host B is not the app-wide active host. Before the partition it was
    // never asked, so `chat-b` could not light whatever its own host knew.
    await waitFor(() => {
      expect(screen.getByTestId(`probe-${HOST_A}-chat-a`).textContent).toBe(
        "fork",
      );
      expect(screen.getByTestId(`probe-${HOST_B}-chat-b`).textContent).toBe(
        "fork",
      );
    });
  });

  it("asks each host only about the chats bound to it", async () => {
    const harness = createHarness([
      [HOST_A, { "chat-a": lit({ pendingApproval: true }) }],
      [HOST_B, { "chat-b": lit({ pendingApproval: true }) }],
    ]);

    renderStrip(harness, [
      { hostId: HOST_A, chatId: "chat-a" },
      { hostId: HOST_B, chatId: "chat-b" },
    ]);

    await waitFor(() => {
      expect(harness.hosts.get(HOST_A)?.asked).toEqual([["chat-a"]]);
      expect(harness.hosts.get(HOST_B)?.asked).toEqual([["chat-b"]]);
    });
  });

  it("does not let one host light a tab bound to another that shares its host-minted id", async () => {
    const harness = createHarness([
      // Both hosts have a chat called `shared` - `chatId` is host-minted and
      // not unique across hosts. Only host A's is lit, and BOTH tabs are on
      // screen at once: the collision is only real when the two same-id tabs
      // render together, and each probe must read its own host's answer.
      [HOST_A, { shared: lit({ pendingApproval: true }) }],
      [HOST_B, { shared: lit({}) }],
    ]);

    renderStrip(harness, [
      { hostId: HOST_A, chatId: "shared" },
      { hostId: HOST_B, chatId: "shared" },
    ]);

    await waitFor(() => {
      expect(harness.hosts.get(HOST_A)?.asked).toEqual([["shared"]]);
      expect(harness.hosts.get(HOST_B)?.asked).toEqual([["shared"]]);
    });
    // Host A's flag lights host A's tab and ONLY host A's tab - the same-id
    // tab bound to host B stays dark even though the aggregate map now holds
    // an OR of both answers under this one chatId.
    await waitFor(() => {
      expect(screen.getByTestId(`probe-${HOST_A}-shared`).textContent).toBe(
        "approval",
      );
    });
    expect(screen.getByTestId(`probe-${HOST_B}-shared`).textContent).toBe("");
  });

  it("issues no read at all for a surface with no chat tabs", async () => {
    const harness = createHarness([]);

    renderStrip(harness, []);

    await waitFor(() => {
      expect(harness.hosts.get(HOST_A)?.asked).toEqual([]);
      expect(harness.hosts.get(HOST_B)?.asked).toEqual([]);
    });
  });
});

describe("chatIndicatorHostScopes", () => {
  it("groups by host and sorts both levels so tab reordering does not churn the fan-out", () => {
    const scopes = chatIndicatorHostScopes([
      { hostId: "host-z", chatId: "c2" },
      { hostId: "host-a", chatId: "c9" },
      { hostId: "host-z", chatId: "c1" },
      // A duplicate tab of the same chat contributes one id, not two.
      { hostId: "host-a", chatId: "c9" },
    ]);

    expect(scopes).toEqual([
      { hostId: "host-a", chatIds: ["c9"] },
      { hostId: "host-z", chatIds: ["c1", "c2"] },
    ]);
  });
});
