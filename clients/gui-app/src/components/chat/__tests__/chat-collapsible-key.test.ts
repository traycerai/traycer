import { describe, expect, it } from "vitest";
import {
  deriveA2AReceivedCollapsibleKey,
  deriveA2ASendCollapsibleKey,
  deriveActivityGroupCollapsibleKey,
  deriveActivityGroupRenderId,
  derivePromotedSubagentRenderId,
  deriveSubagentCollapsibleKey,
  serializeChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";

describe("chat collapsible keys", () => {
  it("uses exact render ids in collapsible keys", () => {
    const tileInstanceId = "tile-1";
    const promotedId = derivePromotedSubagentRenderId("subagent-1");
    const activityId = deriveActivityGroupRenderId("command-1");

    expect(deriveSubagentCollapsibleKey(tileInstanceId, promotedId)).toEqual({
      tileInstanceId,
      kind: "subagent",
      id: "promoted:subagent-1",
    });
    expect(deriveSubagentCollapsibleKey(tileInstanceId, "subagent-1")).toEqual({
      tileInstanceId,
      kind: "subagent",
      id: "subagent-1",
    });
    expect(
      deriveActivityGroupCollapsibleKey(tileInstanceId, activityId),
    ).toEqual({
      tileInstanceId,
      kind: "activity-group",
      id: "activity:command-1",
    });
    expect(deriveA2ASendCollapsibleKey(tileInstanceId, "tool-1")).toEqual({
      tileInstanceId,
      kind: "a2a-send",
      id: "tool-1",
    });
    expect(
      deriveA2AReceivedCollapsibleKey(tileInstanceId, "message-1"),
    ).toEqual({
      tileInstanceId,
      kind: "a2a-received",
      id: "message-1",
    });
  });

  it("serializes keys stably with tile scope included", () => {
    expect(
      serializeChatCollapsibleKey({
        tileInstanceId: "tile-1",
        kind: "activity-group",
        id: "activity:command-1",
      }),
    ).toBe('["tile-1","activity-group","activity:command-1"]');
  });
});
