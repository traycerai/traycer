import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import {
  cloudDraftIdentityKey,
  type CloudDraftRowRef,
  cloudDraftKindsSnapshot,
  recordCloudDraftKind,
  resetCloudDraftKindsForTests,
  subscribeCloudDraftKinds,
} from "@/lib/drafts/cloud-draft-kinds";

const IDENTITY_A: CloudChatIdentity = {
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "user-1",
};

const ROW_A: CloudDraftRowRef = {
  ownerHostId: "host-a",
  identity: IDENTITY_A,
};

describe("cloud-draft-kinds", () => {
  beforeEach(() => {
    resetCloudDraftKindsForTests();
  });

  afterEach(() => {
    resetCloudDraftKindsForTests();
  });

  it("makes a recorded kind readable through the snapshot", () => {
    recordCloudDraftKind(ROW_A, "landing");

    expect(cloudDraftKindsSnapshot().get(cloudDraftIdentityKey(ROW_A))).toBe(
      "landing",
    );
  });

  it("keeps the same snapshot reference on a no-op re-record, and produces a new one on a real change", () => {
    // This is what keeps `useSyncExternalStore` consumers from re-rendering on
    // every read: a snapshot getter must return a STABLE reference across
    // repeated calls until the underlying map actually changes, or every
    // subscriber re-renders on a read that discovered nothing new.
    recordCloudDraftKind(ROW_A, "landing");
    const first = cloudDraftKindsSnapshot();

    recordCloudDraftKind(ROW_A, "landing");
    const second = cloudDraftKindsSnapshot();
    expect(second).toBe(first);

    recordCloudDraftKind(ROW_A, "new-chat");
    const third = cloudDraftKindsSnapshot();
    expect(third).not.toBe(first);
    expect(third.get(cloudDraftIdentityKey(ROW_A))).toBe("new-chat");
  });

  it("notifies subscribers on a real change and not on a no-op re-record", () => {
    recordCloudDraftKind(ROW_A, "landing");
    let calls = 0;
    const unsubscribe = subscribeCloudDraftKinds(() => {
      calls += 1;
    });

    recordCloudDraftKind(ROW_A, "landing");
    expect(calls).toBe(0);

    recordCloudDraftKind(ROW_A, "new-chat");
    expect(calls).toBe(1);

    unsubscribe();
    recordCloudDraftKind(ROW_A, "chat-composer");
    expect(calls).toBe(1);
  });

  it("does not collide two rows that share a chatId but differ in ownerUserId", () => {
    const ownedByUser1: CloudDraftRowRef = {
      ownerHostId: "host-a",
      identity: {
        taskId: "task-1",
        chatId: "chat-shared",
        ownerUserId: "user-1",
      },
    };
    const ownedByUser2: CloudDraftRowRef = {
      ownerHostId: "host-a",
      identity: {
        taskId: "task-1",
        chatId: "chat-shared",
        ownerUserId: "user-2",
      },
    };

    recordCloudDraftKind(ownedByUser1, "landing");
    recordCloudDraftKind(ownedByUser2, "chat-composer");

    const snapshot = cloudDraftKindsSnapshot();
    expect(snapshot.get(cloudDraftIdentityKey(ownedByUser1))).toBe("landing");
    expect(snapshot.get(cloudDraftIdentityKey(ownedByUser2))).toBe(
      "chat-composer",
    );
  });

  it("does not collide two rows that share a chatId but differ in taskId", () => {
    const underTask1: CloudDraftRowRef = {
      ownerHostId: "host-a",
      identity: {
        taskId: "task-1",
        chatId: "chat-shared",
        ownerUserId: "user-1",
      },
    };
    const underTask2: CloudDraftRowRef = {
      ownerHostId: "host-a",
      identity: {
        taskId: "task-2",
        chatId: "chat-shared",
        ownerUserId: "user-1",
      },
    };

    recordCloudDraftKind(underTask1, "landing");
    recordCloudDraftKind(underTask2, "interview");

    const snapshot = cloudDraftKindsSnapshot();
    expect(snapshot.get(cloudDraftIdentityKey(underTask1))).toBe("landing");
    expect(snapshot.get(cloudDraftIdentityKey(underTask2))).toBe("interview");
  });
  it("does not collide two hosts' rows that share one identity triple", () => {
    const onHostA: CloudDraftRowRef = {
      ownerHostId: "host-a",
      identity: IDENTITY_A,
    };
    const onHostB: CloudDraftRowRef = {
      ownerHostId: "host-b",
      identity: IDENTITY_A,
    };

    recordCloudDraftKind(onHostA, "landing");
    recordCloudDraftKind(onHostB, "chat-composer");

    const snapshot = cloudDraftKindsSnapshot();
    expect(snapshot.get(cloudDraftIdentityKey(onHostA))).toBe("landing");
    expect(snapshot.get(cloudDraftIdentityKey(onHostB))).toBe("chat-composer");
  });
});
