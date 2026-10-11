import { describe, expect, it, vi } from "vitest";
import type {
  HostNotificationEntryV22,
  HostNotificationsEntityRef,
  HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostNotificationsFeedFrame } from "@/stores/notifications/host-notifications-store";
import { HostEntityReadDriver } from "@/lib/notifications/host-entity-read-driver";

const SUMMARY: HostNotificationsSummary = { unreadCount: 0, attentionCount: 0 };
const CHAT_ONE: HostNotificationsEntityRef = {
  epicId: "epic-1",
  chatId: "chat-1",
};
const CHAT_TWO: HostNotificationsEntityRef = {
  epicId: "epic-1",
  chatId: "chat-2",
};
const OTHER_EPIC: HostNotificationsEntityRef = {
  epicId: "epic-2",
  chatId: "chat-1",
};

function entry(epicId: string | null, chatId: string | null) {
  const value: HostNotificationEntryV22 = {
    id: `${epicId}-${chatId}`,
    updatedAt: 1,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: "source",
    severity: "done",
    outcome: "completed",
    epicId,
    chatId,
    payload: { outcome: "completed" },
  };
  return value;
}

function upserted(
  epicId: string | null,
  chatId: string | null,
): HostNotificationsFeedFrame {
  return {
    kind: "upserted",
    hasBinaryPayload: false,
    entry: entry(epicId, chatId),
    removedIds: [],
    summary: SUMMARY,
  };
}

function readStateChanged(
  entityRefs: HostNotificationsEntityRef[],
  readAt: number | null,
): HostNotificationsFeedFrame {
  return {
    kind: "readStateChanged",
    hasBinaryPayload: false,
    ids: [],
    entityRefs,
    readAt,
    resolvedAt: null,
    removedIds: [],
    summary: SUMMARY,
  };
}

const SNAPSHOT: HostNotificationsFeedFrame = {
  kind: "snapshot",
  hasBinaryPayload: false,
  attention: { entries: [], nextCursor: null },
  recent: { entries: [], nextCursor: null },
  summary: SUMMARY,
};

/** A markRead whose every call stays pending until the test settles it. */
function markReadHarness() {
  const calls: Array<{
    readonly entity: HostNotificationsEntityRef;
    readonly resolve: () => void;
    readonly reject: () => void;
  }> = [];
  const markRead = vi.fn((entity: HostNotificationsEntityRef) => {
    return new Promise<void>((resolve, reject) => {
      calls.push({
        entity,
        resolve,
        reject: () => {
          reject(new Error("mark read failed"));
        },
      });
    });
  });
  return { calls, markRead };
}

async function flush(): Promise<void> {
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
}

describe("HostEntityReadDriver", () => {
  it("sends one read for repeated requests of a generation, and skips it once accepted", async () => {
    const driver = new HostEntityReadDriver();
    const { calls, markRead } = markReadHarness();

    driver.request(CHAT_ONE, markRead);
    driver.request(CHAT_ONE, markRead);
    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await flush();
    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(1);
  });

  it("queues exactly one successor for newer generations raised during a pending read", async () => {
    const driver = new HostEntityReadDriver();
    const { calls, markRead } = markReadHarness();
    driver.request(CHAT_ONE, markRead);

    driver.observe(upserted("epic-1", "chat-1"));
    driver.request(CHAT_ONE, markRead);
    driver.observe(upserted("epic-1", "chat-1"));
    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(2);

    calls[1].resolve();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("makes a snapshot newer for every known target", async () => {
    const driver = new HostEntityReadDriver();
    const { calls, markRead } = markReadHarness();
    driver.request(CHAT_ONE, markRead);
    driver.request(CHAT_TWO, markRead);
    calls[0].resolve();
    calls[1].resolve();
    await flush();

    driver.observe(SNAPSHOT);
    driver.request(CHAT_ONE, markRead);
    driver.request(CHAT_TWO, markRead);

    expect(calls).toHaveLength(4);
  });

  it.each([
    {
      frame: "an upsert for the chat",
      arrange: upserted("epic-1", "chat-1"),
      resent: true,
    },
    {
      frame: "an upsert for the epic alone",
      arrange: upserted("epic-1", null),
      resent: true,
    },
    {
      frame: "an upsert for another chat",
      arrange: upserted("epic-1", "chat-2"),
      resent: false,
    },
    {
      frame: "an upsert for another epic",
      arrange: upserted("epic-2", "chat-1"),
      resent: false,
    },
    {
      frame: "an upsert with no epic",
      arrange: upserted(null, null),
      resent: false,
    },
    {
      frame: "an unread readStateChanged for the chat",
      arrange: readStateChanged([CHAT_ONE], null),
      resent: true,
    },
    {
      frame: "a read readStateChanged for the chat",
      arrange: readStateChanged([CHAT_ONE], 20),
      resent: false,
    },
    {
      frame: "an unread readStateChanged for another epic",
      arrange: readStateChanged([OTHER_EPIC], null),
      resent: false,
    },
  ])(
    "resends a settled target after $frame only when it addresses it",
    async (row) => {
      const driver = new HostEntityReadDriver();
      const { calls, markRead } = markReadHarness();
      driver.request(CHAT_ONE, markRead);
      calls[0].resolve();
      await flush();

      driver.observe(row.arrange);
      driver.request(CHAT_ONE, markRead);

      expect(calls).toHaveLength(row.resent ? 2 : 1);
    },
  );

  it("frees a failed read for the next visit to retry the same generation", async () => {
    const driver = new HostEntityReadDriver();
    const { calls, markRead } = markReadHarness();
    driver.request(CHAT_ONE, markRead);

    calls[0].reject();
    await flush();
    expect(calls).toHaveLength(1);

    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(2);
  });

  it("fences a queued successor and forgets every target on reset", async () => {
    const driver = new HostEntityReadDriver();
    const { calls, markRead } = markReadHarness();
    driver.request(CHAT_ONE, markRead);
    driver.observe(upserted("epic-1", "chat-1"));
    driver.request(CHAT_ONE, markRead);

    driver.reset();
    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(1);

    // The target is unknown again, and the old read's acceptance did not
    // carry over: a first request is sent.
    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await flush();
    driver.request(CHAT_ONE, markRead);
    expect(calls).toHaveLength(2);
  });
});
