import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSweepAction } from "@/components/epic-canvas/panels/epic-sweep-action";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The Epic status row's sweep affordance sits INSIDE the Epic session, so the
 * rollup it shows and the dialog it opens describe the SESSION's host - not
 * the app-wide one, which already answers host B while an A-backed Epic is
 * still rendered through a re-point (PR #1243, round 6: the row read
 * `useTaskWorktreeMetadata()` and mounted the dialog on the app-wide client).
 *
 * Identity sentinels, not real clients: the assertion is "which object was
 * handed to the query / the dialog", which `toBe` answers exactly.
 */
const clients = vi.hoisted(() => ({
  session: { label: "session-client" },
}));
const captured = vi.hoisted<{
  metadataClients: unknown[];
  dialogClients: unknown[];
}>(() => ({ metadataClients: [], dialogClients: [] }));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => clients.session,
}));

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadataForClient: (client: unknown, epicIds: string[]) => {
    captured.metadataClients.push(client);
    return {
      worktreesByEpicId: new Map([
        [
          epicIds[0] ?? "",
          [
            // Only what the row reads: `computeTaskMergeRollup` maps
            // `prState` / `mergedHeadShaMatches` / `submodules`, and the
            // affordance counts entries.
            {
              worktreePath: "/tmp/wt-1",
              prState: null,
              mergedHeadShaMatches: null,
              submodules: [],
            },
          ],
        ],
      ]),
      isFetching: false,
      error: null,
    };
  },
}));

vi.mock("@/components/epics/sweep-worktrees-dialog", () => ({
  SweepWorktreesDialog: (props: {
    readonly hostClient: unknown;
    readonly epicIds: ReadonlyArray<string> | null;
  }) => {
    if (props.epicIds !== null) captured.dialogClients.push(props.hostClient);
    return null;
  },
}));

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("EpicSweepAction resolves through the Epic session host", () => {
  afterEach(() => {
    cleanup();
    captured.metadataClients = [];
    captured.dialogClients = [];
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("reads the worktree rollup and opens the sweep dialog on the session's client", () => {
    useEpicCanvasStore.setState({
      tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    });
    render(
      <TooltipProvider>
        <EpicSweepAction epicId={EPIC_ID} tabId={TAB_ID} />
      </TooltipProvider>,
    );

    // The rollup asked at all, and only ever on the session's client.
    expect(captured.metadataClients.length).toBeGreaterThan(0);
    for (const client of captured.metadataClients) {
      expect(client).toBe(clients.session);
    }

    // Opening the dialog hands it the same client the proof must run on.
    fireEvent.click(screen.getByTestId("epic-sweep-action"));
    expect(captured.dialogClients.length).toBeGreaterThan(0);
    for (const client of captured.dialogClients) {
      expect(client).toBe(clients.session);
    }
  });
});
