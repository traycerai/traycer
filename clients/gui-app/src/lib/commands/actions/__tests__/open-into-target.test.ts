import { afterEach, describe, expect, it, vi } from "vitest";
import { openTileIntoTargetGroup } from "@/lib/commands/actions/open-into-target";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";

const REF: EpicNodeRef = {
  id: "art-a",
  instanceId: "inst-a",
  type: "spec",
  name: "Spec A",
  hostId: "host-A",
};

const ORIGINAL_OPEN_TILE_IN_GROUP =
  useEpicCanvasStore.getState().openTileInPane;

function installOpenTileInGroupMock() {
  const mock =
    vi.fn<(tabId: string, groupId: string, ref: EpicCanvasTileRef) => void>();
  useEpicCanvasStore.setState({ openTileInPane: mock });
  return mock;
}

afterEach(() => {
  useEpicCanvasStore.setState({
    openTileInPane: ORIGINAL_OPEN_TILE_IN_GROUP,
  });
});

describe("openTileIntoTargetGroup", () => {
  it("routes to canvas openTileInPane with the bound tab + group", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({ tabId: "tab-1", groupId: "group-1", ref: REF });
    expect(mock).toHaveBeenCalledWith("tab-1", "group-1", REF);
  });

  it("no-ops when the tab id is missing", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({ tabId: null, groupId: "group-1", ref: REF });
    expect(mock).not.toHaveBeenCalled();
  });

  it("no-ops when the target group id is missing", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({ tabId: "tab-1", groupId: null, ref: REF });
    expect(mock).not.toHaveBeenCalled();
  });
});
