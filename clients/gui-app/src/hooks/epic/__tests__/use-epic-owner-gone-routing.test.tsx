/**
 * Archive and delete of an agent whose host is gone (issue #1628).
 *
 * The record names its owner; when the selection authority's lease says that
 * owner cannot serve, the same RPC goes to a live host instead, and the copy is
 * driven by the RECEIVING host's `outcome` - never by where the call was
 * routed. The host side is simulated by the handlers below: a host enacts a
 * write on a record it owns (`applied`) and writes the cloud row for one it
 * does not (`requested`).
 *
 * A stand-in is chosen only when its handshake negotiated the minor that
 * writes another host's record; the live hosts below are seeded with those.
 *
 * A stand-in is chosen on a cached manifest, so each of its dispatches also
 * carries the floor the owner-gone minor sets; the messenger here enforces it
 * against the handshake of the dispatching connection, as the transports do.
 *
 * Real: the hooks, `useHostMutation`, a `HostClient` over a floor-enforcing
 * `MockHostMessenger`, the `QueryClient`, the selection-authority store, the
 * negotiated-manifest registry. Faked: sonner and the binding seam (`useHostBinding`), as the
 * neighbouring routing suites do.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostMethodVersionUnsatisfiedError,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  mockInProcessHostEntry,
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  useEpicArchiveChat,
  useEpicDeleteChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicDeleteTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { EpicSessionHostClientContext } from "@/lib/registries/epic-session-registry";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { FloorEnforcingMessenger } from "@/hooks/config/__tests__/floor-enforcing-messenger";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useCloudChatDeletions } from "@/lib/chats/cloud-chat-deletions";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { toast } from "sonner";

const SESSION = mockLocalHostEntry;
const OWNER = mockRemoteHostEntry;
const OTHER = mockInProcessHostEntry;
const DIRECTORY: readonly HostDirectoryEntry[] = [SESSION, OWNER, OTHER];
const EPIC_ID = "epic-owner-gone";
const VIEWER_ID = "viewer-owner-gone";
const CHAT_ID = "chat-on-owner";
const TUI_ID = "tui-on-owner";

const spineRef = vi.hoisted<{
  value: HostClient<HostRpcRegistry> | null;
}>(() => ({ value: null }));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () =>
    spineRef.value === null
      ? null
      : { hostClient: spineRef.value, hostId: null },
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    spineRef.value === null
      ? null
      : { hostClient: spineRef.value, hostId: null },
}));

interface Call {
  readonly method: string;
  readonly hostId: string;
}

interface Fixture {
  readonly calls: Call[];
  readonly messenger: FloorEnforcingMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  /** What the dispatching connection's handshake negotiated, per method. */
  readonly handshake: Map<string, SchemaVersion>;
  /** The host that runs both records, as the HOSTS see it. */
  ownerAsHostsSeeIt: string;
  /** Whether `epic.deleteChat` answers with an error (after its commit). */
  deleteChatFails: boolean;
  /**
   * The owner a `requested` answer names (`ownerHostId`), or `null` to answer
   * as a host that predates the field.
   */
  requestedFor: string | null;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly dispose: () => void;
}

function lastCallHost(
  messenger: FloorEnforcingMessenger<HostRpcRegistry>,
): string {
  const last = messenger.calls.at(-1);
  if (last === undefined) throw new Error("expected a host messenger call");
  return last.authority.endpoint.hostId;
}

