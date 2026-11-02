import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { CommGraphSubscriptionManager } from "@/lib/comm-graph/comm-graph-subscription";
import { createCommGraphSubscriptionOpener } from "@/lib/comm-graph/comm-graph-stream-opener";
import { CommGraphCloudSubscriptionManager } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import { createCommGraphCloudSubscriptionOpener } from "@/lib/comm-graph/comm-graph-cloud-stream-opener";

// The real opener over a drivable session, under the real manager: the status
// handler the opener registers is the one that receives each four-argument
// transition, so these tests read what the manager publishes and re-dials.

function makeEvent(id: number): EpicCommunicationGraphEvent {
  return {
    id,
    timestamp: id * 100,
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hi",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    peerEpicId: null,
  };
}

function start(): {
  readonly fake: FakeStreamClient;
  readonly manager: CommGraphSubscriptionManager;
} {
  const fake = new FakeStreamClient(false);
  const manager = new CommGraphSubscriptionManager(
    "epic-1",
    createCommGraphSubscriptionOpener(() => ({
      wsStreamClient: fake,
      close: vi.fn(),
    })),
  );
  manager.attach();
  manager.setHostIds(["host-a"]);
  return { fake, manager };
}

function snapshotThrough(
  session: FakeStreamClient["sessions"][number],
  ids: ReadonlyArray<number>,
): void {
  session.emitStatus("open");
  session.emit(
    {
      kind: "snapshot",
      epicId: "epic-1",
      events: ids.map(makeEvent),
      headId: ids.at(-1) ?? null,
      hasBinaryPayload: false,
    },
    null,
  );
}

function emitEvent(
  session: FakeStreamClient["sessions"][number],
  id: number,
): void {
  session.emit(
    {
      kind: "event",
      epicId: "epic-1",
      event: makeEvent(id),
      hasBinaryPayload: false,
    },
    null,
  );
}

describe("comm-graph subscription while the host holds the stream", () => {
  it("keeps the same subscription through a held reconnect even after rows were applied, and continues on it", () => {
    const { fake, manager } = start();
    const session = fake.sessions[0];
    snapshotThrough(session, [1, 2]);

    session.emitContinuityStatus("reconnecting", "held");

    expect(fake.subscribes).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect(manager.getSnapshot().hosts[0].status).toBe("reconnecting");

    session.emitContinuityStatus("open", "continued");
    emitEvent(session, 3);

    expect(fake.subscribes).toHaveLength(1);
    expect(manager.getSnapshot().hosts[0].status).toBe("live");
    expect(manager.getSnapshot().events.map((event) => event.id)).toEqual([
      1, 2, 3,
    ]);
    manager.dispose();
  });

  it("does not count a held reconnect as a failed dial", () => {
    const { fake, manager } = start();
    const session = fake.sessions[0];

    session.emitContinuityStatus("reconnecting", "held");
    session.emitContinuityStatus("reconnecting", "held");

    expect(manager.getSnapshot().hosts[0].status).toBe("reconnecting");
    manager.dispose();
  });

  it("re-opens from the newest cursor when the hold ends in a plain reconnect", () => {
    const { fake, manager } = start();
    const session = fake.sessions[0];
    snapshotThrough(session, [1, 2]);

    session.emitContinuityStatus("reconnecting", "held");
    emitEvent(session, 3);
    expect(fake.subscribes).toHaveLength(1);

    session.emitContinuityStatus("reconnecting", null);

    expect(session.closed).toBe(true);
    expect(fake.subscribes).toHaveLength(2);
    expect(fake.subscribes[1]?.params).toEqual({
      epicId: "epic-1",
      sinceCursor: 3,
    });
    manager.dispose();
  });
});

describe("cloud relay failover while the host holds the stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Alternate-host failover includes held streams. A continued open cancels
  // the deadline without requiring another snapshot.
  it("fails over to the alternate relay 15 s into a hold, and a continued open cancels the deadline first", () => {
    vi.useFakeTimers();
    const opened: string[] = [];
    const clients = new Map<string, FakeStreamClient>();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      createCommGraphCloudSubscriptionOpener((hostId) => {
        opened.push(hostId);
        const fake = new FakeStreamClient(false);
        clients.set(hostId, fake);
        return { wsStreamClient: fake, close: vi.fn() };
      }),
      () => undefined,
      0,
    );
    try {
      manager.setRelayHostIds(["relay-a", "relay-b"]);
      manager.attach();
      const session = clients.get("relay-a")?.sessions[0];
      if (session === undefined) throw new Error("relay-a was not opened");

      session.emitContinuityStatus("reconnecting", "held");
      vi.advanceTimersByTime(14_999);
      session.emitContinuityStatus("open", "continued");
      vi.advanceTimersByTime(60_000);
      expect(opened).toEqual(["relay-a"]);

      session.emitContinuityStatus("reconnecting", "held");
      vi.advanceTimersByTime(15_000);
      expect(opened).toEqual(["relay-a", "relay-b"]);
    } finally {
      manager.dispose();
    }
  });
});
