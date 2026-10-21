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
  poolEntry,
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import {
  ChatServingWitnessContext,
  useChatServing,
  useChatServingHostId,
  useChatServingSettled,
} from "@/lib/chats/chat-serving-witness";
import { PoolChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";

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
    this.statusListener?.("closed", reason, null);
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