function createFixture(): Fixture {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const calls: Call[] = [];
  const state: {
    ownerAsHostsSeeIt: string;
    deleteChatFails: boolean;
    requestedFor: string | null;
  } = {
    ownerAsHostsSeeIt: OWNER.hostId,
    deleteChatFails: false,
    requestedFor: null,
  };
  const messengerRef: {
    current: FloorEnforcingMessenger<HostRpcRegistry> | null;
  } = {
    current: null,
  };
  const handshake = new Map<string, SchemaVersion>([
    ["epic.setChatArchived", { major: 1, minor: 1 }],
    ["epic.deleteChat", { major: 1, minor: 2 }],
    ["epic.deleteTuiAgent", { major: 1, minor: 1 }],
  ]);
  const outcomeOn = (
    hostId: string,
  ):
    | { readonly outcome: "applied" }
    | { readonly outcome: "requested"; readonly ownerHostId?: string } => {
    if (hostId === state.ownerAsHostsSeeIt) return { outcome: "applied" };
    return state.requestedFor === null
      ? { outcome: "requested" }
      : { outcome: "requested", ownerHostId: state.requestedFor };
  };
  let seq = 0;
  const messenger = new FloorEnforcingMessenger<HostRpcRegistry>(
    {
      registry: hostRpcRegistry,
      requestId: () => {
        seq += 1;
        return `owner-gone-${String(seq)}`;
      },
      handlers: {
        "epic.listChatRecords": () => {
          const hostId = lastCallHost(messengerRef.current ?? messenger);
          calls.push({ method: "epic.listChatRecords", hostId });
          return { kind: "snapshot" as const, listStamp: null, chats: [] };
        },
        "epic.setChatArchived": () => {
          const hostId = lastCallHost(messengerRef.current ?? messenger);
          calls.push({ method: "epic.setChatArchived", hostId });
          return { updated: true, ...outcomeOn(hostId) };
        },
        "epic.deleteChat": () => {
          const hostId = lastCallHost(messengerRef.current ?? messenger);
          calls.push({ method: "epic.deleteChat", hostId });
          if (state.deleteChatFails) {
            throw new Error("the response was lost after the delete");
          }
          return {
            deleted: true,
            publicationChatId: CHAT_ID,
            ...outcomeOn(hostId),
          };
        },
        "epic.deleteTuiAgent": () => {
          const hostId = lastCallHost(messengerRef.current ?? messenger);
          calls.push({ method: "epic.deleteTuiAgent", hostId });
          return { deleted: true, ...outcomeOn(hostId) };
        },
      },
    },
    handshake,
  );
  messengerRef.current = messenger;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      DIRECTORY.find((entry) => entry.hostId === hostId) ?? null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "owner-gone-token",
    }),
  );
  spineRef.value = spine;
  const sessionClient = spine.createRequester(SESSION);
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <EpicSessionHostClientContext.Provider value={sessionClient}>
        {props.children}
      </EpicSessionHostClientContext.Provider>
    </QueryClientProvider>
  );
  return {
    calls,
    messenger,
    queryClient,
    handshake,
    get ownerAsHostsSeeIt() {
      return state.ownerAsHostsSeeIt;
    },
    set ownerAsHostsSeeIt(value: string) {
      state.ownerAsHostsSeeIt = value;
    },
    get deleteChatFails() {
      return state.deleteChatFails;
    },
    set deleteChatFails(value: boolean) {
      state.deleteChatFails = value;
    },
    get requestedFor() {
      return state.requestedFor;
    },
    set requestedFor(value: string | null) {
      state.requestedFor = value;
    },
    wrapper,
    dispose: () => {
      spine.dispose();
      spineRef.value = null;
    },
  };
}

function lease(
  hostId: string,
  status: "ready" | "connecting" | "dead",
): HostLeaseSnapshot {
  return status === "dead"
    ? { hostId, status, dead: { reason: "offline" } }
    : { hostId, status, dead: null };
}

function publishLeases(...leases: HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.setState({ attached: true, leases });
}

function writeCalls(): Call[] {
  return fixture.calls.filter((call) => call.method !== "epic.listChatRecords");
}

let fixture: Fixture;

