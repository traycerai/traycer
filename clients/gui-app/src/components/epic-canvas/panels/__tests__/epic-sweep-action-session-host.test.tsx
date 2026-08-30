import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSweepAction } from "@/components/epic-canvas/panels/epic-sweep-action";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The Epic status row's sweep affordance sits INSIDE the Epic session, so the
 * rollup it shows and the flow it opens describe the SESSION's host - not the
 * app-wide one, which already answers host B while an A-backed Epic is still
 * rendered through a re-point (PR #1243, round 6: the row read
 * `useTaskWorktreeMetadata()` and mounted the dialog on the app-wide client).
 *
 * The affordance's GATE is the other half, and it is deliberately wider than
 * the rollup: session-host worktrees OR a record naming another machine. The
 * session host's binding registry is the only reliable per-host worktree
 * oracle, so a Task whose agents ran elsewhere has nothing for it to count -
 * and greying the only route to those worktrees out is exactly the bug
 * multi-host Sweep exists to fix.
 *
 * Identity sentinels, not real clients: the assertion is "which object was
 * handed to the query / the flow", which `toBe` answers exactly.
 */
const clients = vi.hoisted(() => ({
  session: { label: "session-client" },
}));
const state = vi.hoisted<{
  worktreeCount: number;
  nodeHostIds: ReadonlySet<string>;
}>(() => ({ worktreeCount: 1, nodeHostIds: new Set() }));
const captured = vi.hoisted<{
  metadataClients: unknown[];
  flowProps: {
    surfaceHostClient: unknown;
    surfaceHostId: string | null;
    occupiedHostIds: ReadonlySet<string>;
  }[];
}>(() => ({ metadataClients: [], flowProps: [] }));

const SESSION_HOST_ID = "host-a";

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => clients.session,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST_ID,
}));

vi.mock("@/hooks/epic/use-epic-node-host-ids", () => ({
  useEpicNodeHostIds: () => state.nodeHostIds,
}));

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadataForClient: (client: unknown, epicIds: string[]) => {
    captured.metadataClients.push(client);
    return {
      worktreesByEpicId: new Map([
        [
          epicIds[0] ?? "",
          // Only what the row reads: `computeTaskMergeRollup` maps
          // `prState` / `mergedHeadShaMatches` / `submodules`, and the
          // affordance counts entries.
          Array.from({ length: state.worktreeCount }, (_unused, index) => ({
            worktreePath: `/tmp/wt-${index}`,
            prState: null,
            mergedHeadShaMatches: null,
            submodules: [],
          })),
        ],
      ]),
      isFetching: false,
      error: null,
    };
  },
}));

vi.mock("@/components/epics/sweep-worktrees-flow", () => ({
  SweepWorktreesFlow: (props: {
    readonly epicIds: ReadonlyArray<string> | null;
    readonly surfaceHostClient: unknown;
    readonly surfaceHostId: string | null;
    readonly occupiedHostIds: ReadonlySet<string>;
  }) => {
    if (props.epicIds !== null) {
      captured.flowProps.push({
        surfaceHostClient: props.surfaceHostClient,
        surfaceHostId: props.surfaceHostId,
        occupiedHostIds: props.occupiedHostIds,
      });
    }
    return null;
  },
}));

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

function renderAction(): void {
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
  });
  render(
    <TooltipProvider>
      <EpicSweepAction epicId={EPIC_ID} tabId={TAB_ID} />
    </TooltipProvider>,
  );
}

describe("EpicSweepAction resolves through the Epic session host", () => {
  beforeEach(() => {
    state.worktreeCount = 1;
    state.nodeHostIds = new Set();
  });
  afterEach(() => {
    cleanup();
    captured.metadataClients = [];
    captured.flowProps = [];
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("reads the worktree rollup and opens the sweep flow on the session's client", () => {
    state.nodeHostIds = new Set([SESSION_HOST_ID]);
    renderAction();

    // The rollup asked at all, and only ever on the session's client.
    expect(captured.metadataClients.length).toBeGreaterThan(0);
    for (const client of captured.metadataClients) {
      expect(client).toBe(clients.session);
    }

    // Opening hands the flow the same client the proof must run on, plus the
    // session's own host id as the picker's marked default.
    fireEvent.click(screen.getByTestId("epic-sweep-action"));
    expect(captured.flowProps.length).toBeGreaterThan(0);
    for (const props of captured.flowProps) {
      expect(props.surfaceHostClient).toBe(clients.session);
      expect(props.surfaceHostId).toBe(SESSION_HOST_ID);
      expect([...props.occupiedHostIds]).toEqual([SESSION_HOST_ID]);
    }
  });

  it("stays live when the session host owns nothing but records name another host", () => {
    state.worktreeCount = 0;
    state.nodeHostIds = new Set([SESSION_HOST_ID, "host-b"]);
    renderAction();

    const button = screen.getByTestId("epic-sweep-action");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Sweep worktrees");
    fireEvent.click(button);
    expect(captured.flowProps.length).toBeGreaterThan(0);
    // The badge hint travels with it, so the picker can mark host-b.
    expect([...captured.flowProps[0].occupiedHostIds].sort()).toEqual([
      SESSION_HOST_ID,
      "host-b",
    ]);
  });

  it("stays faded when nothing anywhere names a host other than the session's", () => {
    state.worktreeCount = 0;
    state.nodeHostIds = new Set([SESSION_HOST_ID]);
    renderAction();

    const button = screen.getByTestId("epic-sweep-action");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("No worktrees to sweep");
    fireEvent.click(button);
    expect(captured.flowProps).toEqual([]);
  });
});
