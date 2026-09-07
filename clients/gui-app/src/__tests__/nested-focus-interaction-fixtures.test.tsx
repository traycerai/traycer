/**
 * Nested-focus-opener harness: real canvas store plus real router. Lint and mocked-boundary tests can pass while the route write never happens.
 */
import type { ReactElement } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderNestedFocusFixture } from "@/__tests__/nested-focus-router-harness";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileRow } from "@/components/epic-canvas/git-diff/file-row";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { ArtifactChildIndex } from "@/components/epic-canvas/renderers/artifact-child-index";
import { useTraycerReferenceOpenHandler } from "@/markdown/components/use-traycer-reference-open";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { GitChangedFileV11 } from "@traycer/protocol/host";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

const epicSelectors = vi.hoisted<{
  childIdsByParent: Record<string, ReadonlyArray<string>>;
  nodesById: Record<
    string,
    { readonly type: string; readonly title: string; readonly status: null }
  >;
  sameEpicNodeRef: EpicNodeRef | null;
}>(() => ({
  childIdsByParent: {},
  nodesById: {},
  sameEpicNodeRef: null,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    listeners: undefined,
    attributes: {},
    isDragging: false,
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useChildIdsOf: (parentId: string) =>
    epicSelectors.childIdsByParent[parentId] ?? [],
  useTreeNodeById: (nodeId: string) => epicSelectors.nodesById[nodeId] ?? null,
  epicNodeRefForNodeId: () => epicSelectors.sameEpicNodeRef,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

const referenceOpenEpicHandle = vi.hoisted<{
  handle: {
    readonly epicId: string;
    readonly store: { readonly getState: () => object };
  } | null;
}>(() => ({
  handle: null,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => referenceOpenEpicHandle.handle,
}));

function changedFile(path: string): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 3,
    deletions: 1,
    sizeBytes: 100,
    stagedOid: null,
    worktreeOid: null,
    gitlink: null,
  };
}

function TerminalFocusButton(props: { readonly viewTabId: string }) {
  const focus = useFocusEpicTerminalSession(props.viewTabId);
  return (
    <button type="button" onClick={() => focus("term-1", "/work/repo", null)}>
      Focus terminal
    </button>
  );
}

function ReferenceChip(props: {
  readonly epicId: string;
  readonly nodeId: string;
}) {
  const { onOpen } = useTraycerReferenceOpenHandler({
    epicId: props.epicId,
    nodeId: props.nodeId,
    requiresNode: true,
  });
  return (
    <button type="button" onClick={(event) => onOpen?.(event)}>
      Reference chip
    </button>
  );
}

interface OpenerFixtureRow {
  readonly name: string;
  readonly build: (epicId: string, tabId: string) => ReactElement;
  readonly interact: () => Promise<void>;
  readonly assertFocusWritten: (search: {
    readonly focusPaneId: string | undefined;
    readonly focusTileInstanceId: string | undefined;
  }) => void;
}

const ROWS: ReadonlyArray<OpenerFixtureRow> = [
  {
    name: "git file row preview",
    build: (epicId, tabId) => (
      <TooltipProvider>
        <FileRow
          epicId={epicId}
          viewTabId={tabId}
          hostId="host-1"
          runningDir="/repo"
          repositoryContext={null}
          file={changedFile("src/app.ts")}
          active={false}
          pathRanges={[]}
          nested={false}
        />
      </TooltipProvider>
    ),
    interact: async () => {
      const row = await screen.findByRole("button", {
        name: "Modified app.ts in src",
      });
      fireEvent.click(row);
    },
    assertFocusWritten: (search) => {
      expect(search.focusPaneId).toEqual(expect.any(String));
      expect(search.focusTileInstanceId).toEqual(expect.any(String));
    },
  },
  {
    name: "sidebar terminal open (via useFocusEpicTerminalSession)",
    build: (_epicId, tabId) => (
      <TabHostProvider hostId="host-1">
        <TerminalFocusButton viewTabId={tabId} />
      </TabHostProvider>
    ),
    interact: async () => {
      const button = await screen.findByRole("button", {
        name: "Focus terminal",
      });
      fireEvent.click(button);
    },
    assertFocusWritten: (search) => {
      expect(search.focusPaneId).toEqual(expect.any(String));
      expect(search.focusTileInstanceId).toEqual(expect.any(String));
    },
  },
  {
    name: "artifact child-index row",
    build: (epicId, tabId) => {
      epicSelectors.childIdsByParent = { "parent-1": ["child-story"] };
      epicSelectors.nodesById = {
        "child-story": { type: "story", title: "Child Story", status: null },
      };
      return (
        <ArtifactChildIndex
          epicId={epicId}
          parentId="parent-1"
          viewTabId={tabId}
          hostId="host-1"
        />
      );
    },
    interact: async () => {
      const row = await screen.findByRole("button", { name: "Child Story" });
      fireEvent.click(row);
    },
    assertFocusWritten: (search) => {
      expect(search.focusPaneId).toEqual(expect.any(String));
      expect(search.focusTileInstanceId).toEqual(expect.any(String));
    },
  },
  {
    name: "markdown reference chip (same-epic node)",
    build: (epicId, _tabId) => {
      referenceOpenEpicHandle.handle = {
        epicId,
        store: { getState: () => ({}) },
      };
      epicSelectors.sameEpicNodeRef = {
        id: "spec-1",
        instanceId: "spec-instance-1",
        type: "spec",
        name: "Spec One",
        hostId: "host-1",
      };
      return <ReferenceChip epicId={epicId} nodeId="spec-1" />;
    },
    interact: async () => {
      const button = await screen.findByRole("button", {
        name: "Reference chip",
      });
      fireEvent.click(button);
    },
    assertFocusWritten: (search) => {
      expect(search.focusPaneId).toEqual(expect.any(String));
      expect(search.focusTileInstanceId).toEqual(expect.any(String));
    },
  },
];

/** Seed the selection-authority store, not a hook mock: chips resolve through useCanvasHostId -> useEffectiveHostId. */
function setEffectiveHostId(hostId: string | null): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

function resetCanvas(): void {
  window.localStorage.clear();
  setEffectiveHostId("host-1");
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  epicSelectors.childIdsByParent = {};
  epicSelectors.nodesById = {};
  epicSelectors.sameEpicNodeRef = null;
  referenceOpenEpicHandle.handle = null;
}

describe("nested focus interaction fixtures", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
  });

  afterEach(() => {
    cleanup();
    useSelectionAuthorityStore.getState().reset();
  });

  it.each(ROWS)(
    "commits a nested route focus target for: $name",
    async (row) => {
      const epicId = "epic-1";
      const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Epic 1");

      const { router } = renderNestedFocusFixture(
        epicId,
        tabId,
        row.build(epicId, tabId),
      );

      await row.interact();

      await waitFor(() => {
        row.assertFocusWritten({
          focusPaneId: router.state.location.search.focusPaneId,
          focusTileInstanceId: router.state.location.search.focusTileInstanceId,
        });
      });
    },
  );
});