/** A handshake at the given minors of the three owner-gone writes. */
function negotiate(
  hostId: string,
  minors: {
    readonly setChatArchived: number;
    readonly deleteChat: number;
    readonly deleteTuiAgent: number;
  },
): void {
  recordNegotiatedHostManifest(hostId, {
    "epic.setChatArchived": {
      major: 1,
      minor: minors.setChatArchived,
      supportedMajors: [1],
    },
    "epic.deleteChat": {
      major: 1,
      minor: minors.deleteChat,
      supportedMajors: [1],
    },
    "epic.deleteTuiAgent": {
      major: 1,
      minor: minors.deleteTuiAgent,
      supportedMajors: [1],
    },
  });
}

const OWNER_GONE_MINORS = {
  setChatArchived: 1,
  deleteChat: 2,
  deleteTuiAgent: 1,
} as const;

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  useAuthStore.getState().setSignedIn(
    {
      userId: VIEWER_ID,
      userName: VIEWER_ID,
      email: `${VIEWER_ID}@example.com`,
    },
    { userId: VIEWER_ID, username: VIEWER_ID },
    [],
  );
  fixture = createFixture();
  negotiate(SESSION.hostId, OWNER_GONE_MINORS);
  negotiate(OTHER.hostId, OWNER_GONE_MINORS);
});

afterEach(() => {
  cleanup();
  fixture.dispose();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.getState().setSignedOut();
  resetNegotiatedManifests();
  vi.restoreAllMocks();
});

async function archive(archived: boolean): Promise<void> {
  const { result } = renderHook(() => useEpicArchiveChat(), {
    wrapper: fixture.wrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: OWNER.hostId,
      archived,
    });
  });
}

async function deleteChat(): Promise<void> {
  const { result } = renderHook(() => useEpicDeleteChat(), {
    wrapper: fixture.wrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: OWNER.hostId,
    });
  });
}

async function deleteTuiAgent(): Promise<void> {
  const { result } = renderHook(() => useEpicDeleteTuiAgent(), {
    wrapper: fixture.wrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      epicId: EPIC_ID,
      tuiAgentId: TUI_ID,
      hostId: OWNER.hostId,
    });
  });
}

/** Each write the messenger saw and the dispatch floor it carried. */
function writeFloors(): {
  readonly method: string;
  readonly floor: RequiredHostMethodVersion | null;
}[] {
  return fixture.messenger.calls
    .filter((call) => call.method !== "epic.listChatRecords")
    .map((call) => ({
      method: call.method,
      floor: call.requiredHostMethodVersion,
    }));
}

function chatListKey(hostId: string): readonly unknown[] {
  return [
    ...hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
    { epicId: EPIC_ID },
  ];
}

function tuiAgentListKey(hostId: string): readonly unknown[] {
  return [
    ...hostQueryKeys.methodScope(hostId, "epic.listTuiAgents"),
    { epicId: EPIC_ID },
  ];
}

/** A cached list under `key` that nothing has invalidated yet. */
function seedList(key: readonly unknown[]): void {
  fixture.queryClient.setQueryData(key, { seeded: true });
}

function isInvalidated(key: readonly unknown[]): boolean | undefined {
  return fixture.queryClient.getQueryState(key)?.isInvalidated;
}

function successToasts(): unknown[] {
  return vi.mocked(toast.success).mock.calls.map((call) => call[0]);
}

