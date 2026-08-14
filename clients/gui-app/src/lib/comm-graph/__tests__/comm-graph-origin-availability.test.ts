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

function entry(
  transportDialability: "dialable" | "not-dialable",
): HostDirectoryEntry {
  return {
    hostId: "origin-a",
    label: "Origin A",
    kind: "remote",
    websocketUrl: "wss://origin-a.example/stream",
    version: "1.0.0",
    transportDialability,
  };
}

describe("isCommGraphOriginAvailable", () => {
  it("disables only the source jump when the canonical origin host is offline", () => {
    expect(
      isCommGraphOriginAvailable(
        { findById: () => entry("not-dialable") },
        EVENT,
        false,
      ),
    ).toBe(false);
  });

  it("reports an origin absent from the directory as unavailable", () => {
    expect(
      isCommGraphOriginAvailable({ findById: () => null }, EVENT, false),
    ).toBe(false);
  });

  it("allows the source jump when the origin is dialable", () => {
    expect(
      isCommGraphOriginAvailable(
        { findById: () => entry("dialable") },
        EVENT,
        false,
      ),
    ).toBe(true);
  });

  it("lets a ready live session outrank an offline verdict", () => {
    // The caller-supplied answer is the whole point of the parametric form: a
    // client holding an open session has firsthand proof the origin is up,
    // and the jump must not be disabled by a stale cloud verdict.
    expect(
      isCommGraphOriginAvailable(
        { findById: () => entry("not-dialable") },
        EVENT,
        true,
      ),
    ).toBe(true);
  });
});
