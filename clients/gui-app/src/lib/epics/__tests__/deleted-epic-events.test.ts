import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
  publishDeletedEpicNotification,
  subscribeDeletedEpicNotifications,
  type DeletedEpicNotification,
} from "@/lib/epics/deleted-epic-events";

const originalBroadcastChannel = globalThis.BroadcastChannel;

// The reader a window that predates deletion scopes runs, pinned field for
// field from the schema before scopes existed. Never derive it from the live
// schema: the point is what an OLD window does with what we send.
const scopelessReaderSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.literal("epic-deleted"),
  version: z.literal(1),
  originId: z.string().min(1),
  sequence: z.number(),
  createdAt: z.number(),
  hostId: z.string().min(1),
  userId: z.string().min(1),
  epicIds: z.array(z.string().min(1)),
  epicTitlesById: z.record(z.string(), z.string()).default({}),
});

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  readonly name: string;
  readonly postedMessages: unknown[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type !== "message") return;
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type !== "message") return;
    this.listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  close(): void {}

  dispatchMessage(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

let currentUnsubscribe: (() => void) | null = null;

describe("deleted epic events", () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockBroadcastChannel.instances = [];
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: MockBroadcastChannel,
    });
  });

  afterEach(() => {
    if (currentUnsubscribe !== null) {
      currentUnsubscribe();
      currentUnsubscribe = null;
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
  });

  it("publishes the same notification id through broadcast and storage", () => {
    publishDeletedEpicNotification({
      hostId: "host-1",
      userId: "user-1",
      epicIds: ["epic-1"],
      hostScopedEpicIds: [],
      epicTitlesById: { "epic-1": "Planning" },
    });

    const broadcastMessage = firstBroadcastChannel().postedMessages[0];
    const storedValue = window.localStorage.getItem(
      DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
    );
    if (broadcastMessage === undefined) {
      throw new Error("Expected broadcast notification");
    }
    if (storedValue === null) {
      throw new Error("Expected storage notification");
    }
    const storageMessage: unknown = JSON.parse(storedValue);
    const broadcastId = readProperty(broadcastMessage, "id");
    const storageId = readProperty(storageMessage, "id");

    expect(typeof broadcastId).toBe("string");
    expect(broadcastId).toBe(storageId);
  });

  it("emits an incoming notification once when both transports deliver it", () => {
    const listener = vi.fn();
    currentUnsubscribe = subscribeDeletedEpicNotifications(listener);
    const notification = {
      id: "duplicate-notification-1",
      type: "epic-deleted",
      version: 1,
      originId: "other-window",
      sequence: 1,
      createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
      hostId: "host-1",
      userId: "user-1",
      epicIds: ["epic-1"],
      hostScopedEpicIds: [],
      epicTitlesById: { "epic-1": "Planning" },
    } satisfies DeletedEpicNotification;

    firstBroadcastChannel().dispatchMessage(notification);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
        newValue: JSON.stringify(notification),
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(notification);
  });

  describe("a deletion with both scopes", () => {
    function publishMixed(): unknown[] {
      publishDeletedEpicNotification({
        hostId: "host-1",
        userId: "user-1",
        epicIds: ["epic-cloud", "epic-local"],
        hostScopedEpicIds: ["epic-local"],
        epicTitlesById: { "epic-cloud": "Cloud", "epic-local": "Local" },
      });
      return MockBroadcastChannel.instances.flatMap(
        (channel) => channel.postedMessages,
      );
    }

    it("never reaches a scopeless window as account-wide", () => {
      // Every id such a window would close on every host.
      const readAsAccountWide = publishMixed().flatMap((message) => {
        const parsed = scopelessReaderSchema.safeParse(message);
        return parsed.success ? parsed.data.epicIds : [];
      });

      expect(readAsAccountWide).toEqual(["epic-cloud"]);
    });

    it("reaches a current window with each id in its own scope", () => {
      const listener = vi.fn<(notification: DeletedEpicNotification) => void>();
      currentUnsubscribe = subscribeDeletedEpicNotifications(listener);
      // Posted on this window's own channel, which never echoes to itself;
      // replayed below as another window's.
      const messages = publishMixed();

      for (const message of messages) {
        firstBroadcastChannel().dispatchMessage({
          ...readObject(message),
          originId: "other-window",
        });
      }

      const received = listener.mock.calls.map(([notification]) => ({
        epicIds: notification.epicIds,
        hostScopedEpicIds: notification.hostScopedEpicIds,
        epicTitlesById: notification.epicTitlesById,
      }));
      expect(received).toEqual([
        {
          epicIds: ["epic-cloud"],
          hostScopedEpicIds: [],
          epicTitlesById: { "epic-cloud": "Cloud" },
        },
        {
          epicIds: ["epic-local"],
          hostScopedEpicIds: ["epic-local"],
          epicTitlesById: { "epic-local": "Local" },
        },
      ]);
    });
  });

  it("sends an account-wide deletion as the one message every window reads", () => {
    publishDeletedEpicNotification({
      hostId: "host-1",
      userId: "user-1",
      epicIds: ["epic-1", "epic-2"],
      hostScopedEpicIds: [],
      epicTitlesById: {},
    });

    const messages = MockBroadcastChannel.instances.flatMap(
      (channel) => channel.postedMessages,
    );
    expect(messages).toHaveLength(1);
    expect(scopelessReaderSchema.parse(messages[0]).epicIds).toEqual([
      "epic-1",
      "epic-2",
    ]);
  });
});

function firstBroadcastChannel(): MockBroadcastChannel {
  const channel = MockBroadcastChannel.instances.slice(0, 1).pop();
  if (channel === undefined) {
    throw new Error("Expected a BroadcastChannel instance");
  }
  return channel;
}

function readProperty(value: unknown, propertyName: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, propertyName)?.value;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an object message");
  }
  return Object.fromEntries(Object.entries(value));
}