describe("owner session down -> a live host takes the write", () => {
  beforeEach(() => {
    publishLeases(
      lease(SESSION.hostId, "ready"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
  });

  it("archives through the session host and says the owner will finish", async () => {
    await archive(true);

    expect(writeCalls()).toEqual([
      { method: "epic.setChatArchived", hostId: SESSION.hostId },
    ]);
    expect(successToasts()).toEqual([
      "Archived. Mock Remote Host will finish when it is back",
    ]);
  });

  it("says the same for a requested unarchive", async () => {
    await archive(false);

    expect(successToasts()).toEqual([
      "Unarchived. Mock Remote Host will finish when it is back",
    ]);
  });

  it("deletes a chat through the session host and says the owner's files are untouched", async () => {
    await deleteChat();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: SESSION.hostId },
    ]);
    expect(successToasts()).toEqual([
      "Removed. Files on Mock Remote Host are untouched",
    ]);
  });

  it("deletes a terminal agent through the session host and says the agent may keep running until its host reconnects", async () => {
    await deleteTuiAgent();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteTuiAgent", hostId: SESSION.hostId },
    ]);
    expect(successToasts()).toEqual([
      "Removed. The agent may keep running on Mock Remote Host until that host reconnects. Its files are untouched",
    ]);
  });

  it("words a chat delete and a terminal-agent delete differently: only the agent may still be running", async () => {
    await deleteChat();
    await deleteTuiAgent();

    expect(successToasts()).toEqual([
      "Removed. Files on Mock Remote Host are untouched",
      "Removed. The agent may keep running on Mock Remote Host until that host reconnects. Its files are untouched",
    ]);
  });

  it("uses another live host when the session host is down too", async () => {
    publishLeases(
      lease(SESSION.hostId, "dead"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );

    await deleteChat();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: OTHER.hostId },
    ]);
  });

  it("passes over a live session host that negotiated only the owner-only minors, for a later one that can write", async () => {
    // Mid rolling upgrade: the session host can only apply these to its own
    // records, so it is skipped rather than sent a write it would miss.
    negotiate(SESSION.hostId, {
      setChatArchived: 0,
      deleteChat: 1,
      deleteTuiAgent: 0,
    });

    await archive(true);
    await deleteChat();
    await deleteTuiAgent();

    expect(writeCalls().map((call) => call.hostId)).toEqual([
      OTHER.hostId,
      OTHER.hostId,
      OTHER.hostId,
    ]);
  });

  it("sends each stand-in write under the floor of the minor that writes another host's record", async () => {
    await archive(true);
    await deleteChat();
    await deleteTuiAgent();

    expect(writeFloors()).toEqual([
      {
        method: "epic.setChatArchived",
        floor: {
          method: "epic.setChatArchived",
          version: { major: 1, minor: 1 },
        },
      },
      {
        method: "epic.deleteChat",
        floor: { method: "epic.deleteChat", version: { major: 1, minor: 2 } },
      },
      {
        method: "epic.deleteTuiAgent",
        floor: {
          method: "epic.deleteTuiAgent",
          version: { major: 1, minor: 1 },
        },
      },
    ]);
  });

  it("closes the deleted agent's tiles once a stand-in answers a terminal-agent delete", async () => {
    const closeTiles = vi.spyOn(
      useEpicCanvasStore.getState(),
      "closeConfirmedDeletedAgentTiles",
    );

    await deleteTuiAgent();

    expect(closeTiles).toHaveBeenCalledWith(
      EPIC_ID,
      TUI_ID,
      OWNER.hostId,
      "terminal-agent",
    );
  });

  it("refuses a stand-in whose connection negotiated an older minor than its cached manifest: nothing is written and the agent tile stays", async () => {
    // The route was chosen on a manifest that said the stand-in could write
    // another host's record; the connection that carries the write has since
    // restarted on the owner-only minor. Without the floor it would answer
    // `applied` for a record it never held.
    fixture.handshake.set("epic.deleteTuiAgent", { major: 1, minor: 0 });
    const closeTiles = vi.spyOn(
      useEpicCanvasStore.getState(),
      "closeConfirmedDeletedAgentTiles",
    );

    const failure = await deleteTuiAgent().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(writeCalls()).toEqual([]);
    expect(fixture.messenger.dispatched).toEqual([]);
    expect(closeTiles).not.toHaveBeenCalled();
    expect(successToasts()).toEqual([]);
  });

  it("refuses a stand-in chat delete the same way", async () => {
    fixture.handshake.set("epic.deleteChat", { major: 1, minor: 1 });

    const failure = await deleteChat().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(writeCalls()).toEqual([]);
    expect(successToasts()).toEqual([]);
  });

  it("does not count a requested terminal-agent delete as a stopped agent", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");

    await deleteTuiAgent();

    expect(
      track.mock.calls.filter(
        ([event]) => event === AnalyticsEvent.TerminalAgentStopped,
      ),
    ).toEqual([]);
  });

  it("reads the host's answer, not its own routing: an `applied` reply says nothing extra", async () => {
    // Authority moved to the session host after the GUI last saw the record:
    // the GUI routed away from a "down owner", but the receiving host found
    // the record was its own and enacted it.
    fixture.ownerAsHostsSeeIt = SESSION.hostId;

    await archive(true);
    await deleteChat();

    expect(writeCalls().map((call) => call.hostId)).toEqual([
      SESSION.hostId,
      SESSION.hostId,
    ]);
    expect(successToasts()).toEqual([]);
  });
});

