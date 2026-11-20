import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type {
  StatusChangeHandler,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type { ChatServingKey } from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  personalSandboxEntry,
  poolEntry,
  remoteEntry,
  sandboxFacts,
  teamSandboxEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import {
  ChatServingWitnessContext,
  useChatEvictionServing,
  useChatServing,
  useChatServingHostId,
  useChatServingSettled,
  type ChatEvictionServing,
} from "@/lib/chats/chat-serving-witness";
import { holdChatOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import { PoolChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicRuntimeBinding,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { createRecordingAccountingPort } from "@/stores/epics/open-epic/test-support/accounting-port-fixture";

const CHAT: ChatServingKey = {
  hostId: "host-sandbox",
  epicId: "epic-1",
  chatId: "chat-1",
};

const state = vi.hoisted(
  (): {
    entry: HostDirectoryEntry | null;
    armChats: readonly CloudChatSummary[];
  } => ({ entry: null, armChats: [] }),
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => state.entry,
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () => actual.createHostRpcTierPlan(poolEntry),
    };
  },
);

vi.mock("@/hooks/environment/use-environment-arms", () => ({
  useEnvironmentArmChats: () => state.armChats,
}));

/** A fake session that also lets a test close it with a reason. */
class StatusDrivableSession extends FakeStreamSession {
  private statusListener: StatusChangeHandler | null = null;

  override onStatusChange(handler: StatusChangeHandler): void {
    this.statusListener = handler;
    super.onStatusChange(handler);
  }

  closeWith(reason: StreamCloseReason): void {
    this.statusListener?.("closed", reason, null, null);
  }
}

class StatusDrivableClient extends FakeStreamClient {
  readonly drivable: StatusDrivableSession[] = [];

  override subscribe(method: string, params: unknown): StatusDrivableSession {
    const session = new StatusDrivableSession();
    this.drivable.push(session);
    this.subscribes.push({ method, params });
    session.emitStatus("open");
    return session;
  }
}

const NOT_VISIBLE: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "CHAT_NOT_VISIBLE",
    reason: "chat is not published yet",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
};

const LIVE: ChatServing = {
  ownerHostId: CHAT.hostId,
  state: "live",
  catchingUp: null,
};

function servingFrame(serving: ChatServing) {
  return { kind: "serving", hasBinaryPayload: false, serving };
}

