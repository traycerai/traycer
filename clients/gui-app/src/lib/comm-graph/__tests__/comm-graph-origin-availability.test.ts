import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { isCommGraphOriginAvailable } from "@/lib/comm-graph/comm-graph-origin-availability";

const EVENT = {
  id: 1,
  hostId: "origin-a",
  kind: "a2a_message",
  timestamp: 1_000,
  senderAgentId: "agent-a",
  receiverAgentId: "agent-b",
  responseId: null,
  inReplyTo: null,
  expectReply: true,
  messageText: "still readable",
  noticeReason: null,
  originKind: null,
  originChatId: null,
  originRefId: null,
} satisfies CommGraphEvent;

function entry(status: "available" | "unavailable"): HostDirectoryEntry {
  return {
    hostId: "origin-a",
    label: "Origin A",
    kind: "remote",
    websocketUrl: "wss://origin-a.example/stream",
    version: "1.0.0",
    status,
  };
}

describe("isCommGraphOriginAvailable", () => {
  it("disables only the source jump when the canonical origin host is offline", () => {
    expect(
      isCommGraphOriginAvailable(
        { findById: () => entry("unavailable") },
        EVENT,
      ),
    ).toBe(false);
  });

  it("reports an origin absent from the directory as unavailable", () => {
    expect(isCommGraphOriginAvailable({ findById: () => null }, EVENT)).toBe(
      false,
    );
  });

  it("allows the source jump when the origin is dialable", () => {
    expect(
      isCommGraphOriginAvailable({ findById: () => entry("available") }, EVENT),
    ).toBe(true);
  });
});