describe("owner and session host down -> a third host takes the write", () => {
  const UNRELATED_HOST_ID = "host-unrelated-to-the-write";

  beforeEach(() => {
    publishLeases(
      lease(SESSION.hostId, "dead"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
  });

  it("refreshes the stand-in's chat and terminal-agent lists after an archive, and no unrelated host's", async () => {
    seedList(chatListKey(OTHER.hostId));
    seedList(tuiAgentListKey(OTHER.hostId));
    seedList(chatListKey(UNRELATED_HOST_ID));
    seedList(tuiAgentListKey(UNRELATED_HOST_ID));

    await archive(true);

    expect(writeCalls()).toEqual([
      { method: "epic.setChatArchived", hostId: OTHER.hostId },
    ]);
    expect(isInvalidated(chatListKey(OTHER.hostId))).toBe(true);
    expect(isInvalidated(tuiAgentListKey(OTHER.hostId))).toBe(true);
    expect(isInvalidated(chatListKey(UNRELATED_HOST_ID))).toBe(false);
    expect(isInvalidated(tuiAgentListKey(UNRELATED_HOST_ID))).toBe(false);
  });

  it("refreshes the stand-in's chat list after a chat delete", async () => {
    seedList(chatListKey(OTHER.hostId));
    seedList(chatListKey(UNRELATED_HOST_ID));

    await deleteChat();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: OTHER.hostId },
    ]);
    expect(isInvalidated(chatListKey(OTHER.hostId))).toBe(true);
    expect(isInvalidated(chatListKey(UNRELATED_HOST_ID))).toBe(false);
  });

  it("refreshes the stand-in's terminal-agent list after a terminal-agent delete", async () => {
    seedList(tuiAgentListKey(OTHER.hostId));
    seedList(tuiAgentListKey(UNRELATED_HOST_ID));

    await deleteTuiAgent();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteTuiAgent", hostId: OTHER.hostId },
    ]);
    expect(isInvalidated(tuiAgentListKey(OTHER.hostId))).toBe(true);
    expect(isInvalidated(tuiAgentListKey(UNRELATED_HOST_ID))).toBe(false);
  });
});

