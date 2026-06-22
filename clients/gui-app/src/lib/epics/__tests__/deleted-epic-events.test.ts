import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
  publishDeletedEpicNotification,
  subscribeDeletedEpicNotifications,
  type DeletedEpicNotification,
} from "@/lib/epics/deleted-epic-events";

const originalBroadcastChannel = globalThis.BroadcastChannel;

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
