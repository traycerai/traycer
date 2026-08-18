import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeaderTabProjectBadge } from "@/hooks/workspace/use-project-scoped-header-strip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { HeaderTab } from "@/stores/tabs/types";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST,
}));

const TITANOS_TAB = {
  kind: "epic",
  id: "tab-titanos",
  epicId: "epic-titanos",
  name: "Titanos",
} as HeaderTab;

describe("useHeaderTabProjectBadge", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
    useEpicCanvasStore.setState({ tabsById: {} });
  });

  afterEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
    useEpicCanvasStore.setState({ tabsById: {} });
  });

  it("does not loop when All projects paints a color dot", () => {
    useProjectProfilesStore.getState().createProfile(HOST, {
      name: "Titanos",
      color: "orange",
      folderPaths: ["/titanos"],
      primaryPath: "/titanos",
    });
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-titanos": {
          tabId: "tab-titanos",
          epicId: "epic-titanos",
          name: "Titanos",
          projectWorkspace: {
            primaryPath: "/titanos",
            linkedWorkspaces: [
              { hostId: HOST, workspacePath: "/titanos" },
            ],
            worktreePaths: [],
          },
        },
      },
    });

    const hook = renderHook(() => useHeaderTabProjectBadge(TITANOS_TAB));
    const first = hook.result.current;
    expect(first).toEqual({ color: "orange", name: "Titanos" });
    hook.rerender();
    expect(hook.result.current).toBe(first);
  });
});