describe("unchanged paths", () => {
  it("an owner whose lease can serve is sent no dispatch floor", async () => {
    publishLeases(lease(SESSION.hostId, "ready"), lease(OWNER.hostId, "ready"));

    await archive(true);
    await deleteChat();
    await deleteTuiAgent();

    expect(writeFloors()).toEqual([
      { method: "epic.setChatArchived", floor: null },
      { method: "epic.deleteChat", floor: null },
      { method: "epic.deleteTuiAgent", floor: null },
    ]);
  });

  it("an owner whose lease can serve still takes the write, and `applied` says nothing extra", async () => {
    publishLeases(lease(SESSION.hostId, "ready"), lease(OWNER.hostId, "ready"));

    await archive(true);
    await deleteChat();
    await deleteTuiAgent();

    expect(writeCalls().map((call) => call.hostId)).toEqual([
      OWNER.hostId,
      OWNER.hostId,
      OWNER.hostId,
    ]);
    expect(successToasts()).toEqual([]);
  });

  it("counts an applied terminal-agent delete as a stopped agent", async () => {
    publishLeases(lease(SESSION.hostId, "ready"), lease(OWNER.hostId, "ready"));
    const track = vi.spyOn(Analytics.getInstance(), "track");

    await deleteTuiAgent();

    expect(
      track.mock.calls.filter(
        ([event]) => event === AnalyticsEvent.TerminalAgentStopped,
      ),
    ).toEqual([[AnalyticsEvent.TerminalAgentStopped, { source: "direct_ui" }]]);
  });

  it("with no live host the write still goes to the owner", async () => {
    publishLeases(
      lease(SESSION.hostId, "connecting"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "dead"),
    );

    await deleteChat();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: OWNER.hostId },
    ]);
  });

  it("before the selection authority attaches the write goes to the owner", async () => {
    await archive(true);

    expect(writeCalls()).toEqual([
      { method: "epic.setChatArchived", hostId: OWNER.hostId },
    ]);
  });
});

