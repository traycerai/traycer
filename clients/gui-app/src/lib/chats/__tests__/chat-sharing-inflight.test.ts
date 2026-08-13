import { afterEach, describe, expect, it } from "vitest";
import {
  beginChatSharingInFlight,
  endChatSharingInFlight,
  isChatSharingInFlight,
  resetChatSharingInFlightForTests,
} from "@/lib/chats/chat-sharing-inflight";

afterEach(() => {
  resetChatSharingInFlightForTests();
});

describe("chat sharing in-flight gate", () => {
  it("allows one write per task and viewer, and refuses a second of either surface", () => {
    expect(beginChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    // A later per-chat flip must not queue behind a master toggle (or vice
    // versa) — the coordinator would let both run on different queues.
    expect(beginChatSharingInFlight("task-1", "viewer-1")).toBe(false);
    endChatSharingInFlight("task-1", "viewer-1");
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(false);
    expect(beginChatSharingInFlight("task-1", "viewer-1")).toBe(true);
  });

  it("does not share a gate across tasks or viewers", () => {
    expect(beginChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    expect(beginChatSharingInFlight("task-2", "viewer-1")).toBe(true);
    expect(beginChatSharingInFlight("task-1", "viewer-2")).toBe(true);
  });

  it("refuses a write with no task id", () => {
    expect(beginChatSharingInFlight("", "viewer-1")).toBe(false);
  });
});
