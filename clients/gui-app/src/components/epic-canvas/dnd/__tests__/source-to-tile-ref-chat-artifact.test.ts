import { describe, expect, it } from "vitest";
import {
  CHAT_ARTIFACT_DND_TYPE,
  type EpicCanvasChatArtifactDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  canDropOnHeaderStrip,
  sourceToTileRef,
} from "@/components/epic-canvas/dnd/root-dnd-commits";

const CHAT_ARTIFACT_SOURCE: EpicCanvasChatArtifactDragData = {
  kind: CHAT_ARTIFACT_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "tab-1",
  artifact: {
    id: "artifact-1",
    type: "ticket",
    name: "Fix resolution",
    hostId: "host-1",
  },
};

describe("sourceToTileRef - chat-artifact branch", () => {
  it("maps artifact identity to the expected EpicArtifactRef fields", () => {
    const ref = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    expect(ref).not.toBeNull();
    expect(ref).toMatchObject({
      id: "artifact-1",
      type: "ticket",
      name: "Fix resolution",
      hostId: "host-1",
    });
    expect(ref === null ? "" : ref.instanceId).not.toBe("");
  });

  it("mints a fresh instanceId on every call (C2)", () => {
    const first = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    const second = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const firstInstanceId = first === null ? "a" : first.instanceId;
    const secondInstanceId = second === null ? "b" : second.instanceId;
    expect(firstInstanceId).not.toBe(secondInstanceId);
  });
});

describe("canDropOnHeaderStrip - chat-artifact", () => {
  it("accepts a chat-artifact source so the header tab strip is not a dead zone", () => {
    // Collision already offers chat-artifact the header slot (top priority), so
    // this predicate must accept it - otherwise the header strip previews and
    // commits nothing, unlike the sibling sidebar-node / workspace-file sources.
    expect(canDropOnHeaderStrip(CHAT_ARTIFACT_SOURCE)).toBe(true);
  });

  it("rejects a null source", () => {
    expect(canDropOnHeaderStrip(null)).toBe(false);
  });
});