// Codex threads 4303057010 and 4303057013 on dc648adf0.
describe("a stand-in's `applied` delete and a stand-in's failed delete", () => {
  /** The confirmed cloud-deletion keys, as the suppression store keys them. */
  function confirmedDeletionOwners(): string[] {
    return [...useCloudChatDeletions.getState().confirmed].flatMap((key) => {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && parsed[3] === CHAT_ID
        ? [String(parsed[2])]
        : [];
    });
  }

  beforeEach(() => {
    useCloudChatDeletions.setState({
      pending: new Map(),
      confirmed: new Set(),
    });
  });

  it("binds an `applied` chat delete's cleanup to the stand-in that owned the chat, not the stale owner", async () => {
    // Authority moved to the session host after the GUI last saw the row.
    publishLeases(
      lease(SESSION.hostId, "ready"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
    fixture.ownerAsHostsSeeIt = SESSION.hostId;
    const forceRelease = vi.spyOn(getChatSessionRegistry(), "forceRelease");

    await deleteChat();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: SESSION.hostId },
    ]);
    // The cloud row of the deleted chat names the stand-in, so that is the
    // identity a stale cloud answer must be suppressed under.
    expect(confirmedDeletionOwners()).toEqual([SESSION.hostId]);
    expect(forceRelease).toHaveBeenCalledWith(EPIC_ID, CHAT_ID, SESSION.hostId);
    expect(forceRelease).not.toHaveBeenCalledWith(
      EPIC_ID,
      CHAT_ID,
      OWNER.hostId,
    );
  });

  it("keeps a `requested` chat delete's cleanup on the owner the row names", async () => {
    publishLeases(
      lease(SESSION.hostId, "ready"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );

    await deleteChat();

    expect(confirmedDeletionOwners()).toEqual([OWNER.hostId]);
  });

  it("closes an `applied` terminal-agent delete's tiles under the stand-in that owned the agent", async () => {
    publishLeases(
      lease(SESSION.hostId, "ready"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
    fixture.ownerAsHostsSeeIt = SESSION.hostId;
    const closeTiles = vi.fn();
    const original =
      useEpicCanvasStore.getState().closeConfirmedDeletedAgentTiles;
    useEpicCanvasStore.setState({
      closeConfirmedDeletedAgentTiles: closeTiles,
    });
    try {
      await deleteTuiAgent();
    } finally {
      useEpicCanvasStore.setState({
        closeConfirmedDeletedAgentTiles: original,
      });
    }

    expect(closeTiles).toHaveBeenCalledWith(
      EPIC_ID,
      TUI_ID,
      SESSION.hostId,
      "terminal-agent",
    );
  });

  it("refreshes the stand-in's cloud chat list when its delete fails after it may have committed", async () => {
    publishLeases(
      lease(SESSION.hostId, "dead"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
    fixture.deleteChatFails = true;
    const standInCloudList = cloudChatListQueryKey({
      hostId: OTHER.hostId,
      viewerUserId: VIEWER_ID,
      taskId: EPIC_ID,
    });
    seedList(standInCloudList);

    await expect(deleteChat()).rejects.toThrow();

    expect(writeCalls()).toEqual([
      { method: "epic.deleteChat", hostId: OTHER.hostId },
    ]);
    expect(isInvalidated(standInCloudList)).toBe(true);
  });
});

// Codex thread 4303240648 on d74e2198: a `requested` answer names the owner
// the stand-in filed for, which can differ from the row the client routed.
describe("a `requested` answer that names its owner", () => {
  function confirmedDeletionOwners(): string[] {
    return [...useCloudChatDeletions.getState().confirmed].flatMap((key) => {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && parsed[3] === CHAT_ID
        ? [String(parsed[2])]
        : [];
    });
  }

  beforeEach(() => {
    useCloudChatDeletions.setState({
      pending: new Map(),
      confirmed: new Set(),
    });
    publishLeases(
      lease(SESSION.hostId, "ready"),
      lease(OWNER.hostId, "dead"),
      lease(OTHER.hostId, "ready"),
    );
  });

  it("keys every cleanup to the owner the stand-in reports, not the row's", async () => {
    // The chat moved to OTHER after this client read the row naming OWNER;
    // the stand-in wrote OTHER's cloud row and says so.
    fixture.requestedFor = OTHER.hostId;
    seedList(chatListKey(OTHER.hostId));
    seedList(tuiAgentListKey(OTHER.hostId));
    const closeTiles = vi.fn();
    const original =
      useEpicCanvasStore.getState().closeConfirmedDeletedAgentTiles;
    useEpicCanvasStore.setState({
      closeConfirmedDeletedAgentTiles: closeTiles,
    });
    try {
      await archive(true);
      await deleteChat();
      await deleteTuiAgent();
    } finally {
      useEpicCanvasStore.setState({
        closeConfirmedDeletedAgentTiles: original,
      });
    }

    expect(writeCalls().map((call) => call.hostId)).toEqual([
      SESSION.hostId,
      SESSION.hostId,
      SESSION.hostId,
    ]);
    expect(confirmedDeletionOwners()).toEqual([OTHER.hostId]);
    expect(closeTiles.mock.calls).toEqual([
      [EPIC_ID, CHAT_ID, OTHER.hostId, "chat"],
      [EPIC_ID, TUI_ID, OTHER.hostId, "terminal-agent"],
    ]);
    expect(isInvalidated(chatListKey(OTHER.hostId))).toBe(true);
    expect(isInvalidated(tuiAgentListKey(OTHER.hostId))).toBe(true);
    expect(successToasts()).toEqual([
      "Archived. Mock In-Process Host will finish when it is back",
      "Removed. Files on Mock In-Process Host are untouched",
      "Removed. The agent may keep running on Mock In-Process Host until that host reconnects. Its files are untouched",
    ]);
  });

  it("keeps the row's owner when the stand-in predates the field", async () => {
    const closeTiles = vi.fn();
    const original =
      useEpicCanvasStore.getState().closeConfirmedDeletedAgentTiles;
    useEpicCanvasStore.setState({
      closeConfirmedDeletedAgentTiles: closeTiles,
    });
    try {
      await deleteChat();
    } finally {
      useEpicCanvasStore.setState({
        closeConfirmedDeletedAgentTiles: original,
      });
    }

    expect(confirmedDeletionOwners()).toEqual([OWNER.hostId]);
    expect(closeTiles.mock.calls).toEqual([
      [EPIC_ID, CHAT_ID, OWNER.hostId, "chat"],
    ]);
    expect(successToasts()).toEqual([
      "Removed. Files on Mock Remote Host are untouched",
    ]);
  });
});
