import { describe, expect, it } from "vitest";
import {
  ACTIVE_AGENT_DND_TYPE,
  readEpicCanvasDragSourceData,
  type EpicCanvasActiveAgentDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  canDropOnHeaderStrip,
  sourceToTileRef,
} from "@/components/epic-canvas/dnd/root-dnd-commits";

const ACTIVE_AGENT_SOURCE: EpicCanvasActiveAgentDragData = {
  kind: ACTIVE_AGENT_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "tab-containing-agent-list",
  agent: {
    id: "agent-1",
    type: "chat",
    name: "Bound agent",
    hostId: "host-bound-to-agent",
  },
};

describe("active-agent canvas drag source", () => {
  it("round-trips host-bound GUI and TUI agent identities", () => {
    expect(readEpicCanvasDragSourceData(ACTIVE_AGENT_SOURCE)).toEqual(
      ACTIVE_AGENT_SOURCE,
    );
    expect(
      readEpicCanvasDragSourceData({
        ...ACTIVE_AGENT_SOURCE,
        agent: {
          ...ACTIVE_AGENT_SOURCE.agent,
          type: "terminal-agent",
        },
      }),
    ).toEqual({
      ...ACTIVE_AGENT_SOURCE,
      agent: {
        ...ACTIVE_AGENT_SOURCE.agent,
        type: "terminal-agent",
      },
    });
  });

  it("rejects an unknown agent kind or a missing host binding", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...ACTIVE_AGENT_SOURCE,
        agent: { ...ACTIVE_AGENT_SOURCE.agent, type: "ticket" },
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        ...ACTIVE_AGENT_SOURCE,
        agent: { ...ACTIVE_AGENT_SOURCE.agent, hostId: "" },
      }),
    ).toBeNull();
  });

  it("opens on the bound host with a fresh instance per conversion", () => {
    const first = sourceToTileRef(ACTIVE_AGENT_SOURCE);
    const second = sourceToTileRef(ACTIVE_AGENT_SOURCE);

    expect(first).toMatchObject({
      id: "agent-1",
      type: "chat",
      name: "Bound agent",
      hostId: "host-bound-to-agent",
    });
    expect(second).toMatchObject({
      id: "agent-1",
      hostId: "host-bound-to-agent",
    });
    expect(first?.instanceId).not.toBe(second?.instanceId);
  });

  it("can open in a new header tab", () => {
    expect(canDropOnHeaderStrip(ACTIVE_AGENT_SOURCE)).toBe(true);
  });
});