function armRow(chatId: string): CloudChatSummary {
  return {
    identity: { taskId: CHAT.epicId, chatId, ownerUserId: "viewer-1" },
    ownerHostId: CHAT.hostId,
    createdAt: 1,
    visibility: "task",
    title: chatId,
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

interface Reading {
  readonly holder: string;
  readonly serving: ChatServing | null;
  readonly settled: boolean;
}

/** Every render of every holder, in order. */
const readings: Reading[] = [];

function Holder({ name }: { readonly name: string }): ReactNode {
  const serving = useChatServing(CHAT);
  const settled = useChatServingSettled(CHAT);
  readings.push({ holder: name, serving, settled });
  return null;
}

function Tree({ witness }: { readonly witness: PoolChatServingWitness }) {
  return (
    <ChatServingWitnessContext.Provider value={witness}>
      <Holder name="a" />
      <Holder name="b" />
    </ChatServingWitnessContext.Provider>
  );
}

function setup() {
  state.entry = remoteEntry(CHAT.hostId, sandboxFacts("team-1"));
  state.armChats = [];
  readings.length = 0;
  const client = new StatusDrivableClient(true);
  const witness = new PoolChatServingWitness();
  witness.setStreamClient(client);
  const view = render(<Tree witness={witness} />);
  return { client, witness, view };
}

describe("a chat's serving witness across the chat reaching the environment arm", () => {
  afterEach(() => {
    cleanup();
    state.entry = null;
    state.armChats = [];
    readings.length = 0;
  });

  it("keeps a live reading on every render when the row appears on a healthy stream", () => {
    const { client, witness, view } = setup();
    expect(client.subscribes).toHaveLength(1);

    act(() => {
      client.drivable[0]?.emit(servingFrame(LIVE), null);
    });
    readings.length = 0;

    state.armChats = [armRow(CHAT.chatId)];
    view.rerender(<Tree witness={witness} />);

    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect(reading.settled).toBe(true);
      expect(reading.serving).toEqual(LIVE);
    }
    expect(client.subscribes).toHaveLength(1);
    expect(client.drivable[0]?.closed).toBe(false);
    witness.dispose();
  });

  it("reopens once when the row appears after the pool ended the stream, and every holder reads the new frame", () => {
    const { client, witness, view } = setup();
    expect(client.subscribes).toHaveLength(1);
    expect(readings.at(-1)?.settled).toBe(false);

    act(() => {
      client.drivable[0]?.closeWith(NOT_VISIBLE);
    });
    expect(client.subscribes).toHaveLength(1);

    state.armChats = [armRow(CHAT.chatId)];
    view.rerender(<Tree witness={witness} />);
    expect(client.subscribes).toHaveLength(2);

    readings.length = 0;
    act(() => {
      client.drivable[1]?.emit(servingFrame(LIVE), null);
    });

    expect(client.subscribes).toHaveLength(2);
    const latest = new Map(readings.map((r) => [r.holder, r]));
    expect([...latest.keys()].sort()).toEqual(["a", "b"]);
    for (const reading of latest.values()) {
      expect(reading.settled).toBe(true);
      expect(reading.serving).toEqual(LIVE);
    }
    witness.dispose();
  });

  it("does not open again from the same publication when the recovery after a pre-publication close is refused", () => {
    const { client, witness, view } = setup();

    act(() => {
      client.drivable[0]?.closeWith(NOT_VISIBLE);
    });
    expect(client.subscribes).toHaveLength(1);

    state.armChats = [armRow(CHAT.chatId)];
    view.rerender(<Tree witness={witness} />);
    expect(client.subscribes).toHaveLength(2);

    act(() => {
      client.drivable[1]?.closeWith(NOT_VISIBLE);
    });

    expect(client.subscribes).toHaveLength(2);
    expect(readings.at(-1)?.settled).toBe(false);
    witness.dispose();
  });

  it("reopens when the row appears before the pool ends the pre-publication stream", () => {
    const { client, witness, view } = setup();
    expect(client.subscribes).toHaveLength(1);

    state.armChats = [armRow(CHAT.chatId)];
    view.rerender(<Tree witness={witness} />);
    expect(client.subscribes).toHaveLength(1);

    act(() => {
      client.drivable[0]?.closeWith(NOT_VISIBLE);
    });
    expect(client.subscribes).toHaveLength(2);

    readings.length = 0;
    act(() => {
      client.drivable[1]?.emit(servingFrame(LIVE), null);
    });

    const latest = new Map(readings.map((r) => [r.holder, r]));
    expect([...latest.keys()].sort()).toEqual(["a", "b"]);
    for (const reading of latest.values()) {
      expect(reading.settled).toBe(true);
      expect(reading.serving).toEqual(LIVE);
    }
    witness.dispose();
  });

  it("does not reopen again when the recovery stream is also refused", () => {
    const { client, witness, view } = setup();

    state.armChats = [armRow(CHAT.chatId)];
    view.rerender(<Tree witness={witness} />);
    act(() => {
      client.drivable[0]?.closeWith(NOT_VISIBLE);
    });
    expect(client.subscribes).toHaveLength(2);

    act(() => {
      client.drivable[1]?.closeWith(NOT_VISIBLE);
    });

    expect(client.subscribes).toHaveLength(2);
    expect(readings.at(-1)?.settled).toBe(false);
    witness.dispose();
  });

  it("moves the stream's host from the pool to the chat's host when a later frame says live", () => {
    // The first render precedes every frame (unknown, read as at rest), and an
    // at-rest frame follows; the live frame after both must still move it.
    state.entry = remoteEntry(CHAT.hostId, sandboxFacts("team-1"));
    const client = new StatusDrivableClient(true);
    const witness = new PoolChatServingWitness();
    witness.setStreamClient(client);
    const peers: string[] = [];
    function PeerProbe(): ReactNode {
      peers.push(useChatServingHostId(CHAT));
      return null;
    }
    render(
      <ChatServingWitnessContext.Provider value={witness}>
        <PeerProbe />
      </ChatServingWitnessContext.Provider>,
    );
    expect(peers.at(-1)).toBe(POOL_HOST_ID);

    act(() => {
      client.drivable[0]?.emit(
        servingFrame({
          ownerHostId: CHAT.hostId,
          state: "at-rest",
          catchingUp: null,
        }),
        null,
      );
    });
    expect(peers.at(-1)).toBe(POOL_HOST_ID);

    act(() => {
      client.drivable[0]?.emit(servingFrame(LIVE), null);
    });
    expect(peers.at(-1)).toBe(CHAT.hostId);
    witness.dispose();
  });
});

const INERT_RUNTIME: EpicRuntimeBinding = {
  port: {
    call: () => {
      throw new Error("Unexpected runtime call");
    },
  },
  command: () => {},
  awarenessOut: () => {},
  currentUser: () => {},
  detach: () => {},
  dispose: () => {},
};

const AT_REST: ChatServing = {
  ownerHostId: CHAT.hostId,
  state: "at-rest",
  catchingUp: null,
};

interface MachineReading {
  hostId: string;
  settled: boolean;
  eviction: ChatEvictionServing;
}

describe("a machine's chat routed by its own eviction fact", () => {
  const released: Array<() => void> = [];
  const machineReadings: MachineReading[] = [];

  function Probe(): ReactNode {
    machineReadings.push({
      hostId: useChatServingHostId(CHAT),
      settled: useChatServingSettled(CHAT),
      eviction: useChatEvictionServing(CHAT),
    });
    return null;
  }

  function mount(input: {
    readonly entry: HostDirectoryEntry;
    readonly listHostId: string;
  }) {
    state.entry = input.entry;
    state.armChats = [];
    const epic: OpenEpicStoreHandle = createOpenEpicStore({
      epicId: CHAT.epicId,
      hostId: input.listHostId,
      userId: null,
      onWakeTransport: () => {},
      runtime: INERT_RUNTIME,
      accounting: createRecordingAccountingPort().port,
    });
    handleHostIds.set(epic, input.listHostId);
    const client = new StatusDrivableClient(true);
    const witness = new PoolChatServingWitness();
    witness.setStreamClient(client);
    render(
      <EpicSessionContext.Provider value={epic}>
        <ChatServingWitnessContext.Provider value={witness}>
          <Probe />
        </ChatServingWitnessContext.Provider>
      </EpicSessionContext.Provider>,
    );
    return {
      client,
      witness,
      evict: () =>
        act(() => {
          epic.store
            .getState()
            .applyChatRecordEvictions([{ chatId: CHAT.chatId, evicted: true }]);
        }),
      frame: (serving: ChatServing) =>
        act(() => {
          client.drivable[0]?.emit(servingFrame(serving), null);
        }),
    };
  }

  function machine(): HostDirectoryEntry {
    return remoteEntry(CHAT.hostId, null);
  }

  afterEach(() => {
    for (const release of released.splice(0)) release();
    cleanup();
    state.entry = null;
    machineReadings.length = 0;
  });

  it("moves an evicted chat to the pool once the witness reads it at rest, and waits for the first state", () => {
    const { client, witness, evict, frame } = mount({
      entry: machine(),
      listHostId: CHAT.hostId,
    });
    evict();
    expect(client.subscribes).toHaveLength(1);
    expect(machineReadings.at(-1)?.settled).toBe(false);

    frame(AT_REST);

    expect(machineReadings.at(-1)).toMatchObject({
      hostId: POOL_HOST_ID,
      settled: true,
      eviction: { served: true, held: true },
    });
    witness.dispose();
  });

  it("never asks the witness about a chat its machine has not evicted", () => {
    const { client, witness } = mount({
      entry: machine(),
      listHostId: CHAT.hostId,
    });

    expect(client.subscribes).toHaveLength(0);
    expect(machineReadings.at(-1)).toMatchObject({
      hostId: CHAT.hostId,
      settled: true,
      eviction: { served: false, held: false },
    });
    witness.dispose();
  });

  it("keeps a cross-host chat on its machine, settled, while the witness knows nothing, and moves it to the pool at rest", () => {
    const { witness, frame } = mount({
      entry: machine(),
      listHostId: "host-listing",
    });
    expect(machineReadings.at(-1)).toMatchObject({
      hostId: CHAT.hostId,
      settled: true,
    });

    frame(AT_REST);

    expect(machineReadings.at(-1)?.hostId).toBe(POOL_HOST_ID);
    witness.dispose();
  });

  it("serves a held chat from its own host, counts holders, and returns it to the pool when the last one lets go", () => {
    const { witness, evict, frame } = mount({
      entry: machine(),
      listHostId: CHAT.hostId,
    });
    evict();
    frame(AT_REST);
    expect(machineReadings.at(-1)?.hostId).toBe(POOL_HOST_ID);

    let releaseFirst = () => {};
    let releaseSecond = () => {};
    act(() => {
      releaseFirst = holdChatOnItsHost(CHAT);
      releaseSecond = holdChatOnItsHost(CHAT);
    });
    released.push(releaseFirst, releaseSecond);
    expect(machineReadings.at(-1)).toMatchObject({
      hostId: CHAT.hostId,
      eviction: { served: false, held: true },
    });

    act(() => releaseFirst());
    expect(machineReadings.at(-1)?.hostId).toBe(CHAT.hostId);

    act(() => releaseSecond());
    expect(machineReadings.at(-1)).toMatchObject({
      hostId: POOL_HOST_ID,
      eviction: { served: true, held: true },
    });
    witness.dispose();
  });

  it("never asks about a personal sandbox's chat, even one the list calls evicted", () => {
    const { client, witness, evict } = mount({
      entry: remoteEntry(CHAT.hostId, personalSandboxEntry.sandbox),
      listHostId: CHAT.hostId,
    });
    evict();

    expect(client.subscribes).toHaveLength(0);
    expect(machineReadings.at(-1)?.hostId).toBe(CHAT.hostId);
    witness.dispose();
  });

  it("leaves a team sandbox's chat to its own witness and ignores a hold", () => {
    const { witness, frame } = mount({
      entry: remoteEntry(CHAT.hostId, teamSandboxEntry.sandbox),
      listHostId: CHAT.hostId,
    });
    frame(AT_REST);
    act(() => {
      released.push(holdChatOnItsHost(CHAT));
    });

    expect(machineReadings.at(-1)).toMatchObject({
      hostId: POOL_HOST_ID,
      eviction: { served: false, held: false },
    });
    witness.dispose();
  });
});
